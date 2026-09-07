import { expect, test, type Page } from '@playwright/test';

/**
 * The full journey the brief asks for:
 *
 *   sign up → create project → send events via the real snippet →
 *   see them on the dashboard → create a monitor → see a check result
 *
 * Deliberately one long test rather than six short ones: each step depends on
 * the state the previous step created, and splitting it would mean either
 * re-doing the setup six times or sharing mutable state between tests that
 * Playwright is free to reorder.
 */

const INGEST_URL = process.env.NEXT_PUBLIC_INGEST_URL ?? 'http://127.0.0.1:4100';

/** Unique per run, so re-runs against a persistent database do not collide. */
const RUN_ID = Date.now().toString(36);
const PROJECT_NAME = `E2E Project ${RUN_ID}`;

async function signIn(page: Page): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('Name').fill('E2E Test User');
  await page.getByLabel('Email').fill('e2e@pulse.test');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

test('sign up, create a project, ingest events, and monitor a URL', async ({ page }) => {
  await test.step('sign up and land on the projects page', async () => {
    await signIn(page);
  });

  await test.step('create a project', async () => {
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Name').fill(PROJECT_NAME);
    await page.getByLabel('Domain').fill('e2e.example');
    await page.getByRole('button', { name: 'Create project' }).click();

    await expect(page.getByText(PROJECT_NAME)).toBeVisible();
  });

  await test.step('open the project and read its API key', async () => {
    await page.getByText(PROJECT_NAME).click();
    await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible();
    // The dashboard starts empty, and must say so rather than showing an
    // empty chart.
    await expect(page.getByText('No traffic yet')).toBeVisible();
  });

  const apiKey = await test.step('reveal the API key in settings', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Reveal key' }).click();

    const keyText = await page.getByText(/^pk_live_/).first().innerText();
    expect(keyText).toMatch(/^pk_live_[A-Za-z0-9]{32}$/);
    return keyText.trim();
  });

  await test.step('send pageviews using the real tracking snippet', async () => {
    /*
     * Serve a synthetic customer page from the web app's own origin, so the
     * snippet runs under a real http origin and its cross-origin POST to the
     * ingest service exercises the actual CORS configuration. Intercepting the
     * route avoids shipping a test fixture in either app's public directory.
     */
    await page.route('**/e2e-customer-site', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html>
          <html lang="en"><head><title>Customer site</title>
            <script defer src="${INGEST_URL}/pulse.js"
                    data-key="${apiKey}" data-host="${INGEST_URL}"></script>
          </head>
          <body>
            <h1>Customer site</h1>
            <button id="convert">Convert</button>
            <script>
              document.getElementById('convert').addEventListener('click', function () {
                window.pulse.track('signup_completed', { plan: 'pro' });
              });
            </script>
          </body></html>`,
      }),
    );

    await page.goto('/e2e-customer-site');
    // The snippet fires a pageview on load; wait for it to have loaded.
    await page.waitForFunction(() => Boolean((window as { pulse?: unknown }).pulse));

    // A client-side navigation, to prove the History API patch works.
    await page.evaluate(() => window.history.pushState({}, '', '/e2e-customer-site?page=pricing'));

    // And a custom event through the public API.
    await page.getByRole('button', { name: 'Convert' }).click();

    // Buffer flush is 500ms in the E2E config; give it room plus the write.
    await page.waitForTimeout(2_000);
  });

  await test.step('confirm the ingest service recorded them', async () => {
    const health = await page.request.get(`${INGEST_URL}/health`);
    expect(health.ok()).toBeTruthy();
    const body = (await health.json()) as { buffer: { eventsFlushed: number } };
    expect(body.buffer.eventsFlushed).toBeGreaterThan(0);
  });

  await test.step('see the traffic on the dashboard', async () => {
    await page.goto('/projects');
    await page.getByText(PROJECT_NAME).click();

    // The empty state must be gone and real numbers present.
    await expect(page.getByText('No traffic yet')).toBeHidden();

    const pageviewsTile = page.locator('div', { hasText: /^Pageviews$/ }).first();
    await expect(pageviewsTile).toBeVisible();

    // Top pages should list the path the snippet reported.
    const topPages = page.getByRole('list', { name: 'Top pages' });
    await expect(topPages).toBeVisible();
    await expect(topPages.getByText('/e2e-customer-site', { exact: true })).toBeVisible();
  });

  await test.step('create a monitor and run a check', async () => {
    await page.getByRole('link', { name: 'Monitors' }).click();
    await expect(page.getByText('No monitors yet')).toBeVisible();

    await page.getByRole('button', { name: 'Add monitor' }).click();
    await page.getByLabel('Name').fill('Ingest health');
    // Point it at the ingest service's own health endpoint: a URL that is
    // guaranteed reachable from the test environment, unlike anything external.
    await page.getByLabel('URL').fill(`${INGEST_URL}/health`);
    await page.getByLabel('Check every').selectOption('300');
    await page.getByRole('button', { name: 'Add monitor' }).last().click();

    await expect(page.getByRole('heading', { name: 'Ingest health' })).toBeVisible();
  });

  await test.step('see the check result', async () => {
    await page.getByRole('button', { name: 'Check now' }).click();

    // The monitor moves from "awaiting first check" to operational, with a
    // real latency recorded.
    await expect(page.getByText('Operational')).toBeVisible();
    await expect(page.getByText(/\d+\s?ms/)).toBeVisible();
  });
});

test('the public status page is reachable without signing in', async ({ page, context }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'New project' }).click();
  const name = `Status Project ${RUN_ID}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Domain').fill('status.example');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByText(name).click();
  await page.getByRole('link', { name: 'Settings' }).click();

  const statusHref = await page.getByRole('link', { name: /^\/status\// }).getAttribute('href');
  expect(statusHref).toMatch(/^\/status\/[a-z0-9-]+$/);

  // A brand-new context: no cookies, no session, exactly what a customer's
  // user has when they open the status page during an incident.
  const anonymous = await context.browser()!.newPage();
  await anonymous.goto(`${page.url().split('/projects')[0]}${statusHref}`);

  await expect(anonymous.getByText(name)).toBeVisible();
  await expect(anonymous.getByRole('heading', { level: 1 })).toBeVisible();
  // It must not have bounced to the login page.
  expect(anonymous.url()).toContain('/status/');
  await anonymous.close();
});

test('signed-out visitors are redirected away from the dashboard', async ({ page }) => {
  await page.goto('/projects');

  await expect(page).toHaveURL(/\/login/);
  // And the intended destination is preserved for after sign-in.
  expect(page.url()).toContain('next=%2Fprojects');
});

test('the tracking snippet is served and within its size budget', async ({ request }) => {
  const response = await request.get(`${INGEST_URL}/pulse.js`);

  expect(response.ok()).toBeTruthy();
  const body = await response.body();
  // The budget is enforced at build time too; asserting it here catches a
  // stale committed artifact that the build never regenerated.
  expect(body.byteLength).toBeLessThan(2048);
  expect(body.toString()).toContain('sendBeacon');
});

test('the collect endpoint rejects a bad key and validates payloads', async ({ request }) => {
  const unauthorized = await request.post(`${INGEST_URL}/collect`, {
    data: { apiKey: `pk_live_${'a'.repeat(32)}`, path: '/' },
  });
  expect(unauthorized.status()).toBe(401);
  expect((await unauthorized.json()).error.code).toBe('unauthorized');

  const malformed = await request.post(`${INGEST_URL}/collect`, {
    data: { apiKey: 'not-a-key', path: '/' },
  });
  expect(malformed.status()).toBe(400);
  expect((await malformed.json()).error.code).toBe('bad_request');
});
