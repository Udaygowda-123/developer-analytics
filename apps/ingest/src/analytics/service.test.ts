import RedisMock from 'ioredis-mock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { DailyRollup } from '@pulse/shared/models';
import { clearTestMongo, startTestMongo, stopTestMongo } from '../../test/mongo.js';
import { createTestProject, createTestUser, insertEvents } from '../../test/fixtures.js';
import { setRedisForTesting, type RedisClient } from '../redis.js';
import { analyticsCacheKey, getAnalytics, invalidateAnalyticsCache } from './service.js';
import { rollupRange } from '../jobs/rollup.js';

const NOW = new Date('2024-06-15T12:00:00Z');

let projectId: string;

beforeAll(async () => {
  await startTestMongo();
});

afterAll(async () => {
  await stopTestMongo();
});

beforeEach(async () => {
  await clearTestMongo();
  setRedisForTesting(new RedisMock() as unknown as RedisClient);
  const user = await createTestUser();
  projectId = String((await createTestProject(user._id as Types.ObjectId))._id);
});

describe('source selection', () => {
  it('reads raw events for ranges of 30 days or fewer', async () => {
    const result = await getAnalytics(
      { projectId, range: '7d', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );
    expect(result.source).toBe('events');
  });

  it('reads rollups for a 90-day range', async () => {
    const result = await getAnalytics(
      { projectId, range: '90d', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );
    expect(result.source).toBe('rollups');
  });

  it('returns the same response shape from either source', async () => {
    const fromEvents = await getAnalytics(
      { projectId, range: '7d', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );
    const fromRollups = await getAnalytics(
      { projectId, range: '90d', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );

    // The switchover has to be transparent: same keys, same types.
    expect(Object.keys(fromRollups).sort()).toEqual(Object.keys(fromEvents).sort());
    expect(Array.isArray(fromRollups.series)).toBe(true);
    expect(fromRollups.summary).toHaveProperty('pageviews');
  });

  it('produces consistent totals whichever source is used', async () => {
    // Two days of traffic, then roll them up. Reading the same window from raw
    // events and from rollups must agree — if they do not, the dashboard
    // changes its numbers when the user picks a longer range.
    const objectId = new Types.ObjectId(projectId);
    await insertEvents([
      { projectId: objectId, timestamp: new Date('2024-06-13T10:00:00Z'), sessionId: 'a', path: '/' },
      { projectId: objectId, timestamp: new Date('2024-06-13T11:00:00Z'), sessionId: 'a', path: '/' },
      { projectId: objectId, timestamp: new Date('2024-06-13T12:00:00Z'), sessionId: 'b', path: '/x' },
      { projectId: objectId, timestamp: new Date('2024-06-14T10:00:00Z'), sessionId: 'c', path: '/' },
    ]);
    await rollupRange(new Date('2024-06-13T00:00:00Z'), new Date('2024-06-14T00:00:00Z'));

    const rollups = await DailyRollup.find({ projectId: objectId }).sort({ date: 1 }).lean();
    const rollupPageviews = rollups.reduce((sum, r) => sum + r.pageviews, 0);
    const rollupVisitors = rollups.reduce((sum, r) => sum + r.uniqueVisitors, 0);

    const fromEvents = await getAnalytics(
      { projectId, range: '7d', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );

    expect(rollupPageviews).toBe(fromEvents.summary.pageviews);
    // Unique visitors match too, because sessionId rotates daily — summing
    // per-day uniques is exact, not an approximation.
    expect(rollupVisitors).toBe(fromEvents.summary.uniqueVisitors);
  });
});

describe('the series', () => {
  it('zero-fills buckets with no traffic', async () => {
    await insertEvents([
      { projectId: new Types.ObjectId(projectId), timestamp: new Date('2024-06-14T10:00:00Z'), sessionId: 'a' },
    ]);

    const result = await getAnalytics(
      { projectId, range: '7d', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );

    // Seven buckets, six of them zero — a chart must show the quiet days.
    expect(result.series).toHaveLength(7);
    expect(result.series.filter((p) => p.pageviews === 0)).toHaveLength(6);
    expect(result.series.find((p) => p.pageviews === 1)?.bucket).toBe('2024-06-14T00:00:00.000Z');
  });

  it('produces 24 hourly buckets for a 24h range', async () => {
    const result = await getAnalytics(
      { projectId, range: '24h', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );
    expect(result.series).toHaveLength(24);
  });

  it('shifts bucket boundaries with the requested timezone', async () => {
    const utc = await getAnalytics(
      { projectId, range: '7d', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );
    const tokyo = await getAnalytics(
      { projectId, range: '7d', timezone: 'Asia/Tokyo' },
      { now: NOW, skipCache: true },
    );

    expect(utc.series[0]?.bucket).not.toBe(tokyo.series[0]?.bucket);
    expect(tokyo.timezone).toBe('Asia/Tokyo');
  });
});

describe('period-over-period comparison', () => {
  it('computes the change against the preceding window', async () => {
    const objectId = new Types.ObjectId(projectId);
    await insertEvents([
      // Previous 7d window (2024-06-02 .. 06-08): 2 pageviews.
      { projectId: objectId, timestamp: new Date('2024-06-03T10:00:00Z'), sessionId: 'p1' },
      { projectId: objectId, timestamp: new Date('2024-06-04T10:00:00Z'), sessionId: 'p2' },
      // Current window: 3 pageviews.
      { projectId: objectId, timestamp: new Date('2024-06-13T10:00:00Z'), sessionId: 'c1' },
      { projectId: objectId, timestamp: new Date('2024-06-14T10:00:00Z'), sessionId: 'c2' },
      { projectId: objectId, timestamp: new Date('2024-06-15T10:00:00Z'), sessionId: 'c3' },
    ]);

    const result = await getAnalytics(
      { projectId, range: '7d', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );

    expect(result.summary.pageviews).toBe(3);
    expect(result.summary.pageviewsChangePct).toBe(50);
  });

  it('reports null rather than an infinite percentage when the prior period was empty', async () => {
    await insertEvents([
      { projectId: new Types.ObjectId(projectId), timestamp: new Date('2024-06-14T10:00:00Z'), sessionId: 'a' },
    ]);

    const result = await getAnalytics(
      { projectId, range: '7d', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );
    expect(result.summary.pageviewsChangePct).toBeNull();
  });
});

describe('caching', () => {
  it('serves a repeat request from Redis', async () => {
    const objectId = new Types.ObjectId(projectId);
    await insertEvents([
      { projectId: objectId, timestamp: new Date('2024-06-14T10:00:00Z'), sessionId: 'a' },
    ]);

    const first = await getAnalytics({ projectId, range: '7d', timezone: 'UTC' }, { now: NOW });

    // Add more data; a cached response must not reflect it.
    await insertEvents([
      { projectId: objectId, timestamp: new Date('2024-06-14T11:00:00Z'), sessionId: 'b' },
    ]);
    const second = await getAnalytics({ projectId, range: '7d', timezone: 'UTC' }, { now: NOW });

    expect(second.summary.pageviews).toBe(first.summary.pageviews);
    expect(second.summary.pageviews).toBe(1);
  });

  it('keys the cache by range and timezone, so users in different zones do not share', () => {
    const base = { projectId, range: '7d', timezone: 'UTC' } as const;
    expect(analyticsCacheKey(base)).not.toBe(analyticsCacheKey({ ...base, timezone: 'Asia/Tokyo' }));
    expect(analyticsCacheKey(base)).not.toBe(analyticsCacheKey({ ...base, range: '30d' }));
    expect(analyticsCacheKey(base)).not.toBe(
      analyticsCacheKey({ ...base, projectId: new Types.ObjectId().toHexString() }),
    );
  });

  it('keys the cache by the path filter', () => {
    const base = { projectId, range: '7d', timezone: 'UTC' } as const;
    expect(analyticsCacheKey(base)).not.toBe(analyticsCacheKey({ ...base, path: '/pricing' }));
  });

  it('can be invalidated for a whole project', async () => {
    const objectId = new Types.ObjectId(projectId);
    await insertEvents([
      { projectId: objectId, timestamp: new Date('2024-06-14T10:00:00Z'), sessionId: 'a' },
    ]);
    await getAnalytics({ projectId, range: '7d', timezone: 'UTC' }, { now: NOW });

    await insertEvents([
      { projectId: objectId, timestamp: new Date('2024-06-14T11:00:00Z'), sessionId: 'b' },
    ]);
    await invalidateAnalyticsCache(projectId);

    const fresh = await getAnalytics({ projectId, range: '7d', timezone: 'UTC' }, { now: NOW });
    expect(fresh.summary.pageviews).toBe(2);
  });
});

describe('empty projects', () => {
  it('returns zeroes and empty lists rather than failing', async () => {
    const result = await getAnalytics(
      { projectId, range: '30d', timezone: 'UTC' },
      { now: NOW, skipCache: true },
    );

    expect(result.summary).toMatchObject({ pageviews: 0, uniqueVisitors: 0 });
    expect(result.topPaths).toEqual([]);
    expect(result.countries).toEqual([]);
    expect(result.series).toHaveLength(30);
  });
});
