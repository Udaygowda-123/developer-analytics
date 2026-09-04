import { z } from 'zod';

/**
 * Environment is validated once, at boot, and never read via `process.env`
 * again. A missing MONGODB_URI should crash the process on line one — not
 * surface as an undefined at 3am inside the rollup job.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  /** Secret for the cookieless session HMAC. Rotating it resets all sessions. */
  PULSE_SESSION_SECRET: z.string().min(16, 'Use at least 16 characters'),

  /** Comma-separated origins allowed to call the authenticated API. */
  DASHBOARD_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  /** Firebase Admin credentials, used to verify ID tokens server-side. */
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  ALERT_FROM_EMAIL: z.string().email().default('alerts@pulse.local'),

  /** Base URL of the dashboard, used in alert email links. */
  PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),

  /* Tunables — defaults match the values documented in the README. */
  INGEST_BUFFER_MAX_SIZE: z.coerce.number().int().positive().default(500),
  INGEST_BUFFER_MAX_AGE_MS: z.coerce.number().int().positive().default(2_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(10_000),
  MONITOR_POOL_SIZE: z.coerce.number().int().positive().default(10),
  MONITOR_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ALERT_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(3_600),
  FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  ACTIVE_WINDOW_MINUTES: z.coerce.number().int().positive().default(5),
  WS_BROADCAST_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  DASHBOARD_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),

  /** Disables cron registration — used by tests and by the load-test harness. */
  DISABLE_CRON: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(
      `Invalid environment configuration:\n${lines.join('\n')}\n\nSee .env.example for the full list.`,
    );
  }
  return parsed.data;
}

export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test hook: swap in a config without touching process.env. */
export function setConfigForTesting(config: Config | null): void {
  cached = config;
}
