import RedisMock from 'ioredis-mock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { Check, Monitor } from '@pulse/shared/models';
import { clearTestMongo, startTestMongo, stopTestMongo } from '../../test/mongo.js';
import { createTestProject, createTestUser } from '../../test/fixtures.js';
import { setRedisForTesting, type RedisClient } from '../redis.js';
import { setMailerForTesting, type SendEmailInput } from './mailer.js';
import { handleCheckResult, humaniseDuration } from './alertService.js';
import { claimAlertSlot, cooldownRemaining, releaseAlertSlot } from './cooldown.js';
import type { CheckOutcome } from '../monitors/checkRunner.js';

const FAIL: CheckOutcome = { statusCode: 500, latencyMs: 120, ok: false, error: 'Expected status 200, received 500' };
const PASS: CheckOutcome = { statusCode: 200, latencyMs: 95, ok: true, error: null };

let sent: SendEmailInput[] = [];
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
  setRedisForTesting(new RedisMock() as unknown as RedisClient);
  sent = [];
  setMailerForTesting({
    async send(input) {
      sent.push(input);
      return { id: 'msg_test', delivered: true };
    },
  });

  const user = await createTestUser({ email: 'owner@example.com' });
  projectId = (await createTestProject(user._id as Types.ObjectId))._id;
});

async function makeMonitor(consecutiveFailures = 0) {
  return Monitor.create({
    projectId,
    name: 'API',
    url: 'https://api.example.com/health',
    intervalSeconds: 60,
    expectedStatus: 200,
    consecutiveFailures,
  });
}

describe('the failure threshold', () => {
  it('stays silent for the first two failures', async () => {
    for (const failures of [1, 2]) {
      const monitor = await makeMonitor(failures);
      const result = await handleCheckResult({
        monitor,
        outcome: FAIL,
        previousConsecutiveFailures: failures - 1,
      });
      expect(result).toBe('none');
    }
    expect(sent).toHaveLength(0);
  });

  it('alerts on the third consecutive failure', async () => {
    const monitor = await makeMonitor(3);
    const result = await handleCheckResult({ monitor, outcome: FAIL, previousConsecutiveFailures: 2 });

    expect(result).toBe('sent_down');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('owner@example.com');
    expect(sent[0]?.subject).toContain('API');
    expect(sent[0]?.subject).toContain('down');
  });

  it('records when the alert was sent', async () => {
    const monitor = await makeMonitor(3);
    await handleCheckResult({ monitor, outcome: FAIL, previousConsecutiveFailures: 2 });

    const updated = await Monitor.findById(monitor._id).lean();
    expect(updated?.lastNotifiedAt).toBeInstanceOf(Date);
  });
});

describe('the cooldown', () => {
  it('sends at most one down alert per monitor per window', async () => {
    const monitor = await makeMonitor(3);

    // Ten consecutive failing sweeps.
    for (let i = 0; i < 10; i++) {
      monitor.consecutiveFailures = 3 + i;
      await handleCheckResult({ monitor, outcome: FAIL, previousConsecutiveFailures: 2 + i });
    }

    expect(sent).toHaveLength(1);
  });

  it('reports the remaining cooldown', async () => {
    const monitor = await makeMonitor(3);
    await handleCheckResult({ monitor, outcome: FAIL, previousConsecutiveFailures: 2 });

    const remaining = await cooldownRemaining(String(monitor._id), 'down');
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(3600);
  });

  it('is claimed atomically — only the first caller wins', async () => {
    const id = new Types.ObjectId().toHexString();
    // Concurrent claims, as two instances or two overlapping sweeps would make.
    const claims = await Promise.all([
      claimAlertSlot(id, 'down', 60),
      claimAlertSlot(id, 'down', 60),
      claimAlertSlot(id, 'down', 60),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('tracks down and recovered cooldowns separately', async () => {
    const id = new Types.ObjectId().toHexString();
    expect(await claimAlertSlot(id, 'down', 60)).toBe(true);
    // A recovery email must not be blocked by the down cooldown.
    expect(await claimAlertSlot(id, 'recovered', 60)).toBe(true);
  });

  it('can be released so a later incident alerts immediately', async () => {
    const id = new Types.ObjectId().toHexString();
    await claimAlertSlot(id, 'down', 3600);
    expect(await claimAlertSlot(id, 'down', 3600)).toBe(false);

    await releaseAlertSlot(id, 'down');
    expect(await claimAlertSlot(id, 'down', 3600)).toBe(true);
  });
});

describe('recovery', () => {
  it('sends a recovery email after an alerted outage ends', async () => {
    const monitor = await makeMonitor(0);
    await Check.create([
      { monitorId: monitor._id, ok: false, latencyMs: 1, statusCode: 500, timestamp: new Date(Date.now() - 300_000) },
      { monitorId: monitor._id, ok: false, latencyMs: 1, statusCode: 500, timestamp: new Date(Date.now() - 200_000) },
      { monitorId: monitor._id, ok: false, latencyMs: 1, statusCode: 500, timestamp: new Date(Date.now() - 100_000) },
    ]);

    const result = await handleCheckResult({ monitor, outcome: PASS, previousConsecutiveFailures: 3 });

    expect(result).toBe('sent_recovered');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('recovered');
  });

  it('does not send a recovery for a blip that never alerted', async () => {
    const monitor = await makeMonitor(0);
    // Two failures then a success: nobody was ever told it was down.
    const result = await handleCheckResult({ monitor, outcome: PASS, previousConsecutiveFailures: 2 });

    expect(result).toBe('none');
    expect(sent).toHaveLength(0);
  });

  it('does nothing on a routine successful check', async () => {
    const monitor = await makeMonitor(0);
    const result = await handleCheckResult({ monitor, outcome: PASS, previousConsecutiveFailures: 0 });
    expect(result).toBe('none');
    expect(sent).toHaveLength(0);
  });

  it('lets a new outage alert immediately after a recovery', async () => {
    const monitor = await makeMonitor(3);

    await handleCheckResult({ monitor, outcome: FAIL, previousConsecutiveFailures: 2 });
    expect(sent).toHaveLength(1);

    monitor.consecutiveFailures = 0;
    await handleCheckResult({ monitor, outcome: PASS, previousConsecutiveFailures: 3 });
    expect(sent).toHaveLength(2);

    // A fresh incident 10 minutes later must not be swallowed by the first
    // incident's remaining cooldown.
    monitor.consecutiveFailures = 3;
    const result = await handleCheckResult({ monitor, outcome: FAIL, previousConsecutiveFailures: 2 });

    expect(result).toBe('sent_down');
    expect(sent).toHaveLength(3);
  });
});

describe('delivery failures', () => {
  it('releases the cooldown slot so the next sweep can retry', async () => {
    setMailerForTesting({
      async send() {
        throw new Error('Resend is down');
      },
    });

    const monitor = await makeMonitor(3);
    const result = await handleCheckResult({ monitor, outcome: FAIL, previousConsecutiveFailures: 2 });

    expect(result).toBe('none');
    // Slot released: an email that was never delivered must not consume an
    // hour of cooldown.
    expect(await cooldownRemaining(String(monitor._id), 'down')).toBe(0);
  });
});

describe('email content', () => {
  it('includes the error and the URL', async () => {
    const monitor = await makeMonitor(3);
    await Check.create({ monitorId: monitor._id, ok: false, latencyMs: 1, statusCode: 500, timestamp: new Date() });
    await handleCheckResult({ monitor, outcome: FAIL, previousConsecutiveFailures: 2 });

    const { render } = await import('@react-email/components');
    const html = await render(sent[0]!.body);

    expect(html).toContain('https://api.example.com/health');
    expect(html).toContain('received 500');
    expect(html).toContain('API');
  });
});

describe('humaniseDuration', () => {
  it.each([
    [0, '0 seconds'],
    [1_000, '1 second'],
    [45_000, '45 seconds'],
    [60_000, '1 minute'],
    [600_000, '10 minutes'],
    [3_600_000, '1 hour'],
    [5_400_000, '1h 30m'],
    [172_800_000, '2 days'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(humaniseDuration(ms)).toBe(expected);
  });
});
