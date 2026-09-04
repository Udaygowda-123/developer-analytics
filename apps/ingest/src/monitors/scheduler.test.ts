import RedisMock from 'ioredis-mock';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { Check, Monitor } from '@pulse/shared/models';
import { clearTestMongo, startTestMongo, stopTestMongo } from '../../test/mongo.js';
import { createTestProject, createTestUser } from '../../test/fixtures.js';
import { setRedisForTesting, type RedisClient } from '../redis.js';
import { setMailerForTesting } from '../alerts/mailer.js';
import { resetSweepGuardForTesting, sweepDueMonitors } from './scheduler.js';
import { runCheck } from './checkRunner.js';
import { getDailyUptime, getRecentIncidents, getUptimeWindows } from './uptimeService.js';

let projectId: Types.ObjectId;

beforeAll(async () => {
  await startTestMongo();
});

afterAll(async () => {
  setMailerForTesting(null);
  await stopTestMongo();
});

beforeEach(async () => {
  await clearTestMongo();
  resetSweepGuardForTesting();
  setRedisForTesting(new RedisMock() as unknown as RedisClient);
  setMailerForTesting({ async send() { return { id: null, delivered: false }; } });

  const user = await createTestUser();
  projectId = (await createTestProject(user._id as Types.ObjectId))._id;
});

function makeMonitor(overrides: Record<string, unknown> = {}) {
  return Monitor.create({
    projectId,
    name: 'Test',
    url: 'https://example.com',
    intervalSeconds: 60,
    expectedStatus: 200,
    ...overrides,
  });
}

describe('runCheck', () => {
  it('records a success when the status matches', async () => {
    const fetchImpl = (async () =>
      new Response('ok', { status: 200 })) as unknown as typeof fetch;

    const outcome = await runCheck({ url: 'https://x.test', expectedStatus: 200, fetchImpl });
    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(200);
    expect(outcome.error).toBeNull();
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records a failure when the status differs, with an explanatory error', async () => {
    const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;

    const outcome = await runCheck({ url: 'https://x.test', expectedStatus: 200, fetchImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBe(503);
    expect(outcome.error).toBe('Expected status 200, received 503');
  });

  it('honours a non-200 expected status', async () => {
    const fetchImpl = (async () => new Response('', { status: 301 })) as unknown as typeof fetch;
    const outcome = await runCheck({ url: 'https://x.test', expectedStatus: 301, fetchImpl });
    expect(outcome.ok).toBe(true);
  });

  it('turns a timeout into a failed check rather than throwing', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;

    const outcome = await runCheck({
      url: 'https://x.test',
      expectedStatus: 200,
      timeoutMs: 50,
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBeNull();
    expect(outcome.error).toContain('timed out');
  });

  it('unwraps the underlying cause of a network error', async () => {
    const fetchImpl = (async () => {
      const cause = Object.assign(new Error('getaddrinfo ENOTFOUND nope.test'), { code: 'ENOTFOUND' });
      throw new Error('fetch failed', { cause });
    }) as unknown as typeof fetch;

    const outcome = await runCheck({ url: 'https://nope.test', expectedStatus: 200, fetchImpl });
    // "fetch failed" alone would be useless in an alert email.
    expect(outcome.error).toContain('ENOTFOUND');
    expect(outcome.error).not.toBe('fetch failed');
  });
});

describe('the due query', () => {
  it('checks a monitor that has never been checked', async () => {
    await makeMonitor({ lastCheckedAt: null });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    const stats = await sweepDueMonitors();
    expect(stats.due).toBe(1);
    expect(stats.checked).toBe(1);
    spy.mockRestore();
  });

  it('skips a monitor checked more recently than its interval', async () => {
    await makeMonitor({ intervalSeconds: 300, lastCheckedAt: new Date(Date.now() - 60_000) });
    const stats = await sweepDueMonitors();
    expect(stats.due).toBe(0);
  });

  it('checks a monitor whose interval has elapsed', async () => {
    await makeMonitor({ intervalSeconds: 60, lastCheckedAt: new Date(Date.now() - 61_000) });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    const stats = await sweepDueMonitors();
    expect(stats.due).toBe(1);
    spy.mockRestore();
  });

  it('respects each monitor’s own interval in the same sweep', async () => {
    // 900s monitor is not due; 60s monitor is. A constant cutoff would get
    // this wrong, which is why the query uses $expr.
    await makeMonitor({ intervalSeconds: 900, lastCheckedAt: new Date(Date.now() - 120_000) });
    await makeMonitor({ intervalSeconds: 60, lastCheckedAt: new Date(Date.now() - 120_000) });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    const stats = await sweepDueMonitors();
    expect(stats.due).toBe(1);
    spy.mockRestore();
  });

  it('never checks a paused monitor', async () => {
    await makeMonitor({ isPaused: true, lastCheckedAt: null });
    const stats = await sweepDueMonitors();
    expect(stats.due).toBe(0);
  });
});

describe('recording results', () => {
  it('writes a Check and advances lastCheckedAt', async () => {
    const monitor = await makeMonitor({ lastCheckedAt: null });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await sweepDueMonitors();

    const check = await Check.findOne({ monitorId: monitor._id }).lean();
    expect(check).toMatchObject({ ok: true, statusCode: 200 });

    const updated = await Monitor.findById(monitor._id).lean();
    expect(updated?.lastCheckedAt).toBeInstanceOf(Date);
    expect(updated?.lastStatusOk).toBe(true);
    spy.mockRestore();
  });

  it('increments the failure counter on a failure and resets it on success', async () => {
    const monitor = await makeMonitor({ lastCheckedAt: null });

    const failing = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await sweepDueMonitors();
    await Monitor.updateOne({ _id: monitor._id }, { $set: { lastCheckedAt: new Date(0) } });
    await sweepDueMonitors();
    failing.mockRestore();

    expect((await Monitor.findById(monitor._id).lean())?.consecutiveFailures).toBe(2);

    await Monitor.updateOne({ _id: monitor._id }, { $set: { lastCheckedAt: new Date(0) } });
    const passing = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    await sweepDueMonitors();
    passing.mockRestore();

    expect((await Monitor.findById(monitor._id).lean())?.consecutiveFailures).toBe(0);
  });

  it('advances lastCheckedAt even when the check fails, so it cannot get stuck due', async () => {
    const monitor = await makeMonitor({ lastCheckedAt: null });
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));

    await sweepDueMonitors();
    spy.mockRestore();

    const updated = await Monitor.findById(monitor._id).lean();
    expect(updated?.lastCheckedAt).toBeInstanceOf(Date);
    expect(updated?.lastStatusOk).toBe(false);
  });
});

describe('bounded concurrency in a real sweep', () => {
  it('never has more than the pool size of checks in flight', async () => {
    for (let i = 0; i < 30; i++) await makeMonitor({ lastCheckedAt: null, name: `m${i}` });

    let inFlight = 0;
    let peak = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return new Response('', { status: 200 });
    });

    const stats = await sweepDueMonitors();
    spy.mockRestore();

    expect(stats.checked).toBe(30);
    expect(peak).toBeLessThanOrEqual(10);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('overlap protection', () => {
  it('skips a sweep while the previous one is still running', async () => {
    await makeMonitor({ lastCheckedAt: null });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response('', { status: 200 });
    });

    const [first, second] = await Promise.all([sweepDueMonitors(), sweepDueMonitors()]);
    spy.mockRestore();

    // One of the two did the work; the other found the guard held.
    const totals = [first.checked, second.checked].sort();
    expect(totals).toEqual([0, 1]);
  });
});

describe('uptime aggregations', () => {
  async function seedChecks(monitorId: Types.ObjectId, specs: Array<{ agoMs: number; ok: boolean; latencyMs?: number }>) {
    await Check.insertMany(
      specs.map((s) => ({
        monitorId,
        ok: s.ok,
        statusCode: s.ok ? 200 : 500,
        latencyMs: s.latencyMs ?? 100,
        error: s.ok ? null : 'failed',
        timestamp: new Date(Date.now() - s.agoMs),
      })),
    );
  }

  it('computes uptime across all three windows in one pass', async () => {
    const monitor = await makeMonitor();
    await seedChecks(monitor._id, [
      // Inside 24h: 3 checks, 1 failure -> 66.666%
      { agoMs: 1 * 3_600_000, ok: true },
      { agoMs: 2 * 3_600_000, ok: false },
      { agoMs: 3 * 3_600_000, ok: true },
      // Inside 7d but outside 24h
      { agoMs: 3 * 86_400_000, ok: true },
      { agoMs: 4 * 86_400_000, ok: true },
      // Inside 30d but outside 7d
      { agoMs: 15 * 86_400_000, ok: true },
      // Outside 30d — must be excluded everywhere
      { agoMs: 45 * 86_400_000, ok: false },
    ]);

    const windows = await getUptimeWindows(monitor._id);
    const byWindow = Object.fromEntries(windows.map((w) => [w.window, w]));

    expect(byWindow['24h']).toMatchObject({ totalChecks: 3, failedChecks: 1, uptimePct: 66.666 });
    expect(byWindow['7d']).toMatchObject({ totalChecks: 5, failedChecks: 1, uptimePct: 80 });
    expect(byWindow['30d']).toMatchObject({ totalChecks: 6, failedChecks: 1 });
  });

  it('averages latency over successful checks only', async () => {
    const monitor = await makeMonitor();
    await seedChecks(monitor._id, [
      { agoMs: 1_000, ok: true, latencyMs: 100 },
      { agoMs: 2_000, ok: true, latencyMs: 200 },
      // A 10s timeout would drag the average to 3433ms and make a healthy
      // service look slow.
      { agoMs: 3_000, ok: false, latencyMs: 10_000 },
    ]);

    const windows = await getUptimeWindows(monitor._id);
    expect(windows.find((w) => w.window === '24h')?.avgLatencyMs).toBe(150);
  });

  it('reports zero rather than throwing with no checks', async () => {
    const monitor = await makeMonitor();
    const windows = await getUptimeWindows(monitor._id);
    expect(windows.every((w) => w.totalChecks === 0 && w.avgLatencyMs === null)).toBe(true);
  });

  it('returns a dense 90-day strip with gaps preserved', async () => {
    const monitor = await makeMonitor();
    await seedChecks(monitor._id, [
      { agoMs: 1 * 86_400_000, ok: true },
      { agoMs: 1 * 86_400_000, ok: false },
    ]);

    const daily = await getDailyUptime(monitor._id, 90);
    expect(daily).toHaveLength(90);
    // A day with no checks is null ("no data"), not 100%.
    expect(daily[0]?.uptimePct).toBeNull();
    const withData = daily.filter((d) => d.totalChecks > 0);
    expect(withData).toHaveLength(1);
    expect(withData[0]?.uptimePct).toBe(50);
  });

  it('derives incidents from contiguous runs of failure', async () => {
    const monitor = await makeMonitor();
    await seedChecks(monitor._id, [
      { agoMs: 600_000, ok: true },
      { agoMs: 500_000, ok: false },
      { agoMs: 400_000, ok: false },
      { agoMs: 300_000, ok: true },
      { agoMs: 200_000, ok: true },
      { agoMs: 100_000, ok: false },
    ]);

    const incidents = await getRecentIncidents(monitor._id);
    expect(incidents).toHaveLength(2);
    // Newest first; the ongoing one has no end.
    expect(incidents[0]?.endedAt).toBeNull();
    expect(incidents[0]?.failedChecks).toBe(1);
    expect(incidents[1]?.endedAt).not.toBeNull();
    expect(incidents[1]?.failedChecks).toBe(2);
  });

  it('reports no incidents for a healthy monitor', async () => {
    const monitor = await makeMonitor();
    await seedChecks(monitor._id, [
      { agoMs: 200_000, ok: true },
      { agoMs: 100_000, ok: true },
    ]);
    expect(await getRecentIncidents(monitor._id)).toEqual([]);
  });
});
