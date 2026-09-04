/**
 * Uptime percentage maths.
 *
 * Deliberately a pure function taking counts, so it can be unit-tested without
 * a database and reused by both the dashboard API and the public status page.
 */

export interface UptimeCounts {
  totalChecks: number;
  failedChecks: number;
}

/**
 * Uptime as a percentage of *checks that ran*, rounded to 3 decimals.
 *
 * Rounding matters: 99.9995% must not render as "100%" next to a visible
 * incident, so we truncate toward zero rather than rounding to nearest. A
 * status page that rounds an outage away is worse than useless.
 *
 * With zero checks the honest answer is "we don't know", not 100% — callers get
 * `null` and are expected to render "no data".
 */
export function uptimePercentage({ totalChecks, failedChecks }: UptimeCounts): number | null {
  if (!Number.isFinite(totalChecks) || totalChecks <= 0) return null;
  const failed = Math.min(Math.max(failedChecks, 0), totalChecks);
  const raw = ((totalChecks - failed) / totalChecks) * 100;
  return Math.floor(raw * 1000) / 1000;
}

/** Uptime bucketed into the SLA tiers a status page colours by. */
export function uptimeTier(pct: number | null): 'unknown' | 'operational' | 'degraded' | 'down' {
  if (pct === null) return 'unknown';
  if (pct >= 99.9) return 'operational';
  if (pct >= 95) return 'degraded';
  return 'down';
}

/**
 * Percentage change between two periods, for the dashboard's "vs. previous"
 * deltas. Returns null when the previous period was zero — "up from nothing" is
 * not a meaningful percentage, and rendering "+∞%" or "+100%" would both be
 * misleading.
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
