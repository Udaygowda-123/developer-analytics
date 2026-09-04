import type { DateRange } from '../types.js';

/**
 * Timezone-correct time bucketing.
 *
 * MongoDB's `$dateTrunc` does the real bucketing server-side (it takes a
 * `timezone` argument), but we still need the same maths in JS to:
 *   1. compute the query window's start/end in the *user's* zone, and
 *   2. generate the complete list of buckets so the chart can render zeroes
 *      for periods with no traffic rather than silently collapsing them.
 *
 * Both must agree with Mongo exactly, or the first and last buckets drift by an
 * hour and the chart quietly lies. Everything here is pure and unit-tested.
 */

export type Granularity = 'hour' | 'day';

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock reading an observer in `timeZone` sees at instant `date`. */
export function wallClockIn(date: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `timeZone` from UTC at instant `date`, in milliseconds. */
export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const w = wallClockIn(date, timeZone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Drop sub-second precision on both sides so the subtraction is exact.
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock reading in `timeZone` back to the instant it names.
 *
 * The naive `Date.UTC(...) - offset` is wrong across DST boundaries, because
 * the offset we need is the one *at the target instant*, not at our guess. We
 * therefore guess, re-measure at the guess, and correct once. One correction is
 * always enough for real zones: offsets change by at most a couple of hours and
 * the second measurement lands on the correct side of the transition.
 *
 * For a wall time that does not exist (the hour skipped at a spring-forward
 * transition) this resolves forward, matching `$dateTrunc`'s behaviour.
 */
export function wallClockToInstant(
  w: Pick<WallClock, 'year' | 'month' | 'day'> & Partial<WallClock>,
  timeZone: string,
): Date {
  const guessUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour ?? 0, w.minute ?? 0, w.second ?? 0);
  const firstOffset = timeZoneOffsetMs(new Date(guessUtc), timeZone);
  let instant = guessUtc - firstOffset;
  const secondOffset = timeZoneOffsetMs(new Date(instant), timeZone);
  if (secondOffset !== firstOffset) {
    instant = guessUtc - secondOffset;
  }
  return new Date(instant);
}

/** Start of the hour/day containing `date`, as observed in `timeZone`. */
export function truncateInZone(date: Date, granularity: Granularity, timeZone: string): Date {
  const w = wallClockIn(date, timeZone);
  return wallClockToInstant(
    granularity === 'hour'
      ? { year: w.year, month: w.month, day: w.day, hour: w.hour }
      : { year: w.year, month: w.month, day: w.day, hour: 0 },
    timeZone,
  );
}

/**
 * Add `n` buckets to an instant, respecting the zone.
 *
 * Note this is *not* `+= 86400000` for days: a day containing a DST transition
 * is 23 or 25 hours long, and adding a fixed 24h would put every subsequent
 * bucket an hour off for the rest of the range.
 */
export function addBuckets(
  date: Date,
  granularity: Granularity,
  n: number,
  timeZone: string,
): Date {
  if (granularity === 'hour') {
    // Hours are uniform in absolute time even across transitions.
    return new Date(date.getTime() + n * 3_600_000);
  }
  const w = wallClockIn(date, timeZone);
  return wallClockToInstant(
    { year: w.year, month: w.month, day: w.day + n, hour: 0 },
    timeZone,
  );
}

export const RANGE_GRANULARITY: Record<DateRange, Granularity> = {
  '24h': 'hour',
  '7d': 'day',
  '30d': 'day',
  '90d': 'day',
};

/** How many buckets a range contains, used to pre-size the zero-filled series. */
const RANGE_BUCKETS: Record<DateRange, number> = {
  '24h': 24,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export interface ResolvedRange {
  from: Date;
  /** Exclusive upper bound: the start of the bucket *after* the current one. */
  to: Date;
  granularity: Granularity;
  bucketCount: number;
  timeZone: string;
}

/**
 * Turn a `DateRange` into concrete bounds aligned to bucket edges in the
 * caller's zone. `now` is injectable so tests are not clock-dependent.
 */
export function resolveRange(range: DateRange, timeZone: string, now: Date = new Date()): ResolvedRange {
  const granularity = RANGE_GRANULARITY[range];
  const bucketCount = RANGE_BUCKETS[range];
  const currentBucket = truncateInZone(now, granularity, timeZone);
  // Include the in-progress bucket, hence `bucketCount - 1` back and `+1` forward.
  const from = addBuckets(currentBucket, granularity, -(bucketCount - 1), timeZone);
  const to = addBuckets(currentBucket, granularity, 1, timeZone);
  return { from, to, granularity, bucketCount, timeZone };
}

/** The equal-length window immediately before `range`, for period-over-period deltas. */
export function previousRange(resolved: ResolvedRange): { from: Date; to: Date } {
  const from = addBuckets(resolved.from, resolved.granularity, -resolved.bucketCount, resolved.timeZone);
  return { from, to: resolved.from };
}

/** Every bucket start in `[from, to)`, so the chart can zero-fill gaps. */
export function enumerateBuckets(resolved: ResolvedRange): Date[] {
  const out: Date[] = [];
  let cursor = resolved.from;
  // Guard against a pathological zone/range combination looping forever.
  const limit = resolved.bucketCount + 2;
  while (cursor.getTime() < resolved.to.getTime() && out.length < limit) {
    out.push(cursor);
    cursor = addBuckets(cursor, resolved.granularity, 1, resolved.timeZone);
  }
  return out;
}

/** UTC midnight for a given instant — the key DailyRollup documents use. */
export function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Ranges over this many days read from DailyRollup instead of raw Event.
 * 30 days of raw events for a busy site is millions of documents; the rollup is
 * one document per day.
 */
export const ROLLUP_THRESHOLD_DAYS = 30;

export function shouldUseRollups(range: DateRange): boolean {
  return RANGE_BUCKETS[range] > ROLLUP_THRESHOLD_DAYS && RANGE_GRANULARITY[range] === 'day';
}
