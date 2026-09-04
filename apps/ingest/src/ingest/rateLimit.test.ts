import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from './rateLimit.js';
import type { RedisClient } from '../redis.js';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/**
 * `ioredis-mock` runs the real Lua script through a Lua interpreter, so these
 * exercise the actual atomic script rather than a JavaScript reimplementation
 * of it. That matters: the script *is* the rate limiter.
 */
function makeLimiter(options: { limit?: number; windowMs?: number; failOpen?: boolean } = {}) {
  const redis = new RedisMock() as unknown as RedisClient;
  return new RateLimiter({
    redis,
    limit: options.limit ?? 100,
    windowMs: options.windowMs ?? 10_000,
    ...(options.failOpen !== undefined ? { failOpen: options.failOpen } : {}),
    logger: silentLogger,
    keyPrefix: `rl:test:${Math.random()}:`,
  });
}

describe('within the limit', () => {
  it('allows requests up to the limit and reports remaining', async () => {
    const limiter = makeLimiter({ limit: 5 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await limiter.check('key'));

    expect(results.every((r) => r.allowed)).toBe(true);
    expect(results.map((r) => r.remaining)).toEqual([4, 3, 2, 1, 0]);
    expect(results[4]?.count).toBe(5);
  });
});

describe('over the limit', () => {
  let limiter: RateLimiter;

  beforeEach(async () => {
    limiter = makeLimiter({ limit: 3, windowMs: 10_000 });
    for (let i = 0; i < 3; i++) await limiter.check('key');
  });

  it('rejects the next request', async () => {
    const result = await limiter.check('key');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('returns a Retry-After of at least one second', async () => {
    const result = await limiter.check('key');
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(10);
  });

  it('does not count rejected requests against the window', async () => {
    // Hammering while blocked must not extend the block. If rejections were
    // recorded, the window would never drain for a client that keeps retrying.
    for (let i = 0; i < 50; i++) await limiter.check('key');

    // One past the window, exactly the original 3 have expired and we are open.
    const result = await limiter.check('key', Date.now() + 10_001);
    expect(result.allowed).toBe(true);
  });
});

describe('the sliding window', () => {
  it('admits a new request once the oldest falls out of the window', async () => {
    const limiter = makeLimiter({ limit: 2, windowMs: 10_000 });
    const t0 = 1_700_000_000_000;

    expect((await limiter.check('key', t0)).allowed).toBe(true);
    expect((await limiter.check('key', t0 + 5_000)).allowed).toBe(true);
    expect((await limiter.check('key', t0 + 6_000)).allowed).toBe(false);

    // t0's entry has now aged out; the t0+5000 one has not.
    expect((await limiter.check('key', t0 + 10_001)).allowed).toBe(true);
    expect((await limiter.check('key', t0 + 10_002)).allowed).toBe(false);
  });

  it('does not permit a double burst across a boundary, unlike a fixed window', async () => {
    // This is the specific failure a fixed-window counter has: 2 at the end of
    // one window plus 2 at the start of the next is 4 requests in 2ms.
    const limiter = makeLimiter({ limit: 2, windowMs: 10_000 });
    const t0 = 1_700_000_000_000;

    await limiter.check('key', t0 + 9_998);
    await limiter.check('key', t0 + 9_999);

    expect((await limiter.check('key', t0 + 10_000)).allowed).toBe(false);
    expect((await limiter.check('key', t0 + 10_001)).allowed).toBe(false);
  });
});

describe('isolation', () => {
  it('tracks each API key independently', async () => {
    const limiter = makeLimiter({ limit: 2 });
    await limiter.check('key-a');
    await limiter.check('key-a');

    expect((await limiter.check('key-a')).allowed).toBe(false);
    expect((await limiter.check('key-b')).allowed).toBe(true);
  });

  it('counts two requests in the same millisecond separately', async () => {
    // Members are unique per request, so identical timestamps do not collapse
    // into one sorted-set entry.
    const limiter = makeLimiter({ limit: 3 });
    const t = 1_700_000_000_000;
    const results = [
      await limiter.check('key', t),
      await limiter.check('key', t),
      await limiter.check('key', t),
      await limiter.check('key', t),
    ];
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
  });
});

describe('when Redis is unavailable', () => {
  const brokenRedis = {
    eval: async () => {
      throw new Error('ECONNREFUSED');
    },
  } as unknown as RedisClient;

  it('fails open by default, so a cache outage does not stop ingestion', async () => {
    const limiter = new RateLimiter({ redis: brokenRedis, limit: 5, logger: silentLogger });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
  });

  it('can be configured to fail closed', async () => {
    const limiter = new RateLimiter({
      redis: brokenRedis,
      limit: 5,
      failOpen: false,
      logger: silentLogger,
    });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('the production defaults', () => {
  it('is 100 requests per 10 seconds', async () => {
    const limiter = makeLimiter();
    const t = 1_700_000_000_000;
    for (let i = 0; i < 100; i++) {
      expect((await limiter.check('key', t + i)).allowed).toBe(true);
    }
    expect((await limiter.check('key', t + 100)).allowed).toBe(false);
  });
});
