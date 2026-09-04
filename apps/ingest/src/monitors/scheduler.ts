import { Check, Monitor, type MonitorDoc } from '@pulse/shared/models';
import type { HydratedDocument } from 'mongoose';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { runCheck, type CheckOutcome } from './checkRunner.js';
import { runWithPool } from './pool.js';
import { handleCheckResult } from '../alerts/alertService.js';

const log = createLogger('monitors:scheduler');

export interface SweepStats {
  due: number;
  checked: number;
  failed: number;
  errors: number;
  durationMs: number;
}

/**
 * Guards against overlapping sweeps. The cron fires every 30 seconds but a
 * sweep can take longer when many monitors time out; without this, sweeps
 * would stack up and the same monitor would be checked concurrently by two of
 * them, double-counting failures toward the alert threshold.
 */
let sweepInFlight = false;

/**
 * Finds monitors whose next check is due and runs them.
 *
 * "Due" is `lastCheckedAt + intervalSeconds <= now`. Expressed as a `$expr` so
 * the comparison happens server-side against each monitor's own interval —
 * a per-monitor deadline cannot be a constant in the query.
 */
export async function sweepDueMonitors(now: Date = new Date()): Promise<SweepStats> {
  const startedAt = Date.now();

  if (sweepInFlight) {
    log.warn('sweep skipped, previous sweep still running');
    return { due: 0, checked: 0, failed: 0, errors: 0, durationMs: 0 };
  }
  sweepInFlight = true;

  try {
    const cfg = getConfig();

    const due = await Monitor.find({
      isPaused: false,
      $expr: {
        $or: [
          // Never checked — run immediately.
          { $eq: ['$lastCheckedAt', null] },
          {
            $lte: [
              { $add: ['$lastCheckedAt', { $multiply: ['$intervalSeconds', 1000] }] },
              now,
            ],
          },
        ],
      },
    })
      // Oldest first, so a monitor that has been waiting longest is never
      // starved by newer ones when the pool is saturated.
      .sort({ lastCheckedAt: 1 })
      // Bound the sweep: 500 checks at 10 workers is at most ~50 timeouts'
      // worth of work, which comfortably fits inside the 30s cadence for
      // healthy targets and degrades predictably when it does not.
      .limit(500);

    if (due.length === 0) {
      return { due: 0, checked: 0, failed: 0, errors: 0, durationMs: Date.now() - startedAt };
    }

    const { results, durationMs } = await runWithPool(due, cfg.MONITOR_POOL_SIZE, (monitor) =>
      checkAndRecord(monitor, cfg.MONITOR_TIMEOUT_MS),
    );

    let failed = 0;
    let errors = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        errors += 1;
        log.error('monitor check errored unexpectedly', result.reason);
      } else if (!result.value.ok) {
        failed += 1;
      }
    }

    const stats: SweepStats = { due: due.length, checked: results.length, failed, errors, durationMs };
    log.info('monitor sweep complete', { ...stats, poolSize: cfg.MONITOR_POOL_SIZE });
    return stats;
  } finally {
    sweepInFlight = false;
  }
}

/**
 * Runs one check, persists it, and updates the monitor's failure state.
 *
 * `lastCheckedAt` is written whatever the outcome — including on an unexpected
 * error — so a monitor that always fails cannot get stuck permanently "due"
 * and monopolise every sweep.
 */
export async function checkAndRecord(
  monitor: HydratedDocument<MonitorDoc>,
  timeoutMs: number,
): Promise<CheckOutcome> {
  const outcome = await runCheck({
    url: monitor.url,
    expectedStatus: monitor.expectedStatus,
    timeoutMs,
  });

  const now = new Date();
  const wasFailing = monitor.consecutiveFailures;

  /*
   * Persisting the check and updating the monitor are independent writes to
   * different collections: the Check document is an immutable historical
   * record and nothing reads it during this update, while the Monitor update
   * is a self-contained counter change. Neither depends on the other's result.
   */
  const [, updated] = await Promise.all([
    Check.create({
      monitorId: monitor._id,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      ok: outcome.ok,
      error: outcome.error,
      timestamp: now,
    }),
    Monitor.findByIdAndUpdate(
      monitor._id,
      outcome.ok
        ? { $set: { consecutiveFailures: 0, lastCheckedAt: now, lastStatusOk: true } }
        : { $inc: { consecutiveFailures: 1 }, $set: { lastCheckedAt: now, lastStatusOk: false } },
      { new: true },
    ),
  ]);

  if (updated) {
    await handleCheckResult({
      monitor: updated,
      outcome,
      previousConsecutiveFailures: wasFailing,
    });
  }

  return outcome;
}

/** Test hook — the in-flight guard is module state. */
export function resetSweepGuardForTesting(): void {
  sweepInFlight = false;
}
