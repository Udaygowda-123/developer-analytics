import { createLogger } from '../logger.js';

const log = createLogger('monitors:check');

export interface CheckOutcome {
  statusCode: number | null;
  latencyMs: number;
  ok: boolean;
  error: string | null;
}

export interface RunCheckOptions {
  url: string;
  expectedStatus: number;
  timeoutMs?: number;
  /** Injected in tests so no network is touched. */
  fetchImpl?: typeof fetch;
}

/**
 * Performs one HTTP check.
 *
 * Never throws: a failed check *is* the result we want to record, so every
 * failure mode (timeout, DNS, TLS, connection reset) is converted into an
 * `ok: false` outcome with a human-readable reason. A monitor that threw would
 * take down the sweep it runs in.
 */
export async function runCheck({
  url,
  expectedStatus,
  timeoutMs = 10_000,
  fetchImpl = fetch,
}: RunCheckOptions): Promise<CheckOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Identify ourselves so site owners can see who is polling them, and
        // so we are not mistaken for a scraper.
        'user-agent': 'PulseMonitor/1.0 (+https://github.com/pulse-analytics)',
        accept: '*/*',
      },
    });

    // Drain and discard the body. Without this the socket stays open until GC
    // and the connection pool leaks under a fast polling interval — and we
    // measure time-to-body, which is closer to what a visitor experiences than
    // time-to-headers.
    await response.arrayBuffer().catch(() => undefined);

    const latencyMs = Math.round(performance.now() - startedAt);
    const ok = response.status === expectedStatus;

    return {
      statusCode: response.status,
      latencyMs,
      ok,
      error: ok ? null : `Expected status ${expectedStatus}, received ${response.status}`,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    const message = aborted
      ? `Request timed out after ${timeoutMs}ms`
      : describeNetworkError(err);

    log.debug('check failed', { url, message, latencyMs });
    return { statusCode: null, latencyMs, ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetch` wraps the real cause in a generic "fetch failed", which is useless in
 * an alert email. Unwrap it so the user is told "getaddrinfo ENOTFOUND" rather
 * than nothing.
 */
function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${code}: ${cause.message}` : cause.message;
  }
  return err.message;
}
