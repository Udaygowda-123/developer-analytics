import { describe, expect, it } from 'vitest';
import {
  addBuckets,
  enumerateBuckets,
  previousRange,
  resolveRange,
  shouldUseRollups,
  timeZoneOffsetMs,
  truncateInZone,
  utcMidnight,
  wallClockIn,
  wallClockToInstant,
} from './time.js';

const NY = 'America/New_York';
const KOLKATA = 'Asia/Kolkata'; // UTC+5:30 — catches offsets that aren't whole hours
const UTC = 'UTC';

describe('wallClockIn', () => {
  it('reads the local wall clock, not UTC', () => {
    // 2024-03-15T02:30:00Z is 22:30 on the 14th in New York (UTC-4, EDT).
    expect(wallClockIn(new Date('2024-03-15T02:30:00Z'), NY)).toEqual({
      year: 2024,
      month: 3,
      day: 14,
      hour: 22,
      minute: 30,
      second: 0,
    });
  });

  it('handles half-hour offsets', () => {
    expect(wallClockIn(new Date('2024-06-01T00:00:00Z'), KOLKATA)).toMatchObject({
      day: 1,
      hour: 5,
      minute: 30,
    });
  });
});

describe('timeZoneOffsetMs', () => {
  it('is zero for UTC', () => {
    expect(timeZoneOffsetMs(new Date('2024-06-01T12:00:00Z'), UTC)).toBe(0);
  });

  it('reflects DST: -5h in winter, -4h in summer for New York', () => {
    expect(timeZoneOffsetMs(new Date('2024-01-15T12:00:00Z'), NY)).toBe(-5 * 3_600_000);
    expect(timeZoneOffsetMs(new Date('2024-07-15T12:00:00Z'), NY)).toBe(-4 * 3_600_000);
  });

  it('handles the +5:30 offset', () => {
    expect(timeZoneOffsetMs(new Date('2024-06-01T00:00:00Z'), KOLKATA)).toBe(5.5 * 3_600_000);
  });
});

describe('wallClockToInstant', () => {
  it('round-trips through wallClockIn', () => {
    for (const tz of [UTC, NY, KOLKATA, 'Australia/Sydney']) {
      const original = new Date('2024-09-04T13:45:00Z');
      const w = wallClockIn(original, tz);
      const back = wallClockToInstant(w, tz);
      expect(back.toISOString()).toBe(original.toISOString());
    }
  });

  it('resolves correctly on the far side of a DST fall-back', () => {
    // 2024-11-03 01:30 EDT/EST is ambiguous in New York; either resolution must
    // still *be* 01:30 local when read back, which is what callers rely on.
    const instant = wallClockToInstant({ year: 2024, month: 11, day: 3, hour: 1, minute: 30 }, NY);
    expect(wallClockIn(instant, NY)).toMatchObject({ day: 3, hour: 1, minute: 30 });
  });

  it('normalises day overflow (day 32 -> next month)', () => {
    const instant = wallClockToInstant({ year: 2024, month: 1, day: 32, hour: 0 }, UTC);
    expect(instant.toISOString()).toBe('2024-02-01T00:00:00.000Z');
  });
});

describe('truncateInZone', () => {
  it('day-truncates to local midnight, not UTC midnight', () => {
    // 03:00Z on the 15th is still 23:00 on the 14th in New York, so the day
    // bucket must be the 14th. Truncating in UTC would put it on the 15th —
    // this is exactly the off-by-one-day bug the helper exists to prevent.
    const d = truncateInZone(new Date('2024-03-15T03:00:00Z'), 'day', NY);
    expect(d.toISOString()).toBe('2024-03-14T04:00:00.000Z');
    expect(wallClockIn(d, NY)).toMatchObject({ day: 14, hour: 0 });
  });

  it('day-truncates correctly for a half-hour zone', () => {
    // 00:00Z on the 1st is 05:30 local, so the local day started at 18:30Z
    // on the previous day.
    const d = truncateInZone(new Date('2024-06-01T00:00:00Z'), 'day', KOLKATA);
    expect(d.toISOString()).toBe('2024-05-31T18:30:00.000Z');
  });

  it('hour-truncates', () => {
    const d = truncateInZone(new Date('2024-06-01T13:47:22.500Z'), 'hour', NY);
    expect(d.toISOString()).toBe('2024-06-01T13:00:00.000Z');
  });
});

describe('addBuckets', () => {
  it('adds a calendar day across a spring-forward, not a fixed 24 hours', () => {
    // 2024-03-10 is a 23-hour day in New York. Naive +86400000 would land at
    // 01:00 local on the 11th; the correct answer is local midnight.
    const start = truncateInZone(new Date('2024-03-10T12:00:00Z'), 'day', NY);
    const next = addBuckets(start, 'day', 1, NY);
    expect(next.getTime() - start.getTime()).toBe(23 * 3_600_000);
    expect(wallClockIn(next, NY)).toMatchObject({ day: 11, hour: 0 });
  });

  it('adds a calendar day across a fall-back (25-hour day)', () => {
    const start = truncateInZone(new Date('2024-11-03T12:00:00Z'), 'day', NY);
    const next = addBuckets(start, 'day', 1, NY);
    expect(next.getTime() - start.getTime()).toBe(25 * 3_600_000);
    expect(wallClockIn(next, NY)).toMatchObject({ day: 4, hour: 0 });
  });

  it('steps backwards', () => {
    const start = truncateInZone(new Date('2024-06-10T12:00:00Z'), 'day', UTC);
    expect(addBuckets(start, 'day', -3, UTC).toISOString()).toBe('2024-06-07T00:00:00.000Z');
  });
});

describe('resolveRange', () => {
  const now = new Date('2024-06-15T14:32:00Z');

  it('24h covers 24 hourly buckets ending with the in-progress hour', () => {
    const r = resolveRange('24h', UTC, now);
    expect(r.granularity).toBe('hour');
    expect(r.bucketCount).toBe(24);
    expect(r.from.toISOString()).toBe('2024-06-14T15:00:00.000Z');
    expect(r.to.toISOString()).toBe('2024-06-15T15:00:00.000Z');
    expect(enumerateBuckets(r)).toHaveLength(24);
  });

  it('7d covers 7 local-day buckets including today', () => {
    const r = resolveRange('7d', NY, now);
    expect(r.granularity).toBe('day');
    expect(enumerateBuckets(r)).toHaveLength(7);
    // 14:32Z is 10:32 local, so "today" is the 15th and the window starts on the 9th.
    expect(wallClockIn(r.from, NY)).toMatchObject({ month: 6, day: 9, hour: 0 });
  });

  it('produces exactly bucketCount buckets even across a DST transition', () => {
    const acrossDst = new Date('2024-03-12T12:00:00Z');
    const r = resolveRange('7d', NY, acrossDst);
    expect(enumerateBuckets(r)).toHaveLength(7);
  });

  it('90d spans 90 buckets', () => {
    expect(enumerateBuckets(resolveRange('90d', UTC, now))).toHaveLength(90);
  });
});

describe('previousRange', () => {
  it('is the equal-length window immediately before', () => {
    const r = resolveRange('7d', UTC, new Date('2024-06-15T14:32:00Z'));
    const prev = previousRange(r);
    expect(prev.to.toISOString()).toBe(r.from.toISOString());
    expect(prev.from.toISOString()).toBe('2024-06-02T00:00:00.000Z');
  });
});

describe('shouldUseRollups', () => {
  it('reads rollups only past the 30-day threshold', () => {
    expect(shouldUseRollups('24h')).toBe(false);
    expect(shouldUseRollups('7d')).toBe(false);
    expect(shouldUseRollups('30d')).toBe(false);
    expect(shouldUseRollups('90d')).toBe(true);
  });
});

describe('utcMidnight', () => {
  it('zeroes the time component in UTC', () => {
    expect(utcMidnight(new Date('2024-06-15T23:59:59.999Z')).toISOString()).toBe(
      '2024-06-15T00:00:00.000Z',
    );
  });
});
