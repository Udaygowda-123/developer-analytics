import { Types, type PipelineStage } from 'mongoose';
import type { Granularity } from '@pulse/shared';

/**
 * The dashboard aggregation.
 *
 * Every widget on the analytics page — the time series, the summary tiles, top
 * paths, top referrers, countries, devices, browsers — is computed by ONE
 * aggregation using `$facet`.
 *
 * Why one pipeline rather than seven queries:
 *
 *   - The `$match` stage that selects the project and time window is by far the
 *     most expensive part; it is the only stage that touches the index and the
 *     only one whose cost scales with traffic. Running it once and fanning the
 *     result out through `$facet` pays that cost once instead of seven times.
 *   - Seven queries means seven connections held concurrently per dashboard
 *     load. At any real concurrency that exhausts the pool.
 *   - The widgets are guaranteed mutually consistent. Seven independent queries
 *     against a collection being written to continuously can each see a
 *     slightly different snapshot, so the top-paths counts would not sum to the
 *     pageview total — a discrepancy that looks exactly like a bug.
 *
 * The trade-off is that `$facet` runs its sub-pipelines in a single thread and
 * the whole thing is bounded by the 16MB document limit for the result. Neither
 * bites here: each facet returns at most a few dozen rows.
 */

export interface PipelineParams {
  projectId: Types.ObjectId;
  from: Date;
  to: Date;
  granularity: Granularity;
  timezone: string;
  /** Optional drill-down, e.g. only events on /pricing. */
  path?: string;
  topN?: number;
}

/** Shape returned by the single `$facet` stage. */
export interface FacetResult {
  series: Array<{ _id: Date; pageviews: number; uniqueVisitors: number }>;
  totals: Array<{ _id: null; pageviews: number; uniqueVisitors: number }>;
  topPaths: Array<{ _id: string; count: number }>;
  topReferrers: Array<{ _id: string; count: number }>;
  countries: Array<{ _id: string; count: number }>;
  devices: Array<{ _id: string | null; count: number }>;
  browsers: Array<{ _id: string; count: number }>;
}

/** Counts only pageviews; custom events must not inflate the traffic graph. */
const PAGEVIEW_COUNTER = { $sum: { $cond: [{ $eq: ['$type', 'pageview'] }, 1, 0] } } as const;

/** `$group` → `$sort` → `$limit`, the shape every "top N" widget uses. */
function topNFacet(field: string, limit: number, extraMatch?: PipelineStage.Match): PipelineStage.FacetPipelineStage[] {
  const stages: PipelineStage.FacetPipelineStage[] = [];
  if (extraMatch) stages.push(extraMatch as PipelineStage.FacetPipelineStage);
  stages.push(
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    // Secondary sort on _id makes the ordering deterministic when counts tie,
    // so the widget does not reshuffle between identical page loads.
    { $sort: { count: -1, _id: 1 } },
    { $limit: limit },
  );
  return stages;
}

export function buildAnalyticsPipeline(params: PipelineParams): PipelineStage[] {
  const { projectId, from, to, granularity, timezone, path } = params;
  const topN = params.topN ?? 10;

  return [
    /*
     * STAGE 1 — the only stage that reads the collection.
     *
     * `projectId` equality then `timestamp` range is exactly the shape of the
     * { projectId: 1, timestamp: -1 } index, so this is an index scan bounded
     * to this tenant's slice. `$gte`/`$lt` (half-open) rather than `$lte` so
     * an event landing exactly on a bucket boundary is counted once, in the
     * later bucket — matching `$dateTrunc`'s own convention below.
     */
    {
      $match: {
        projectId,
        timestamp: { $gte: from, $lt: to },
        ...(path ? { path } : {}),
      },
    },

    /*
     * STAGE 2 — project away everything the facets do not read.
     *
     * `meta` is a free-form object that can be a few hundred bytes per event.
     * Dropping it here means the documents streamed into seven sub-pipelines
     * are a fraction of the size, which matters because `$facet` materialises
     * its input.
     */
    {
      $project: {
        _id: 0,
        type: 1,
        path: 1,
        referrer: 1,
        country: 1,
        device: 1,
        browser: 1,
        sessionId: 1,
        timestamp: 1,
      },
    },

    /*
     * STAGE 3 — fan out. Each sub-pipeline sees the same matched, projected
     * documents and computes one widget.
     */
    {
      $facet: {
        /*
         * TIME SERIES — two-stage group.
         *
         * First group by (bucket, sessionId): this collapses each visitor to
         * one row per bucket, so the second group can count distinct visitors
         * by simply counting rows. The obvious alternative,
         * `{ $addToSet: '$sessionId' }`, builds an in-memory array of every
         * session in every bucket and hits the 100MB group limit on a busy
         * project — this shape has a bounded working set instead.
         *
         * `$dateTrunc` with an explicit `timezone` is what makes the buckets
         * timezone-correct: a "day" is the visitor-facing calendar day in the
         * user's zone, including 23- and 25-hour DST days, not a fixed 86400s
         * offset from UTC. Doing this in application code after a UTC group
         * would mis-assign every event in the offset window at each boundary.
         */
        series: [
          {
            $group: {
              _id: {
                bucket: {
                  $dateTrunc: { date: '$timestamp', unit: granularity, timezone },
                },
                sessionId: '$sessionId',
              },
              pageviews: PAGEVIEW_COUNTER,
            },
          },
          {
            $group: {
              _id: '$_id.bucket',
              pageviews: { $sum: '$pageviews' },
              uniqueVisitors: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],

        /*
         * SUMMARY TOTALS — same two-stage trick, without the bucket key.
         *
         * Note this is NOT the sum of the series' uniqueVisitors: a visitor
         * active in three different hours counts once here and three times
         * there. Both are correct answers to different questions, and the UI
         * labels them accordingly.
         */
        totals: [
          { $group: { _id: '$sessionId', pageviews: PAGEVIEW_COUNTER } },
          {
            $group: {
              _id: null,
              pageviews: { $sum: '$pageviews' },
              uniqueVisitors: { $sum: 1 },
            },
          },
        ],

        // Only pageviews have a meaningful path; custom events would pollute this.
        topPaths: topNFacet('path', topN, { $match: { type: 'pageview' } }),

        // Null referrer means direct traffic, which is not a referrer.
        topReferrers: topNFacet('referrer', topN, { $match: { referrer: { $ne: null } } }),

        countries: topNFacet('country', topN, { $match: { country: { $ne: null } } }),

        // No limit concept needed: there are exactly three device buckets.
        devices: [{ $group: { _id: '$device', count: { $sum: 1 } } }, { $sort: { count: -1 } }],

        browsers: topNFacet('browser', topN, { $match: { browser: { $ne: null } } }),
      },
    },
  ];
}

/**
 * Totals only, for the preceding period's comparison numbers.
 *
 * Separate from the main pipeline because it reads a *different* time range, so
 * it cannot share the `$match` — see `analytics/service.ts`, where the two run
 * concurrently under `Promise.all`.
 */
export function buildTotalsPipeline(params: {
  projectId: Types.ObjectId;
  from: Date;
  to: Date;
  path?: string;
}): PipelineStage[] {
  return [
    {
      $match: {
        projectId: params.projectId,
        timestamp: { $gte: params.from, $lt: params.to },
        ...(params.path ? { path: params.path } : {}),
      },
    },
    { $group: { _id: '$sessionId', pageviews: PAGEVIEW_COUNTER } },
    { $group: { _id: null, pageviews: { $sum: '$pageviews' }, uniqueVisitors: { $sum: 1 } } },
  ];
}

/**
 * The rollup-backed equivalent of `buildAnalyticsPipeline`.
 *
 * Reads one document per day instead of one per event. The facets differ in
 * shape — the per-day top-N lists have to be `$unwind`ed and re-merged — but
 * the *output* is identical, which is what lets the service swap sources
 * without the caller knowing.
 */
export function buildRollupPipeline(params: {
  projectId: Types.ObjectId;
  from: Date;
  to: Date;
  topN?: number;
}): PipelineStage[] {
  const topN = params.topN ?? 10;

  /** Re-merge a per-day top-N array into a range-wide top-N. */
  const mergeArray = (field: string): PipelineStage.FacetPipelineStage[] => [
    { $unwind: `$${field}` },
    { $group: { _id: `$${field}.label`, count: { $sum: `$${field}.count` } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: topN },
  ];

  return [
    { $match: { projectId: params.projectId, date: { $gte: params.from, $lt: params.to } } },
    {
      $facet: {
        /*
         * One rollup document per day already *is* a daily bucket, so there is
         * no `$dateTrunc` here. Rollups are keyed on UTC midnight; the service
         * only uses this path for day-granularity ranges, where a whole-day
         * bucket in a non-UTC zone would differ from UTC by at most a partial
         * day at each end. That approximation is documented in the README and
         * is why we do not serve 24h from rollups.
         */
        series: [
          {
            $project: {
              _id: '$date',
              pageviews: '$pageviews',
              uniqueVisitors: '$uniqueVisitors',
            },
          },
          { $sort: { _id: 1 } },
        ],

        /*
         * Summing daily unique visitors is exact here, not an approximation:
         * `sessionId` is a *daily-rotating* hash (see server/session.ts), so a
         * visitor is by construction a different session on each day. There is
         * no cross-day double-counting to correct for.
         */
        totals: [
          {
            $group: {
              _id: null,
              pageviews: { $sum: '$pageviews' },
              uniqueVisitors: { $sum: '$uniqueVisitors' },
            },
          },
        ],

        topPaths: mergeArray('topPaths'),
        topReferrers: mergeArray('topReferrers'),
        countries: mergeArray('countries'),
        browsers: mergeArray('browsers'),
        devices: [
          {
            $group: {
              _id: null,
              desktop: { $sum: '$devices.desktop' },
              mobile: { $sum: '$devices.mobile' },
              tablet: { $sum: '$devices.tablet' },
              unknown: { $sum: '$devices.unknown' },
            },
          },
        ],
      },
    },
  ];
}
