import { Event } from '@pulse/shared/models';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import { getRedis } from './redis.js';
import { EventBuffer } from './ingest/eventBuffer.js';
import { RateLimiter } from './ingest/rateLimit.js';
import { ProjectCache } from './ingest/projectCache.js';
import type { PreparedEvent } from './ingest/collectRouter.js';

const log = createLogger('services');

export interface Services {
  buffer: EventBuffer<PreparedEvent>;
  rateLimiter: RateLimiter;
  projectCache: ProjectCache;
}

/**
 * Wires the ingestion primitives together. Kept separate from the Express app
 * so tests can construct an app with fakes, and so `close()` has one owner.
 */
export function buildServices(overrides: Partial<Services> = {}): Services {
  const cfg = getConfig();

  const buffer =
    overrides.buffer ??
    new EventBuffer<PreparedEvent>({
      maxSize: cfg.INGEST_BUFFER_MAX_SIZE,
      maxAgeMs: cfg.INGEST_BUFFER_MAX_AGE_MS,
      logger: createLogger('ingest:buffer'),
      flushFn: async (batch) => {
        // `ordered: false` lets the server keep going past a single bad
        // document instead of abandoning the rest of the batch — one malformed
        // event should cost one event, not 499 others.
        await Event.insertMany(batch, { ordered: false, lean: true });
      },
    });

  const rateLimiter =
    overrides.rateLimiter ??
    new RateLimiter({
      redis: getRedis(),
      limit: cfg.RATE_LIMIT_MAX,
      windowMs: cfg.RATE_LIMIT_WINDOW_MS,
      logger: createLogger('ingest:ratelimit'),
    });

  const projectCache = overrides.projectCache ?? new ProjectCache();

  log.info('services constructed', {
    bufferMaxSize: cfg.INGEST_BUFFER_MAX_SIZE,
    bufferMaxAgeMs: cfg.INGEST_BUFFER_MAX_AGE_MS,
    rateLimit: `${cfg.RATE_LIMIT_MAX}/${cfg.RATE_LIMIT_WINDOW_MS}ms`,
  });

  return { buffer, rateLimiter, projectCache };
}
