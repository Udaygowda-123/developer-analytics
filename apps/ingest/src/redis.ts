import { Redis } from 'ioredis';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('redis');

export type RedisClient = Redis;

let client: RedisClient | null = null;

export function getRedis(): RedisClient {
  if (client) return client;

  const instance = new Redis(getConfig().REDIS_URL, {
    // The rate limiter runs on the hot path. If Redis is briefly unavailable we
    // want the command to fail fast and the caller to decide (we fail *open* —
    // see rateLimit.ts) rather than queue commands and stall ingestion.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    lazyConnect: false,
  });

  instance.on('error', (err: unknown) => {
    // ioredis emits on every reconnect attempt; log it, never throw — an
    // unhandled 'error' event on a Redis client takes the whole process down.
    log.warn('redis client error', { message: err instanceof Error ? err.message : String(err) });
  });
  instance.on('connect', () => log.info('redis connected'));

  client = instance;
  return instance;
}

/** Test/shutdown hook. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  try {
    await c.quit();
  } catch {
    c.disconnect();
  }
}

export function setRedisForTesting(mock: RedisClient | null): void {
  client = mock;
}
