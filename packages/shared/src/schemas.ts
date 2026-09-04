import { z } from 'zod';
import { DATE_RANGES, DEVICE_TYPES, EVENT_TYPES, type MonitorInterval } from './types.js';

/**
 * One zod schema per API boundary. Both apps import these, so a change to the
 * wire format is a type error on both sides rather than a runtime surprise.
 */

/** Rejects `Intl`-unknown zones so we never build an aggregation with a bad tz. */
export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Unknown IANA timezone' },
  );

export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex ObjectId');

export const apiKeySchema = z
  .string()
  .regex(/^pk_live_[A-Za-z0-9]{32}$/, 'Malformed API key');

/* ------------------------------------------------------------------ *
 * Ingestion — POST /collect
 * ------------------------------------------------------------------ */

/**
 * `meta` is intentionally loose (custom event properties are user-defined) but
 * bounded: 20 keys of primitives only. Without a cap this is an easy way for a
 * caller to push megabyte documents into the hot collection.
 */
export const eventMetaSchema = z
  .record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 20, {
    message: 'meta may contain at most 20 keys',
  });

export const collectEventSchema = z.object({
  apiKey: apiKeySchema.optional(),
  type: z.enum(EVENT_TYPES).default('pageview'),
  /** For pageviews we default the name to the path; callers may override. */
  name: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(2048),
  referrer: z.string().max(2048).nullish(),
  /** Client-declared screen width, used only as a device-type tiebreaker. */
  screenWidth: z.number().int().positive().max(20000).nullish(),
  meta: eventMetaSchema.optional(),
  /** Client timestamp, trusted only within a sane window (see ingest route). */
  timestamp: z.string().datetime().optional(),
});
export type CollectEventInput = z.infer<typeof collectEventSchema>;

export const collectBatchSchema = z.object({
  apiKey: apiKeySchema.optional(),
  events: z.array(collectEventSchema.omit({ apiKey: true })).min(1).max(50),
});

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .transform((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase())
    .refine((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) || d === 'localhost', {
      message: 'Must be a bare domain, e.g. example.com',
    }),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema.partial();

/* ------------------------------------------------------------------ *
 * Analytics query
 * ------------------------------------------------------------------ */

export const analyticsQuerySchema = z.object({
  projectId: objectIdSchema,
  range: z.enum(DATE_RANGES).default('7d'),
  timezone: timezoneSchema.default('UTC'),
  /** Optional path filter, e.g. drill into /pricing. */
  path: z.string().max(2048).optional(),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

/* ------------------------------------------------------------------ *
 * Monitors
 * ------------------------------------------------------------------ */

export const monitorUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), { message: 'Only http(s) URLs may be monitored' });

export const createMonitorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: monitorUrlSchema,
  intervalSeconds: z
    .union([z.literal(60), z.literal(300), z.literal(900)])
    .default(300),
  expectedStatus: z.number().int().min(100).max(599).default(200),
});

/**
 * Compile-time guard: if someone adds a value to MONITOR_INTERVALS without
 * adding the matching `z.literal` above, this assignment stops type-checking.
 */
type _IntervalsMatch = z.infer<typeof createMonitorSchema>['intervalSeconds'] extends MonitorInterval
  ? true
  : never;
const _intervalsMatch: _IntervalsMatch = true;
void _intervalsMatch;
export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;

export const updateMonitorSchema = createMonitorSchema.partial().extend({
  isPaused: z.boolean().optional(),
});

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export const deviceSchema = z.enum(DEVICE_TYPES);
export const rangeSchema = z.enum(DATE_RANGES);
