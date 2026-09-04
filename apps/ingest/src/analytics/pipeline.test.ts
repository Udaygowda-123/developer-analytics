import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { Event } from '@pulse/shared/models';
import { resolveRange } from '@pulse/shared';
import { clearTestMongo, startTestMongo, stopTestMongo } from '../../test/mongo.js';
import { createTestProject, createTestUser, insertEvents } from '../../test/fixtures.js';
import { buildAnalyticsPipeline, buildTotalsPipeline, type FacetResult } from './pipeline.js';

/**
 * Integration tests for the `$facet` pipeline, run against a real MongoDB.
 *
 * These cannot be unit tests: the whole point of the pipeline is what the
 * *database* does with `$dateTrunc`, `$group` and `$facet`, and a mock would
 * only assert that we built the object we built.
 */

let projectId: Types.ObjectId;
let otherProjectId: Types.ObjectId;

beforeAll(async () => {
  await startTestMongo();
});

afterAll(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearTestMongo();
  const user = await createTestUser();
  const project = await createTestProject(user._id as Types.ObjectId);
  const other = await createTestProject(user._id as Types.ObjectId, { name: 'Other' });
  projectId = project._id;
  otherProjectId = other._id;
});

async function runPipeline(params: Partial<Parameters<typeof buildAnalyticsPipeline>[0]> = {}) {
  const resolved = resolveRange('7d', 'UTC', new Date('2024-06-15T12:00:00Z'));
  const rows = await Event.aggregate<FacetResult>(
    buildAnalyticsPipeline({
      projectId,
      from: resolved.from,
      to: resolved.to,
      granularity: resolved.granularity,
      timezone: 'UTC',
      ...params,
    }),
  );
  return rows[0]!;
}

describe('tenant isolation', () => {
  it('counts only the requested project', async () => {
    const base = new Date('2024-06-14T10:00:00Z');
    await insertEvents([
      { projectId, timestamp: base, sessionId: 's1' },
      { projectId, timestamp: base, sessionId: 's2' },
      { projectId: otherProjectId, timestamp: base, sessionId: 's3' },
      { projectId: otherProjectId, timestamp: base, sessionId: 's4' },
    ]);

    const result = await runPipeline();
    expect(result.totals[0]?.pageviews).toBe(2);
    expect(result.totals[0]?.uniqueVisitors).toBe(2);
  });
});

describe('time window', () => {
  it('excludes events outside [from, to)', async () => {
    const resolved = resolveRange('7d', 'UTC', new Date('2024-06-15T12:00:00Z'));
    await insertEvents([
      // One millisecond before the window — must be excluded.
      { projectId, timestamp: new Date(resolved.from.getTime() - 1), sessionId: 'before' },
      // Exactly on `from` — inclusive.
      { projectId, timestamp: resolved.from, sessionId: 'start' },
      { projectId, timestamp: new Date('2024-06-14T10:00:00Z'), sessionId: 'middle' },
      // Exactly on `to` — exclusive.
      { projectId, timestamp: resolved.to, sessionId: 'end' },
    ]);

    const result = await runPipeline();
    expect(result.totals[0]?.pageviews).toBe(2);
  });
});

describe('unique visitors', () => {
  it('counts distinct sessionIds, not events', async () => {
    const base = new Date('2024-06-14T10:00:00Z');
    await insertEvents([
      { projectId, timestamp: base, sessionId: 's1' },
      { projectId, timestamp: new Date(base.getTime() + 1000), sessionId: 's1' },
      { projectId, timestamp: new Date(base.getTime() + 2000), sessionId: 's1' },
      { projectId, timestamp: base, sessionId: 's2' },
    ]);

    const result = await runPipeline();
    expect(result.totals[0]?.pageviews).toBe(4);
    expect(result.totals[0]?.uniqueVisitors).toBe(2);
  });

  it('counts a visitor once per bucket in the series but once overall in totals', async () => {
    // Same session active on three separate days.
    await insertEvents([
      { projectId, timestamp: new Date('2024-06-12T10:00:00Z'), sessionId: 's1' },
      { projectId, timestamp: new Date('2024-06-13T10:00:00Z'), sessionId: 's1' },
      { projectId, timestamp: new Date('2024-06-14T10:00:00Z'), sessionId: 's1' },
    ]);

    const result = await runPipeline();
    expect(result.totals[0]?.uniqueVisitors).toBe(1);
    expect(result.series).toHaveLength(3);
    expect(result.series.every((s) => s.uniqueVisitors === 1)).toBe(true);
  });
});

describe('custom events', () => {
  it('does not count custom events as pageviews', async () => {
    const base = new Date('2024-06-14T10:00:00Z');
    await insertEvents([
      { projectId, timestamp: base, sessionId: 's1', type: 'pageview', path: '/' },
      { projectId, timestamp: base, sessionId: 's1', type: 'custom', name: 'signup', path: '/' },
      { projectId, timestamp: base, sessionId: 's1', type: 'custom', name: 'signup', path: '/' },
    ]);

    const result = await runPipeline();
    expect(result.totals[0]?.pageviews).toBe(1);
    // ...but the visitor is still counted.
    expect(result.totals[0]?.uniqueVisitors).toBe(1);
  });

  it('excludes custom events from topPaths', async () => {
    const base = new Date('2024-06-14T10:00:00Z');
    await insertEvents([
      { projectId, timestamp: base, sessionId: 's1', type: 'pageview', path: '/real' },
      { projectId, timestamp: base, sessionId: 's1', type: 'custom', path: '/fake', name: 'x' },
    ]);

    const result = await runPipeline();
    expect(result.topPaths.map((p) => p._id)).toEqual(['/real']);
  });
});

describe('timezone-correct bucketing', () => {
  it('assigns an event to the local day, not the UTC day', async () => {
    // 03:00Z on the 14th is 23:00 on the 13th in New York.
    await insertEvents([
      { projectId, timestamp: new Date('2024-06-14T03:00:00Z'), sessionId: 's1' },
    ]);

    const resolved = resolveRange('7d', 'America/New_York', new Date('2024-06-15T12:00:00Z'));
    const [utcResult] = await Event.aggregate<FacetResult>(
      buildAnalyticsPipeline({
        projectId,
        from: resolved.from,
        to: resolved.to,
        granularity: 'day',
        timezone: 'UTC',
      }),
    );
    const [nyResult] = await Event.aggregate<FacetResult>(
      buildAnalyticsPipeline({
        projectId,
        from: resolved.from,
        to: resolved.to,
        granularity: 'day',
        timezone: 'America/New_York',
      }),
    );

    // Same event, different bucket, entirely because of the timezone argument.
    expect(utcResult!.series[0]!._id.toISOString()).toBe('2024-06-14T00:00:00.000Z');
    expect(nyResult!.series[0]!._id.toISOString()).toBe('2024-06-13T04:00:00.000Z');
  });

  it('produces buckets at local midnight for a half-hour offset zone', async () => {
    await insertEvents([
      { projectId, timestamp: new Date('2024-06-14T12:00:00Z'), sessionId: 's1' },
    ]);
    const resolved = resolveRange('7d', 'Asia/Kolkata', new Date('2024-06-15T12:00:00Z'));
    const [result] = await Event.aggregate<FacetResult>(
      buildAnalyticsPipeline({
        projectId,
        from: resolved.from,
        to: resolved.to,
        granularity: 'day',
        timezone: 'Asia/Kolkata',
      }),
    );
    // Local midnight on 2024-06-14 in +05:30 is 18:30Z on the 13th.
    expect(result!.series[0]!._id.toISOString()).toBe('2024-06-13T18:30:00.000Z');
  });

  it('agrees with the JS bucketing helper across a DST transition', async () => {
    // 2024-03-10 is the US spring-forward. Events either side must land in the
    // buckets resolveRange/enumerateBuckets predicts, or the chart's x-axis and
    // its data disagree.
    const tz = 'America/New_York';
    await insertEvents([
      { projectId, timestamp: new Date('2024-03-10T04:00:00Z'), sessionId: 's1' }, // 23:00 Mar 9 EST
      { projectId, timestamp: new Date('2024-03-10T12:00:00Z'), sessionId: 's2' }, // 08:00 Mar 10 EDT
      { projectId, timestamp: new Date('2024-03-11T12:00:00Z'), sessionId: 's3' }, // 08:00 Mar 11 EDT
    ]);

    const resolved = resolveRange('7d', tz, new Date('2024-03-12T12:00:00Z'));
    const [result] = await Event.aggregate<FacetResult>(
      buildAnalyticsPipeline({
        projectId,
        from: resolved.from,
        to: resolved.to,
        granularity: 'day',
        timezone: tz,
      }),
    );

    const buckets = result!.series.map((s) => s._id.toISOString());
    expect(buckets).toEqual([
      '2024-03-09T05:00:00.000Z', // Mar 9 local midnight, EST (UTC-5)
      '2024-03-10T05:00:00.000Z', // Mar 10 local midnight, still EST at 00:00
      '2024-03-11T04:00:00.000Z', // Mar 11 local midnight, now EDT (UTC-4)
    ]);
  });

  it('buckets by hour for a 24h range', async () => {
    await insertEvents([
      { projectId, timestamp: new Date('2024-06-15T10:15:00Z'), sessionId: 's1' },
      { projectId, timestamp: new Date('2024-06-15T10:45:00Z'), sessionId: 's2' },
      { projectId, timestamp: new Date('2024-06-15T11:05:00Z'), sessionId: 's3' },
    ]);

    const resolved = resolveRange('24h', 'UTC', new Date('2024-06-15T12:00:00Z'));
    const [result] = await Event.aggregate<FacetResult>(
      buildAnalyticsPipeline({
        projectId,
        from: resolved.from,
        to: resolved.to,
        granularity: 'hour',
        timezone: 'UTC',
      }),
    );

    expect(result!.series.map((s) => [s._id.toISOString(), s.pageviews])).toEqual([
      ['2024-06-15T10:00:00.000Z', 2],
      ['2024-06-15T11:00:00.000Z', 1],
    ]);
  });
});

describe('top-N facets', () => {
  beforeEach(async () => {
    const base = new Date('2024-06-14T10:00:00Z');
    const specs = [];
    for (let i = 0; i < 5; i++) specs.push({ projectId, timestamp: base, sessionId: `a${i}`, path: '/' });
    for (let i = 0; i < 3; i++) specs.push({ projectId, timestamp: base, sessionId: `b${i}`, path: '/pricing' });
    for (let i = 0; i < 1; i++) specs.push({ projectId, timestamp: base, sessionId: `c${i}`, path: '/docs' });
    await insertEvents(specs);
  });

  it('orders top paths by count descending', async () => {
    const result = await runPipeline();
    expect(result.topPaths).toEqual([
      { _id: '/', count: 5 },
      { _id: '/pricing', count: 3 },
      { _id: '/docs', count: 1 },
    ]);
  });

  it('respects the topN limit', async () => {
    const result = await runPipeline({ topN: 2 });
    expect(result.topPaths).toHaveLength(2);
  });

  it('excludes null referrers (direct traffic is not a referrer)', async () => {
    await insertEvents([
      { projectId, timestamp: new Date('2024-06-14T11:00:00Z'), sessionId: 'r1', referrer: 'google.com' },
      { projectId, timestamp: new Date('2024-06-14T11:00:00Z'), sessionId: 'r2', referrer: null },
    ]);
    const result = await runPipeline();
    expect(result.topReferrers).toEqual([{ _id: 'google.com', count: 1 }]);
  });

  it('breaks count ties deterministically', async () => {
    await clearTestMongo();
    const user = await createTestUser();
    const project = await createTestProject(user._id as Types.ObjectId);
    projectId = project._id;

    const base = new Date('2024-06-14T10:00:00Z');
    await insertEvents([
      { projectId, timestamp: base, sessionId: 's1', path: '/zebra' },
      { projectId, timestamp: base, sessionId: 's2', path: '/apple' },
    ]);

    const first = await runPipeline();
    const second = await runPipeline();
    expect(first.topPaths.map((p) => p._id)).toEqual(['/apple', '/zebra']);
    expect(second.topPaths).toEqual(first.topPaths);
  });
});

describe('device and country facets', () => {
  it('groups devices including the null bucket', async () => {
    const base = new Date('2024-06-14T10:00:00Z');
    await insertEvents([
      { projectId, timestamp: base, sessionId: 's1', device: 'desktop', country: 'US' },
      { projectId, timestamp: base, sessionId: 's2', device: 'mobile', country: 'US' },
      { projectId, timestamp: base, sessionId: 's3', device: 'mobile', country: 'GB' },
      { projectId, timestamp: base, sessionId: 's4', device: null, country: null },
    ]);

    const result = await runPipeline();
    const devices = Object.fromEntries(result.devices.map((d) => [d._id ?? 'null', d.count]));
    expect(devices).toEqual({ mobile: 2, desktop: 1, null: 1 });

    // Countries exclude the null, because "unknown country" is not a country.
    expect(result.countries).toEqual([
      { _id: 'US', count: 2 },
      { _id: 'GB', count: 1 },
    ]);
  });
});

describe('path filter', () => {
  it('restricts every facet to the filtered path', async () => {
    const base = new Date('2024-06-14T10:00:00Z');
    await insertEvents([
      { projectId, timestamp: base, sessionId: 's1', path: '/pricing', country: 'US' },
      { projectId, timestamp: base, sessionId: 's2', path: '/', country: 'GB' },
    ]);

    const result = await runPipeline({ path: '/pricing' });
    expect(result.totals[0]?.pageviews).toBe(1);
    expect(result.countries).toEqual([{ _id: 'US', count: 1 }]);
  });
});

describe('empty results', () => {
  it('returns empty facets rather than throwing', async () => {
    const result = await runPipeline();
    expect(result.totals).toEqual([]);
    expect(result.series).toEqual([]);
    expect(result.topPaths).toEqual([]);
  });
});

describe('buildTotalsPipeline', () => {
  it('computes the previous period independently of the current one', async () => {
    await insertEvents([
      { projectId, timestamp: new Date('2024-06-01T10:00:00Z'), sessionId: 'old1' },
      { projectId, timestamp: new Date('2024-06-01T11:00:00Z'), sessionId: 'old1' },
      { projectId, timestamp: new Date('2024-06-14T10:00:00Z'), sessionId: 'new1' },
    ]);

    const rows = await Event.aggregate<{ pageviews: number; uniqueVisitors: number }>(
      buildTotalsPipeline({
        projectId,
        from: new Date('2024-06-01T00:00:00Z'),
        to: new Date('2024-06-02T00:00:00Z'),
      }),
    );

    expect(rows[0]).toMatchObject({ pageviews: 2, uniqueVisitors: 1 });
  });
});

describe('index usage', () => {
  it('uses the { projectId, timestamp } index rather than a collection scan', async () => {
    // The index is the reason this pipeline is viable at all; assert the
    // planner actually picks it, so a future schema change cannot silently
    // turn every dashboard load into a COLLSCAN.
    await insertEvents([
      { projectId, timestamp: new Date('2024-06-14T10:00:00Z'), sessionId: 's1' },
    ]);

    const explain = (await Event.collection
      .find({ projectId, timestamp: { $gte: new Date('2024-06-08T00:00:00Z') } })
      .explain('queryPlanner')) as {
      queryPlanner: { winningPlan: Record<string, unknown> };
    };

    const plan = JSON.stringify(explain.queryPlanner.winningPlan);
    expect(plan).toContain('IXSCAN');
    expect(plan).toContain('project_time');
    expect(plan).not.toContain('COLLSCAN');
  });
});
