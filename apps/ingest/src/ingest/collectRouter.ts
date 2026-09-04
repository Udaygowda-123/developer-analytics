import { Router, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import {
  ApiError,
  collectBatchSchema,
  collectEventSchema,
  zodErrorToApiError,
  type CollectEventInput,
} from '@pulse/shared';
import { computeSessionId } from '@pulse/shared/server';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import type { EventBuffer } from './eventBuffer.js';
import type { RateLimiter } from './rateLimit.js';
import type { ProjectCache } from './projectCache.js';
import { countryFromRequest, ipFromRequest, normalisePath, normaliseReferrer } from './geo.js';
import { parseUserAgent } from './userAgent.js';
import { touchSession } from '../realtime/activeSessions.js';

const log = createLogger('ingest:collect');

/** A prepared Event document, ready for insertMany. */
export interface PreparedEvent {
  projectId: Types.ObjectId;
  type: 'pageview' | 'custom';
  name: string;
  path: string;
  referrer: string | null;
  country: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  sessionId: string;
  timestamp: Date;
  meta: Record<string, unknown>;
}

export interface CollectRouterDeps {
  buffer: EventBuffer<PreparedEvent>;
  rateLimiter: RateLimiter;
  projectCache: ProjectCache;
}

/**
 * Client clocks are wrong more often than you would like. We accept a
 * client-supplied timestamp only within a sane window — far enough back to
 * cover a `sendBeacon` queued while offline, not far enough to let a caller
 * backfill or poison history.
 */
const MAX_CLOCK_SKEW_PAST_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_FUTURE_MS = 60 * 1000;

function resolveTimestamp(supplied: string | undefined, now: Date): Date {
  if (!supplied) return now;
  const parsed = new Date(supplied);
  if (Number.isNaN(parsed.getTime())) return now;
  const delta = parsed.getTime() - now.getTime();
  if (delta > MAX_CLOCK_SKEW_FUTURE_MS || delta < -MAX_CLOCK_SKEW_PAST_MS) return now;
  return parsed;
}

function extractApiKey(req: Request, bodyKey: string | undefined): string | null {
  const header = req.header('x-pulse-key');
  return (header?.trim() || bodyKey || null) ?? null;
}

export function createCollectRouter(deps: CollectRouterDeps): Router {
  const router = Router();
  const cfg = getConfig();

  /**
   * POST /collect
   *
   * The hot path. Everything here is synchronous and in-memory apart from the
   * rate-limit check; the response is sent before any database work happens.
   */
  const handler = asyncHandler(async (req: Request, res: Response) => {
    const now = new Date();

    // Accept both a single event and a batch (the snippet batches on unload).
    const isBatch = Array.isArray((req.body as { events?: unknown })?.events);
    const parsed = isBatch
      ? collectBatchSchema.safeParse(req.body)
      : collectEventSchema.safeParse(req.body);

    if (!parsed.success) {
      throw zodErrorToApiError(parsed.error, 'Invalid event payload');
    }

    const apiKey = extractApiKey(req, parsed.data.apiKey);
    if (!apiKey) {
      throw ApiError.unauthorized('Missing API key: send X-Pulse-Key or `apiKey` in the body');
    }

    // Rate limit before resolving the project: an invalid key hammering us
    // should be cheap to reject, and the limiter is the cheaper of the two.
    const limit = await deps.rateLimiter.check(apiKey);
    res.setHeader('X-RateLimit-Limit', String(limit.limit));
    res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      throw ApiError.rateLimited(
        `Rate limit of ${limit.limit} requests per ${cfg.RATE_LIMIT_WINDOW_MS / 1000}s exceeded`,
      );
    }

    const project = await deps.projectCache.resolve(apiKey);
    if (!project) {
      throw ApiError.unauthorized('Unknown API key');
    }

    const userAgent = req.header('user-agent') ?? '';
    const ua = parseUserAgent(userAgent, (req.body as { screenWidth?: number }).screenWidth);

    // Bots are acknowledged and dropped. Returning 202 rather than an error is
    // deliberate: a crawler that gets a 4xx may retry, and there is nothing for
    // it to fix. Counting them would inflate every customer's traffic graph.
    if (ua.isBot) {
      res.status(202).json({ accepted: 0, ignored: 'bot' });
      return;
    }

    const country = countryFromRequest(req);
    const ip = ipFromRequest(req);
    const projectObjectId = new Types.ObjectId(project.id);

    // One sessionId per request: the hash is stable for this visitor for the
    // rest of the UTC day, so a batch shares it.
    const sessionId = computeSessionId({
      ip,
      userAgent,
      projectId: project.id,
      date: now,
      secret: cfg.PULSE_SESSION_SECRET,
    });

    const inputs: CollectEventInput[] = isBatch
      ? (parsed.data as { events: CollectEventInput[] }).events
      : [parsed.data as CollectEventInput];

    let accepted = 0;
    for (const input of inputs) {
      const path = normalisePath(input.path);
      const prepared: PreparedEvent = {
        projectId: projectObjectId,
        type: input.type,
        name: input.name ?? (input.type === 'pageview' ? path : 'custom'),
        path,
        referrer: normaliseReferrer(input.referrer, project.domain),
        country,
        device: ua.device,
        browser: ua.browser,
        os: ua.os,
        sessionId,
        timestamp: resolveTimestamp(input.timestamp, now),
        meta: input.meta ?? {},
      };

      if (deps.buffer.push(prepared)) accepted += 1;
    }

    // Feed the realtime active-visitor set. Fire-and-forget: a Redis hiccup
    // must degrade the live counter, never the ingestion path.
    void touchSession(project.id, sessionId).catch((err) => {
      log.debug('active session touch failed', { message: String(err) });
    });

    // 202, not 200: we have accepted responsibility for these events but have
    // not yet durably stored them, and the status code should say so.
    res.status(202).json({ accepted });
  });

  router.post('/collect', handler);

  /**
   * The snippet uses `navigator.sendBeacon`, which cannot set custom headers
   * and always sends a CORS preflight-free POST. GET is offered as a
   * last-resort fallback for browsers where beacon and fetch-keepalive are
   * both unavailable (older Safari on unload).
   */
  router.get(
    '/collect',
    asyncHandler(async (req: Request, res: Response) => {
      const raw = typeof req.query.d === 'string' ? req.query.d : null;
      if (!raw) throw ApiError.badRequest('Missing `d` query parameter');
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      } catch (err) {
        throw new ApiError(400, 'bad_request', '`d` must be base64url-encoded JSON', { cause: err });
      }
      req.body = decoded;
      // 1x1 transparent GIF semantics are unnecessary — the snippet ignores the
      // body — but the shared handler still validates and buffers identically.
      await new Promise<void>((resolve, reject) => {
        handler(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
      });
    }),
  );

  return router;
}
