import RedisMock from 'ioredis-mock';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { Types } from 'mongoose';
import { Event } from '@pulse/shared/models';
import { computeSessionId } from '@pulse/shared/server';
import { clearTestMongo, startTestMongo, stopTestMongo } from '../../test/mongo.js';
import { createTestProject, createTestUser } from '../../test/fixtures.js';
import { createApp } from '../app.js';
import { buildServices, type Services } from '../services.js';
import { getConfig } from '../config.js';
import { setRedisForTesting, type RedisClient } from '../redis.js';
import { EventBuffer } from './eventBuffer.js';
import { RateLimiter } from './rateLimit.js';
import { ProjectCache } from './projectCache.js';
import type { PreparedEvent } from './collectRouter.js';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let app: Express;
let services: Services;
let apiKey: string;
let projectId: Types.ObjectId;

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
  const project = await createTestProject(user._id as Types.ObjectId, { domain: 'example.com' });
  apiKey = project.apiKey;
  projectId = project._id;

  services = buildServices({
    // A tiny buffer so tests can assert flush behaviour without pushing 500
    // events, and a rate limiter on the mock Redis.
    buffer: new EventBuffer<PreparedEvent>({
      maxSize: 500,
      maxAgeMs: 50,
      flushFn: async (batch) => {
        await Event.insertMany(batch, { ordered: false });
      },
    }),
    rateLimiter: new RateLimiter({
      redis: new RedisMock() as unknown as RedisClient,
      limit: 100,
      windowMs: 10_000,
      keyPrefix: `rl:test:${Math.random()}:`,
    }),
    projectCache: new ProjectCache(),
  });
  app = createApp(services);
});

afterEach(async () => {
  await services.buffer.close();
});

/** Wait for the buffer's age-based flush to land the events in Mongo. */
async function waitForFlush(): Promise<void> {
  await services.buffer.flush();
}

describe('authentication', () => {
  it('accepts the key in the body', async () => {
    const res = await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 1 });
  });

  it('accepts the key in the X-Pulse-Key header', async () => {
    const res = await request(app)
      .post('/collect')
      .set('X-Pulse-Key', apiKey)
      .set('user-agent', CHROME_UA)
      .send({ path: '/' });
    expect(res.status).toBe(202);
  });

  it('rejects a missing key with 401', async () => {
    const res = await request(app).post('/collect').set('user-agent', CHROME_UA).send({ path: '/' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects an unknown but well-formed key with 401', async () => {
    const res = await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey: `pk_live_${'a'.repeat(32)}`, path: '/' });
    expect(res.status).toBe(401);
  });
});

describe('validation', () => {
  it('rejects a malformed payload with 400 and field-level details', async () => {
    const res = await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, type: 'not-a-type' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'path' })]),
    );
  });

  it('rejects a malformed API key before touching the database', async () => {
    const res = await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey: 'nope', path: '/' });
    expect(res.status).toBe(400);
  });

  it('caps the size of meta', async () => {
    const meta = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    const res = await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/', type: 'custom', name: 'x', meta });
    expect(res.status).toBe(400);
  });
});

describe('the response contract', () => {
  it('returns 202 without waiting for the database write', async () => {
    const before = await Event.countDocuments({});
    const res = await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/' });

    expect(res.status).toBe(202);
    // The event is in the buffer, not yet in Mongo — this is the whole point.
    expect(await Event.countDocuments({})).toBe(before);
    expect(services.buffer.size).toBe(1);

    await waitForFlush();
    expect(await Event.countDocuments({})).toBe(before + 1);
  });
});

describe('event enrichment', () => {
  it('derives device, browser and OS from the User-Agent', async () => {
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/pricing' });
    await waitForFlush();

    const event = await Event.findOne({ projectId }).lean();
    expect(event).toMatchObject({
      device: 'desktop',
      browser: 'Chrome',
      os: 'macOS',
      path: '/pricing',
      type: 'pageview',
    });
  });

  it('derives country from a CDN header', async () => {
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .set('cf-ipcountry', 'de')
      .send({ apiKey, path: '/' });
    await waitForFlush();

    expect((await Event.findOne({ projectId }).lean())?.country).toBe('DE');
  });

  it('stores only the referrer host, never its query string', async () => {
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/', referrer: 'https://www.google.com/search?q=private+query' });
    await waitForFlush();

    const event = await Event.findOne({ projectId }).lean();
    expect(event?.referrer).toBe('google.com');
  });

  it('drops self-referrals', async () => {
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/b', referrer: 'https://example.com/a' });
    await waitForFlush();

    expect((await Event.findOne({ projectId }).lean())?.referrer).toBeNull();
  });

  it('strips the query string from the path', async () => {
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/checkout?token=secret' });
    await waitForFlush();

    expect((await Event.findOne({ projectId }).lean())?.path).toBe('/checkout');
  });
});

describe('session identity', () => {
  it('assigns the documented cookieless hash and never stores the IP', async () => {
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .set('x-forwarded-for', '203.0.113.7')
      .send({ apiKey, path: '/' });
    await waitForFlush();

    const event = await Event.findOne({ projectId }).lean();
    const expected = computeSessionId({
      ip: '203.0.113.7',
      userAgent: CHROME_UA,
      projectId: String(projectId),
      date: new Date(),
      secret: getConfig().PULSE_SESSION_SECRET,
    });

    expect(event?.sessionId).toBe(expected);
    expect(JSON.stringify(event)).not.toContain('203.0.113.7');
  });

  it('gives the same visitor one session across requests', async () => {
    for (const path of ['/', '/pricing', '/docs']) {
      await request(app)
        .post('/collect')
        .set('user-agent', CHROME_UA)
        .set('x-forwarded-for', '203.0.113.7')
        .send({ apiKey, path });
    }
    await waitForFlush();

    const sessions = await Event.distinct('sessionId', { projectId });
    expect(sessions).toHaveLength(1);
  });

  it('gives different visitors different sessions', async () => {
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .set('x-forwarded-for', '203.0.113.7')
      .send({ apiKey, path: '/' });
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .set('x-forwarded-for', '198.51.100.4')
      .send({ apiKey, path: '/' });
    await waitForFlush();

    expect(await Event.distinct('sessionId', { projectId })).toHaveLength(2);
  });
});

describe('bot traffic', () => {
  it('acknowledges but does not record crawler hits', async () => {
    const res = await request(app)
      .post('/collect')
      .set('user-agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')
      .send({ apiKey, path: '/' });

    expect(res.status).toBe(202);
    expect(res.body.ignored).toBe('bot');
    await waitForFlush();
    expect(await Event.countDocuments({ projectId })).toBe(0);
  });
});

describe('batching', () => {
  it('accepts a batch of events in one request', async () => {
    const res = await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({
        apiKey,
        events: [
          { path: '/', type: 'pageview' },
          { path: '/pricing', type: 'pageview' },
          { path: '/', type: 'custom', name: 'signup' },
        ],
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(3);
    await waitForFlush();
    expect(await Event.countDocuments({ projectId })).toBe(3);
  });

  it('shares one sessionId across a batch', async () => {
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, events: [{ path: '/a' }, { path: '/b' }] });
    await waitForFlush();

    expect(await Event.distinct('sessionId', { projectId })).toHaveLength(1);
  });
});

describe('client timestamps', () => {
  it('honours a plausible client timestamp', async () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/', timestamp: ts });
    await waitForFlush();

    expect((await Event.findOne({ projectId }).lean())?.timestamp?.toISOString()).toBe(ts);
  });

  it('ignores a timestamp far in the future, which would poison the graph', async () => {
    const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/', timestamp: future });
    await waitForFlush();

    const stored = (await Event.findOne({ projectId }).lean())?.timestamp as Date;
    expect(stored.getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it('ignores a timestamp far in the past, which would backfill history', async () => {
    const ancient = new Date('2001-01-01T00:00:00Z').toISOString();
    await request(app)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/', timestamp: ancient });
    await waitForFlush();

    const stored = (await Event.findOne({ projectId }).lean())?.timestamp as Date;
    expect(stored.getUTCFullYear()).toBeGreaterThan(2020);
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the window is full', async () => {
    services = buildServices({
      buffer: new EventBuffer<PreparedEvent>({ maxSize: 500, maxAgeMs: 50, flushFn: async () => {} }),
      rateLimiter: new RateLimiter({
        redis: new RedisMock() as unknown as RedisClient,
        limit: 3,
        windowMs: 10_000,
        keyPrefix: `rl:burst:${Math.random()}:`,
      }),
      projectCache: new ProjectCache(),
    });
    const limitedApp = createApp(services);

    for (let i = 0; i < 3; i++) {
      const ok = await request(limitedApp)
        .post('/collect')
        .set('user-agent', CHROME_UA)
        .send({ apiKey, path: '/' });
      expect(ok.status).toBe(202);
    }

    const blocked = await request(limitedApp)
      .post('/collect')
      .set('user-agent', CHROME_UA)
      .send({ apiKey, path: '/' });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(blocked.headers['x-ratelimit-limit']).toBe('3');
  });
});

describe('the GET fallback', () => {
  it('accepts a base64url-encoded payload', async () => {
    const payload = Buffer.from(JSON.stringify({ apiKey, path: '/beacon' })).toString('base64url');
    const res = await request(app)
      .get(`/collect?d=${payload}`)
      .set('user-agent', CHROME_UA);

    expect(res.status).toBe(202);
    await waitForFlush();
    expect((await Event.findOne({ projectId }).lean())?.path).toBe('/beacon');
  });

  it('rejects a malformed payload', async () => {
    const res = await request(app).get('/collect?d=%%%notbase64').set('user-agent', CHROME_UA);
    expect(res.status).toBe(400);
  });
});

describe('the health endpoint', () => {
  it('reports buffer and cache statistics', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.buffer).toHaveProperty('buffered');
    expect(res.body.projectCache).toHaveProperty('hitRate');
  });
});

describe('the project cache', () => {
  it('resolves a key from the database once, then from memory', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post('/collect').set('user-agent', CHROME_UA).send({ apiKey, path: '/' });
    }
    const stats = services.projectCache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(4);
  });
});
