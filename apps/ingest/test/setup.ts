/**
 * Baseline environment for every test file.
 *
 * Set before any module reads `process.env`, so `loadConfig()` succeeds without
 * a real `.env`. Individual tests override what they need via
 * `setConfigForTesting`.
 */
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/pulse-test';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.PULSE_SESSION_SECRET ??= 'test-session-secret-at-least-16-chars';
process.env.DISABLE_CRON = 'true';
process.env.LOG_LEVEL ??= 'error';
