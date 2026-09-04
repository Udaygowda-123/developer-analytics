import { Types, type AnyBulkWriteOperation } from 'mongoose';
import { DailyRollup, Event, type DailyRollupDoc } from '@pulse/shared/models';
import { utcMidnight } from '@pulse/shared';
import { createLogger } from '../logger.js';

const log = createLogger('jobs:rollup');

export interface RollupStats {
  day: string;
  projects: number;
  eventsProcessed: number;
  documentsUpserted: number;
  durationMs: number;
}

const TOP_N = 20;

/**
 * Nightly aggregation of one day's raw events into `DailyRollup`.
 *
 * IDEMPOTENT BY CONSTRUCTION. Everything here is recomputed from scratch and
 * written with `upsert` keyed on the unique `{ projectId, date }` index, so
 * re-running a day overwrites its summary rather than adding to it. There is no
 * `$inc` anywhere in this job — an incremental design would double-count on
 * every retry, and retries are guaranteed (a cron that fires during a deploy,
 * a manual backfill, a job that crashed halfway through).
 *
 * That matters because the alternative failure is silent: nobody notices their
 * 90-day chart is 2x too high until they compare it against something else.
 */
export async function rollupDay(day: Date, options: { topN?: number } = {}): Promise<RollupStats> {
  const startedAt = Date.now();
  const dayStart = utcMidnight(day);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const topN = options.topN ?? TOP_N;

  log.info('rollup starting', { day: dayStart.toISOString() });

  /*
   * One aggregation for the whole day across every project.
   *
   * Grouping by (projectId, sessionId) first gives us per-visitor totals, which
   * the second stage folds into per-project totals — the same two-stage trick
   * the dashboard uses, and for the same reason: it counts distinct visitors
   * without materialising a set of every session id.
   *
   * The top-N lists need the raw rows, so they are computed by a `$facet`
   * running in parallel over the same match.
   */
  const rows = await Event.aggregate<{
    _id: Types.ObjectId;
    pageviews: number;
    uniqueVisitors: number;
    eventsProcessed: number;
    topPaths: Array<{ label: string; count: number }>;
    topReferrers: Array<{ label: string; count: number }>;
    countries: Array<{ label: string; count: number }>;
    browsers: Array<{ label: string; count: number }>;
    devices: { desktop: number; mobile: number; tablet: number; unknown: number };
  }>([
    { $match: { timestamp: { $gte: dayStart, $lt: dayEnd } } },
    {
      $project: {
        _id: 0,
        projectId: 1,
        type: 1,
        path: 1,
        referrer: 1,
        country: 1,
        device: 1,
        browser: 1,
        sessionId: 1,
      },
    },
    {
      $group: {
        _id: '$projectId',
        eventsProcessed: { $sum: 1 },
        pageviews: { $sum: { $cond: [{ $eq: ['$type', 'pageview'] }, 1, 0] } },
        sessions: { $addToSet: '$sessionId' },
        // Collect the dimension values, then tally them below. Held as arrays
        // rather than nested $group stages because we need all of them keyed by
        // the same project in one pass.
        paths: { $push: { $cond: [{ $eq: ['$type', 'pageview'] }, '$path', '$$REMOVE'] } },
        referrers: { $push: { $ifNull: ['$referrer', '$$REMOVE'] } },
        countryList: { $push: { $ifNull: ['$country', '$$REMOVE'] } },
        browserList: { $push: { $ifNull: ['$browser', '$$REMOVE'] } },
        deviceList: { $push: { $ifNull: ['$device', 'unknown'] } },
      },
    },
    {
      $project: {
        eventsProcessed: 1,
        pageviews: 1,
        uniqueVisitors: { $size: '$sessions' },
        topPaths: tallyTopN('$paths', topN),
        topReferrers: tallyTopN('$referrers', topN),
        countries: tallyTopN('$countryList', topN),
        browsers: tallyTopN('$browserList', topN),
        devices: {
          desktop: countMatching('$deviceList', 'desktop'),
          mobile: countMatching('$deviceList', 'mobile'),
          tablet: countMatching('$deviceList', 'tablet'),
          unknown: countMatching('$deviceList', 'unknown'),
        },
      },
    },
  ])
    .allowDiskUse(true)
    .option({ maxTimeMS: 10 * 60_000 });

  if (rows.length === 0) {
    const stats: RollupStats = {
      day: dayStart.toISOString().slice(0, 10),
      projects: 0,
      eventsProcessed: 0,
      documentsUpserted: 0,
      durationMs: Date.now() - startedAt,
    };
    log.info('rollup complete (no events)', stats);
    return stats;
  }

  const generatedAt = new Date();
  // Mongoose types `$set` on a subdocument array as a hydrated DocumentArray,
  // which a plain object literal cannot satisfy; the driver accepts the literal
  // and casts it. `AnyBulkWriteOperation` is the driver-level type this maps to.
  const operations = rows.map((row): AnyBulkWriteOperation<DailyRollupDoc> => ({
    updateOne: {
      filter: { projectId: row._id, date: dayStart },
      // `$set`, never `$inc` — this is what makes the job re-runnable.
      update: {
        $set: {
          pageviews: row.pageviews,
          uniqueVisitors: row.uniqueVisitors,
          topPaths: row.topPaths,
          topReferrers: row.topReferrers,
          countries: row.countries,
          browsers: row.browsers,
          devices: row.devices,
          eventsProcessed: row.eventsProcessed,
          generatedAt,
        },
      } as never,
      upsert: true,
    },
  }));

  // `ordered: false` so one project's failure does not abandon the rest.
  const result = await DailyRollup.bulkWrite(operations, { ordered: false });

  const stats: RollupStats = {
    day: dayStart.toISOString().slice(0, 10),
    projects: rows.length,
    eventsProcessed: rows.reduce((sum, r) => sum + r.eventsProcessed, 0),
    documentsUpserted: (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0),
    durationMs: Date.now() - startedAt,
  };

  log.info('rollup complete', stats);
  return stats;
}

/**
 * `$sortArray` + `$slice` over a `$group`-inside-`$project` — the aggregation
 * way to say "count occurrences, keep the top N". Requires MongoDB 5.2+.
 */
function tallyTopN(arrayExpr: string, topN: number): Record<string, unknown> {
  return {
    $slice: [
      {
        $sortArray: {
          input: {
            $map: {
              input: { $setUnion: [arrayExpr, []] },
              as: 'label',
              in: {
                label: '$$label',
                count: {
                  $size: {
                    $filter: {
                      input: arrayExpr,
                      as: 'v',
                      cond: { $eq: ['$$v', '$$label'] },
                    },
                  },
                },
              },
            },
          },
          sortBy: { count: -1, label: 1 },
        },
      },
      topN,
    ],
  };
}

function countMatching(arrayExpr: string, value: string): Record<string, unknown> {
  return {
    $size: { $filter: { input: arrayExpr, as: 'v', cond: { $eq: ['$$v', value] } } },
  };
}

/** Rolls up yesterday — what the 02:00 UTC cron calls. */
export async function rollupYesterday(now: Date = new Date()): Promise<RollupStats> {
  const yesterday = new Date(utcMidnight(now).getTime() - 86_400_000);
  return rollupDay(yesterday);
}

/** Backfill helper for the seed script and for recovering from a missed night. */
export async function rollupRange(from: Date, to: Date): Promise<RollupStats[]> {
  const stats: RollupStats[] = [];
  for (let d = utcMidnight(from).getTime(); d <= utcMidnight(to).getTime(); d += 86_400_000) {
    stats.push(await rollupDay(new Date(d)));
  }
  return stats;
}
