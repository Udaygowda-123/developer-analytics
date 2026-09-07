import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite.
 *
 * Boots the real ingest service and the real Next.js app against a real
 * MongoDB and Redis (docker compose locally, service containers in CI). The
 * only stubbed dependency is Firebase itself — see `src/lib/e2e-auth.ts` for
 * why, and for the production guards on the bypass.
 *
 * Two settings differ from production defaults, both so the suite is not
 * mostly `waitForTimeout`:
 *   - DASHBOARD_CACHE_TTL_SECONDS=1, or a freshly ingested event would be
 *     invisible behind the 60-second dashboard cache;
 *   - INGEST_BUFFER_MAX_AGE_MS=500, so a single pageview lands in ~half a
 *     second rather than two.
 * Both are configuration, not code paths — the buffering and caching
 * behaviour under test is identical.
 */

const WEB_PORT = 3100;
const INGEST_PORT = 4100;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const INGEST_URL = `http://127.0.0.1:${INGEST_PORT}`;

const sharedEnv = {
  NODE_ENV: 'test',
  MONGODB_URI: process.env.E2E_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/pulse-e2e',
  REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/1',
  PULSE_SESSION_SECRET: 'e2e-session-secret-at-least-16-chars',
  PULSE_E2E_AUTH_BYPASS: '1',
  NEXT_PUBLIC_INGEST_URL: INGEST_URL,
  NEXT_PUBLIC_INGEST_WS_URL: `ws://127.0.0.1:${INGEST_PORT}/ws`,
  NEXT_PUBLIC_E2E_AUTH_BYPASS: '1',
};

export default defineConfig({
  testDir: './e2e',
  // The suite shares one database, so parallel workers would see each other's
  // projects. Serial keeps assertions about "my projects" meaningful.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // One mobile profile, because "fully responsive" is a claim worth testing.
    { name: 'mobile-safari', use: { ...devices['iPhone 13'] } },
  ],

  webServer: [
    {
      command: 'npm run dev --workspace @pulse/ingest',
      url: `${INGEST_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '../..',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...sharedEnv,
        PORT: String(INGEST_PORT),
        DASHBOARD_ORIGINS: WEB_URL,
        PUBLIC_APP_URL: WEB_URL,
        DASHBOARD_CACHE_TTL_SECONDS: '1',
        INGEST_BUFFER_MAX_AGE_MS: '500',
        // Cron off: a background sweep would race the explicit "check now"
        // the monitor test performs, making its assertions flaky.
        DISABLE_CRON: 'true',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `npm run dev --workspace @pulse/web -- --port ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      cwd: '../..',
      stdout: 'pipe',
      stderr: 'pipe',
      env: sharedEnv,
    },
  ],
});
