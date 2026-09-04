
import { createLogger, type Logger } from '../logger.js';
import type { RedisClient } from '../redis.js';

/**
 * Per-API-key sliding window rate limiter backed by Redis.
 *
 * Default: 100 requests per 10 seconds per key.
 *
 * Implemented as a sorted set of request timestamps per key ("sliding window
 * log"). A fixed-window counter would be simpler, but it allows double the
 * intended burst across a window boundary — 100 requests at 9.99s and another
 * 100 at 10.01s is 200 requests in 20ms, which is exactly the spike the limit
 * exists to prevent. The log gives an exact count over the trailing window at
 * the cost of storing one member per request, which is bounded by the limit
 * itself plus the TTL.
 *
 * The whole check is one Lua script so it is atomic. Doing ZREMRANGEBYSCORE →
 * ZCARD → ZADD as three round trips would let concurrent requests each observe
 * a count below the limit and all be admitted.
 */

const SLIDING_WINDOW_SCRIPT = `
-- KEYS[1] = the sorted set for this API key
-- ARGV[1] = now (ms), ARGV[2] = window (ms), ARGV[3] = limit, ARGV[4] = unique member id
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

-- Evict entries that have fallen out of the trailing window.
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local count = redis.call('ZCARD', key)

if count >= limit then
  -- Over limit: do NOT record this request. Counting rejected requests would
  -- let a client that keeps hammering hold its own window permanently full.
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetMs = window
  if oldest[2] then
    resetMs = (tonumber(oldest[2]) + window) - now
    if resetMs < 0 then resetMs = 0 end
  end
  return { 0, count, resetMs }
end

redis.call('ZADD', key, now, member)
-- Expire the whole key one window after the last request, so idle keys cost
-- nothing and we never need a sweeper.
redis.call('PEXPIRE', key, window)

return { 1, count + 1, window }
`;

export interface RateLimitResult {
  allowed: boolean;
  /** Requests used in the current window, including this one when allowed. */
  count: number;
  limit: number;
  remaining: number;
  /** Seconds until the window has room again — the `Retry-After` value. */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  redis: RedisClient;
  limit?: number;
  windowMs?: number;
  keyPrefix?: string;
  logger?: Logger;
  /**
   * What to do when Redis itself is unavailable. Default is to fail *open*:
   * a Redis outage should not take analytics ingestion down with it. The buffer
   * and its `maxPending` ceiling remain as a second line of defence.
   */
  failOpen?: boolean;
}

export class RateLimiter {
  private readonly redis: RedisClient;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly keyPrefix: string;
  private readonly failOpen: boolean;
  private readonly log: Logger;
  private counter = 0;

  constructor(options: RateLimiterOptions) {
    this.redis = options.redis;
    this.limit = options.limit ?? 100;
    this.windowMs = options.windowMs ?? 10_000;
    this.keyPrefix = options.keyPrefix ?? 'rl:collect:';
    this.failOpen = options.failOpen ?? true;
    this.log = options.logger ?? createLogger('ingest:ratelimit');
  }

  /** Unique per request so two requests in the same millisecond both count. */
  private nextMember(now: number): string {
    this.counter = (this.counter + 1) % Number.MAX_SAFE_INTEGER;
    return `${now}-${this.counter}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async check(identifier: string, now: number = Date.now()): Promise<RateLimitResult> {
    const key = `${this.keyPrefix}${identifier}`;

    try {
      const raw = (await this.redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        key,
        String(now),
        String(this.windowMs),
        String(this.limit),
        this.nextMember(now),
      )) as [number, number, number];

      const [allowedFlag, count, resetMs] = raw;
      const allowed = allowedFlag === 1;
      return {
        allowed,
        count,
        limit: this.limit,
        remaining: Math.max(0, this.limit - count),
        // Always at least 1: a `Retry-After: 0` invites an immediate retry that
        // is guaranteed to be rejected again.
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(resetMs / 1000)),
      };
    } catch (err) {
      this.log.error('rate limit check failed', err, { identifier, failOpen: this.failOpen });
      if (this.failOpen) {
        return {
          allowed: true,
          count: 0,
          limit: this.limit,
          remaining: this.limit,
          retryAfterSeconds: 0,
        };
      }
      return {
        allowed: false,
        count: this.limit,
        limit: this.limit,
        remaining: 0,
        retryAfterSeconds: Math.ceil(this.windowMs / 1000),
      };
    }
  }
}
