import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { DailyRollup, Event } from '@pulse/shared/models';
import { clearTestMongo, startTestMongo, stopTestMongo } from '../../test/mongo.js';
import { createTestProject, createTestUser, insertEvents } from '../../test/fixtures.js';
import { rollupDay, rollupRange } from './rollup.js';
import { pruneOldEvents } from './retention.js';
import { loadConfig, setConfigForTesting } from '../config.js';

const DAY = new Date('2024-06-14T00:00:00Z');

let projectId: Types.ObjectId;
let otherProjectId: Types.ObjectId;

beforeAll(async () => {
  await startTestMongo();
});

afterAll(async () => {
  setConfigForTesting(null);
  await stopTestMongo();
});

beforeEach(async () => {
  await clearTestMongo();
  const user = await createTestUser();
  projectId = (await createTestProject(user._id as Types.ObjectId))._id;
  otherProjectId = (await createTestProject(user._id as Types.ObjectId, { name: 'Other' }))._id;
});

async function seedDay(): Promise<void> {
  await insertEvents([
    { projectId, timestamp: new Date('2024-06-14T01:00:00Z'), sessionId: 's1', path: '/', country: 'US', device: 'desktop' },
    { projectId, timestamp: new Date('2024-06-14T02:00:00Z'), sessionId: 's1', path: '/', country: 'US', device: 'desktop' },
    { projectId, timestamp: new Date('2024-06-14T03:00:00Z'), sessionId: 's2', path: '/pricing', country: 'GB', device: 'mobile', referrer: 'google.com' },
    { projectId, timestamp: new Date('2024-06-14T04:00:00Z'), sessionId: 's3', path: '/', country: 'US', device: 'tablet' },
    { projectId, timestamp: new Date('2024-06-14T05:00:00Z'), sessionId: 's3', path: '/', type: 'custom', name: 'signup', device: 'tablet' },
    // A different project on the same day — must be summarised separately.
    { projectId: otherProjectId, timestamp: new Date('2024-06-14T06:00:00Z'), sessionId: 'x1', path: '/other' },
  ]);
}

describe('rollupDay', () => {
  it('summarises a day per project', async () => {
    await seedDay();
    const stats = await rollupDay(DAY);

    expect(stats.projects).toBe(2);
    expect(stats.eventsProcessed).toBe(6);

    const rollup = await DailyRollup.findOne({ projectId, date: DAY }).lean();
    expect(rollup).toMatchObject({ pageviews: 4, uniqueVisitors: 3 });
    expect(rollup?.topPaths).toEqual([
      { label: '/', count: 3 },
      { label: '/pricing', count: 1 },
    ]);
    expect(rollup?.countries).toEqual([
      { label: 'US', count: 3 },
      { label: 'GB', count: 1 },
    ]);
    expect(rollup?.topReferrers).toEqual([{ label: 'google.com', count: 1 }]);
    expect(rollup?.devices).toMatchObject({ desktop: 2, mobile: 1, tablet: 2 });
  });

  it('excludes custom events from pageviews but keeps their visitor', async () => {
    await seedDay();
    await rollupDay(DAY);
    const rollup = await DailyRollup.findOne({ projectId, date: DAY }).lean();
    // 5 events for this project, one of which is custom.
    expect(rollup?.pageviews).toBe(4);
    expect(rollup?.eventsProcessed).toBe(5);
  });

  it('does not mix projects', async () => {
    await seedDay();
    await rollupDay(DAY);
    const other = await DailyRollup.findOne({ projectId: otherProjectId, date: DAY }).lean();
    expect(other?.pageviews).toBe(1);
    expect(other?.topPaths).toEqual([{ label: '/other', count: 1 }]);
  });

  it('ignores events outside the day', async () => {
    await insertEvents([
      { projectId, timestamp: new Date('2024-06-13T23:59:59Z'), sessionId: 'before' },
      { projectId, timestamp: new Date('2024-06-14T00:00:00Z'), sessionId: 'start' },
      { projectId, timestamp: new Date('2024-06-14T23:59:59Z'), sessionId: 'end' },
      { projectId, timestamp: new Date('2024-06-15T00:00:00Z'), sessionId: 'after' },
    ]);
    await rollupDay(DAY);
    expect((await DailyRollup.findOne({ projectId, date: DAY }).lean())?.pageviews).toBe(2);
  });

  it('writes nothing for a day with no events', async () => {
    const stats = await rollupDay(DAY);
    expect(stats.projects).toBe(0);
    expect(await DailyRollup.countDocuments({})).toBe(0);
  });

  it('reports how long it took and how much it processed', async () => {
    await seedDay();
    const stats = await rollupDay(DAY);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(stats.day).toBe('2024-06-14');
    expect(stats.documentsUpserted).toBe(2);
  });
});

describe('idempotency', () => {
  it('produces identical results when re-run, rather than double-counting', async () => {
    await seedDay();

    await rollupDay(DAY);
    const first = await DailyRollup.findOne({ projectId, date: DAY }).lean();

    await rollupDay(DAY);
    await rollupDay(DAY);
    const third = await DailyRollup.findOne({ projectId, date: DAY }).lean();

    expect(third?.pageviews).toBe(first?.pageviews);
    expect(third?.uniqueVisitors).toBe(first?.uniqueVisitors);
    expect(third?.topPaths).toEqual(first?.topPaths);
    expect(third?.devices?.desktop).toBe(first?.devices?.desktop);
  });

  it('creates exactly one document per project per day however many times it runs', async () => {
    await seedDay();
    for (let i = 0; i < 4; i++) await rollupDay(DAY);

    expect(await DailyRollup.countDocuments({ projectId, date: DAY })).toBe(1);
    expect(await DailyRollup.countDocuments({ date: DAY })).toBe(2);
  });

  it('reflects new events on a re-run instead of adding to the old total', async () => {
    await seedDay();
    await rollupDay(DAY);

    await insertEvents([
      { projectId, timestamp: new Date('2024-06-14T07:00:00Z'), sessionId: 's9', path: '/new' },
    ]);
    await rollupDay(DAY);

    const rollup = await DailyRollup.findOne({ projectId, date: DAY }).lean();
    // 4 original pageviews + 1 new = 5, not 4 + 5.
    expect(rollup?.pageviews).toBe(5);
    expect(rollup?.uniqueVisitors).toBe(4);
  });

  it('is enforced by a unique index, not just by convention', async () => {
    await seedDay();
    await rollupDay(DAY);

    await expect(
      DailyRollup.create({ projectId, date: DAY, pageviews: 999, uniqueVisitors: 999 }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});

describe('rollupRange', () => {
  it('backfills each day independently', async () => {
    await insertEvents([
      { projectId, timestamp: new Date('2024-06-12T10:00:00Z'), sessionId: 'a' },
      { projectId, timestamp: new Date('2024-06-13T10:00:00Z'), sessionId: 'b' },
      { projectId, timestamp: new Date('2024-06-13T11:00:00Z'), sessionId: 'c' },
    ]);

    const stats = await rollupRange(new Date('2024-06-12T00:00:00Z'), new Date('2024-06-13T00:00:00Z'));
    expect(stats).toHaveLength(2);

    const rollups = await DailyRollup.find({ projectId }).sort({ date: 1 }).lean();
    expect(rollups.map((r) => r.pageviews)).toEqual([1, 2]);
  });
});

describe('retention', () => {
  beforeEach(() => {
    setConfigForTesting(loadConfig({ ...process.env, EVENT_RETENTION_DAYS: '90' } as NodeJS.ProcessEnv));
  });

  it('deletes rolled-up events past the retention window', async () => {
    const now = new Date('2024-06-14T12:00:00Z');
    const old = new Date('2024-01-01T10:00:00Z'); // ~165 days before `now`
    await insertEvents([
      { projectId, timestamp: old, sessionId: 'old1' },
      { projectId, timestamp: new Date('2024-06-13T10:00:00Z'), sessionId: 'recent' },
    ]);
    await rollupDay(old);

    const stats = await pruneOldEvents(now);

    expect(stats.eventsDeleted).toBe(1);
    expect(await Event.countDocuments({})).toBe(1);
    // The rollup survives — it is the remaining record of that day.
    expect(await DailyRollup.countDocuments({ projectId })).toBe(1);
  });

  it('refuses to delete a day that was never rolled up', async () => {
    const now = new Date('2024-06-14T12:00:00Z');
    await insertEvents([{ projectId, timestamp: new Date('2024-01-01T10:00:00Z'), sessionId: 'old1' }]);

    const stats = await pruneOldEvents(now);

    // No rollup exists, so the raw events are the only record and must stay.
    expect(stats.eventsDeleted).toBe(0);
    expect(stats.skippedUnrolledDays).toBe(1);
    expect(await Event.countDocuments({})).toBe(1);
  });

  it('deletes only the projects that were rolled up on a mixed day', async () => {
    const now = new Date('2024-06-14T12:00:00Z');
    const old = new Date('2024-01-01T10:00:00Z');
    await insertEvents([
      { projectId, timestamp: old, sessionId: 'a' },
      { projectId: otherProjectId, timestamp: old, sessionId: 'b' },
    ]);
    await rollupDay(old);
    // Remove one project's rollup to simulate a partial failure.
    await DailyRollup.deleteOne({ projectId: otherProjectId });

    const stats = await pruneOldEvents(now);

    expect(stats.eventsDeleted).toBe(1);
    expect(await Event.countDocuments({ projectId })).toBe(0);
    expect(await Event.countDocuments({ projectId: otherProjectId })).toBe(1);
  });

  it('leaves everything inside the retention window alone', async () => {
    const now = new Date('2024-06-14T12:00:00Z');
    await insertEvents([
      { projectId, timestamp: new Date('2024-06-01T10:00:00Z'), sessionId: 'recent' },
    ]);
    await rollupDay(new Date('2024-06-01T00:00:00Z'));

    const stats = await pruneOldEvents(now);
    expect(stats.eventsDeleted).toBe(0);
    expect(await Event.countDocuments({})).toBe(1);
  });

  it('is a no-op on an empty collection', async () => {
    const stats = await pruneOldEvents(new Date('2024-06-14T12:00:00Z'));
    expect(stats.eventsDeleted).toBe(0);
    expect(stats.batches).toBe(0);
  });

  it('logs how much it processed and how long it took', async () => {
    const stats = await pruneOldEvents(new Date('2024-06-14T12:00:00Z'));
    expect(stats).toHaveProperty('durationMs');
    expect(stats).toHaveProperty('cutoff');
  });
});
