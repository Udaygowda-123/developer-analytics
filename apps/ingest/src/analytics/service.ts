import { Types } from 'mongoose';
import { DailyRollup, Event } from '@pulse/shared/models';
import {
  enumerateBuckets,
  percentChange,
  previousRange,
  resolveRange,
  shouldUseRollups,
  utcMidnight,
  type AnalyticsQuery,
  type AnalyticsResponse,
  type LabelledCount,
  type TimeSeriesPoint,
} from '@pulse/shared';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { getRedis } from '../redis.js';
import {
  buildAnalyticsPipeline,
  buildRollupPipeline,
  buildTotalsPipeline,
  type FacetResult,
} from './pipeline.js';

const log = createLogger('analytics');

interface RollupFacetResult {
  series: Array<{ _id: Date; pageviews: number; uniqueVisitors: number }>;
  totals: Array<{ _id: null; pageviews: number; uniqueVisitors: number }>;
  topPaths: Array<{ _id: string; count: number }>;
  topReferrers: Array<{ _id: string; count: number }>;
  countries: Array<{ _id: string; count: number }>;
  browsers: Array<{ _id: string; count: number }>;
  devices: Array<{ desktop: number; mobile: number; tablet: number; unknown: number }>;
}

function toLabelled(rows: Array<{ _id: string | null; count: number }>): LabelledCount[] {
  return rows.map((r) => ({ label: r._id ?? 'unknown', count: r.count }));
}

/**
 * Zero-fills the series.
 *
 * The aggregation only emits buckets that contain events. Handing that straight
 * to a chart draws a line that jumps across empty periods as if they never
 * existed, which makes a quiet night look like a flat line rather than a dip.
 * We generate every expected bucket and join.
 */
function zeroFillSeries(
  rows: Array<{ _id: Date; pageviews: number; uniqueVisitors: number }>,
  buckets: Date[],
): TimeSeriesPoint[] {
  const byTime = new Map<number, { pageviews: number; uniqueVisitors: number }>();
  for (const row of rows) {
    byTime.set(new Date(row._id).getTime(), {
      pageviews: row.pageviews,
      uniqueVisitors: row.uniqueVisitors,
    });
  }
  return buckets.map((bucket) => {
    const hit = byTime.get(bucket.getTime());
    return {
      bucket: bucket.toISOString(),
      pageviews: hit?.pageviews ?? 0,
      uniqueVisitors: hit?.uniqueVisitors ?? 0,
    };
  });
}

export function analyticsCacheKey(query: AnalyticsQuery): string {
  // Keyed by project + range + timezone (+ path filter), exactly the inputs
  // that change the response. Two users in different zones must not share an
  // entry, which is why the timezone is part of the key and not an afterthought.
  return `analytics:v1:${query.projectId}:${query.range}:${query.timezone}:${query.path ?? '*'}`;
}

export interface GetAnalyticsOptions {
  /** Injectable clock so tests are deterministic. */
  now?: Date;
  /** Skip the Redis read (still writes). Used by the cache-warming path. */
  skipCache?: boolean;
}

/**
 * Computes (or serves from cache) every metric the dashboard needs.
 *
 * Source selection is transparent to the caller: ranges over 30 days read
 * pre-aggregated `DailyRollup` documents, everything else reads raw `Event`s.
 * The response shape is identical either way; only `source` differs, and that
 * is reported for observability rather than for the UI to branch on.
 */
export async function getAnalytics(
  query: AnalyticsQuery,
  options: GetAnalyticsOptions = {},
): Promise<AnalyticsResponse> {
  const cfg = getConfig();
  const cacheKey = analyticsCacheKey(query);

  if (!options.skipCache) {
    try {
      const cached = await getRedis().get(cacheKey);
      if (cached) {
        log.debug('analytics cache hit', { projectId: query.projectId, range: query.range });
        return JSON.parse(cached) as AnalyticsResponse;
      }
    } catch (err) {
      // A cache miss and a cache outage should look the same to the caller.
      log.warn('analytics cache read failed', { message: String(err) });
    }
  }

  const resolved = resolveRange(query.range, query.timezone, options.now);
  const projectId = new Types.ObjectId(query.projectId);
  const useRollups = shouldUseRollups(query.range);

  const response = useRollups
    ? await computeFromRollups(query, projectId, resolved)
    : await computeFromEvents(query, projectId, resolved);

  try {
    await getRedis().set(cacheKey, JSON.stringify(response), 'EX', cfg.DASHBOARD_CACHE_TTL_SECONDS);
  } catch (err) {
    log.warn('analytics cache write failed', { message: String(err) });
  }

  return response;
}

async function computeFromEvents(
  query: AnalyticsQuery,
  projectId: Types.ObjectId,
  resolved: ReturnType<typeof resolveRange>,
): Promise<AnalyticsResponse> {
  const prev = previousRange(resolved);

  /*
   * These two aggregations are genuinely independent: they read disjoint time
   * ranges (`[from, to)` and the equal-length window before it), so neither
   * can be expressed as a facet of the other and neither depends on the
   * other's result. Running them with Promise.all overlaps two network round
   * trips into one wall-clock wait.
   *
   * This is the *only* place in the dashboard read path that issues more than
   * one query, and it is why the comparison numbers exist at all.
   */
  const [facetRows, prevRows] = await Promise.all([
    Event.aggregate<FacetResult>(
      buildAnalyticsPipeline({
        projectId,
        from: resolved.from,
        to: resolved.to,
        granularity: resolved.granularity,
        timezone: query.timezone,
        ...(query.path ? { path: query.path } : {}),
      }),
    ).option({ maxTimeMS: 15_000 }),
    Event.aggregate<{ pageviews: number; uniqueVisitors: number }>(
      buildTotalsPipeline({
        projectId,
        from: prev.from,
        to: prev.to,
        ...(query.path ? { path: query.path } : {}),
      }),
    ).option({ maxTimeMS: 15_000 }),
  ]);

  const facet = facetRows[0] ?? {
    series: [],
    totals: [],
    topPaths: [],
    topReferrers: [],
    countries: [],
    devices: [],
    browsers: [],
  };

  const totals = facet.totals[0] ?? { pageviews: 0, uniqueVisitors: 0 };
  const previous = prevRows[0] ?? { pageviews: 0, uniqueVisitors: 0 };

  return {
    range: query.range,
    timezone: query.timezone,
    source: 'events',
    from: resolved.from.toISOString(),
    to: resolved.to.toISOString(),
    summary: {
      pageviews: totals.pageviews,
      uniqueVisitors: totals.uniqueVisitors,
      pageviewsChangePct: percentChange(totals.pageviews, previous.pageviews),
      uniqueVisitorsChangePct: percentChange(totals.uniqueVisitors, previous.uniqueVisitors),
    },
    series: zeroFillSeries(facet.series, enumerateBuckets(resolved)),
    topPaths: toLabelled(facet.topPaths),
    topReferrers: toLabelled(facet.topReferrers),
    countries: toLabelled(facet.countries),
    devices: toLabelled(facet.devices),
    browsers: toLabelled(facet.browsers),
  };
}

async function computeFromRollups(
  query: AnalyticsQuery,
  projectId: Types.ObjectId,
  resolved: ReturnType<typeof resolveRange>,
): Promise<AnalyticsResponse> {
  // Rollups are keyed on UTC midnight, so the query window snaps to UTC days.
  const from = utcMidnight(resolved.from);
  const to = utcMidnight(resolved.to);
  const prevRaw = previousRange(resolved);
  const prevFrom = utcMidnight(prevRaw.from);
  const prevTo = utcMidnight(prevRaw.to);

  // Same independence argument as the raw-event path: disjoint date ranges.
  const [rows, prevRows] = await Promise.all([
    DailyRollup.aggregate<RollupFacetResult>(buildRollupPipeline({ projectId, from, to })).option({
      maxTimeMS: 15_000,
    }),
    DailyRollup.aggregate<{ pageviews: number; uniqueVisitors: number }>([
      { $match: { projectId, date: { $gte: prevFrom, $lt: prevTo } } },
      {
        $group: {
          _id: null,
          pageviews: { $sum: '$pageviews' },
          uniqueVisitors: { $sum: '$uniqueVisitors' },
        },
      },
    ]).option({ maxTimeMS: 15_000 }),
  ]);

  const facet = rows[0];
  const totals = facet?.totals[0] ?? { pageviews: 0, uniqueVisitors: 0 };
  const previous = prevRows[0] ?? { pageviews: 0, uniqueVisitors: 0 };
  const deviceTotals = facet?.devices[0] ?? { desktop: 0, mobile: 0, tablet: 0, unknown: 0 };

  // Rollup buckets are UTC days; enumerate them the same way so the series is
  // still zero-filled and the chart still has one point per day.
  const buckets: Date[] = [];
  for (let d = from.getTime(); d < to.getTime(); d += 86_400_000) {
    buckets.push(new Date(d));
  }

  return {
    range: query.range,
    timezone: query.timezone,
    source: 'rollups',
    from: from.toISOString(),
    to: to.toISOString(),
    summary: {
      pageviews: totals.pageviews,
      uniqueVisitors: totals.uniqueVisitors,
      pageviewsChangePct: percentChange(totals.pageviews, previous.pageviews),
      uniqueVisitorsChangePct: percentChange(totals.uniqueVisitors, previous.uniqueVisitors),
    },
    series: zeroFillSeries(facet?.series ?? [], buckets),
    topPaths: toLabelled(facet?.topPaths ?? []),
    topReferrers: toLabelled(facet?.topReferrers ?? []),
    countries: toLabelled(facet?.countries ?? []),
    devices: [
      { label: 'desktop', count: deviceTotals.desktop },
      { label: 'mobile', count: deviceTotals.mobile },
      { label: 'tablet', count: deviceTotals.tablet },
      { label: 'unknown', count: deviceTotals.unknown },
    ]
      .filter((d) => d.count > 0)
      .sort((a, b) => b.count - a.count),
    browsers: toLabelled(facet?.browsers ?? []),
  };
}

/** Invalidate every cached range for a project, e.g. after a data deletion. */
export async function invalidateAnalyticsCache(projectId: string): Promise<void> {
  const redis = getRedis();
  const pattern = `analytics:v1:${projectId}:*`;
  // SCAN, never KEYS: KEYS blocks the whole Redis instance for the duration of
  // the scan, which on a shared cache is a self-inflicted outage.
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}
