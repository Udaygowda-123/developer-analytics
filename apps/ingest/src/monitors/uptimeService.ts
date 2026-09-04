import { Types } from 'mongoose';
import { Check } from '@pulse/shared/models';
import { uptimePercentage, type UptimeWindow } from '@pulse/shared';

const WINDOWS: Array<{ window: UptimeWindow['window']; ms: number }> = [
  { window: '24h', ms: 24 * 60 * 60 * 1000 },
  { window: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { window: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

/**
 * Uptime across all three windows in ONE aggregation.
 *
 * `$facet` again, for the same reason as the analytics pipeline: the three
 * windows are nested (24h ⊂ 7d ⊂ 30d), so a single `$match` over the widest
 * window feeds all three sub-pipelines and the index is walked once instead of
 * three times.
 */
export async function getUptimeWindows(monitorId: string | Types.ObjectId): Promise<UptimeWindow[]> {
  const id = typeof monitorId === 'string' ? new Types.ObjectId(monitorId) : monitorId;
  const now = Date.now();
  const widest = new Date(now - (WINDOWS[WINDOWS.length - 1] as { ms: number }).ms);

  const facets = Object.fromEntries(
    WINDOWS.map(({ window, ms }) => [
      window,
      [
        { $match: { timestamp: { $gte: new Date(now - ms) } } },
        {
          $group: {
            _id: null,
            totalChecks: { $sum: 1 },
            failedChecks: { $sum: { $cond: ['$ok', 0, 1] } },
            // Latency is only meaningful for checks that completed; a timeout
            // records the timeout duration, which would skew the average
            // upward and make a healthy service look slow.
            latencySum: { $sum: { $cond: ['$ok', '$latencyMs', 0] } },
            latencyCount: { $sum: { $cond: ['$ok', 1, 0] } },
          },
        },
      ],
    ]),
  );

  const [result] = await Check.aggregate<Record<string, Array<{
    totalChecks: number;
    failedChecks: number;
    latencySum: number;
    latencyCount: number;
  }>>>([
    { $match: { monitorId: id, timestamp: { $gte: widest } } },
    { $project: { _id: 0, ok: 1, latencyMs: 1, timestamp: 1 } },
    { $facet: facets },
  ]).option({ maxTimeMS: 10_000 });

  return WINDOWS.map(({ window }) => {
    const row = result?.[window]?.[0] ?? {
      totalChecks: 0,
      failedChecks: 0,
      latencySum: 0,
      latencyCount: 0,
    };
    return {
      window,
      uptimePct: uptimePercentage(row) ?? 0,
      totalChecks: row.totalChecks,
      failedChecks: row.failedChecks,
      avgLatencyMs: row.latencyCount > 0 ? Math.round(row.latencySum / row.latencyCount) : null,
    };
  });
}

/**
 * Per-day uptime for the last `days` days — the 90-bar strip on a status page.
 *
 * Bucketed with `$dateTrunc` in UTC (a status page has no single viewer
 * timezone) and returned dense: days with no checks are represented so the bar
 * strip shows a gap rather than silently compressing.
 */
export async function getDailyUptime(
  monitorId: string | Types.ObjectId,
  days = 90,
): Promise<Array<{ date: string; uptimePct: number | null; totalChecks: number; failedChecks: number }>> {
  const id = typeof monitorId === 'string' ? new Types.ObjectId(monitorId) : monitorId;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));

  const rows = await Check.aggregate<{ _id: Date; totalChecks: number; failedChecks: number }>([
    { $match: { monitorId: id, timestamp: { $gte: start } } },
    {
      $group: {
        _id: { $dateTrunc: { date: '$timestamp', unit: 'day', timezone: 'UTC' } },
        totalChecks: { $sum: 1 },
        failedChecks: { $sum: { $cond: ['$ok', 0, 1] } },
      },
    },
    { $sort: { _id: 1 } },
  ]).option({ maxTimeMS: 10_000 });

  const byDay = new Map(rows.map((r) => [new Date(r._id).getTime(), r]));
  const out: Array<{ date: string; uptimePct: number | null; totalChecks: number; failedChecks: number }> = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(start.getTime());
    day.setUTCDate(start.getUTCDate() + i);
    const row = byDay.get(day.getTime());
    out.push({
      date: day.toISOString().slice(0, 10),
      uptimePct: row ? uptimePercentage(row) : null,
      totalChecks: row?.totalChecks ?? 0,
      failedChecks: row?.failedChecks ?? 0,
    });
  }
  return out;
}

/**
 * Contiguous runs of failure — what a human calls an "incident".
 *
 * Derived from the check history rather than stored, so it stays correct if
 * checks are backfilled or deleted, and so there is no second source of truth
 * to drift.
 */
export async function getRecentIncidents(
  monitorId: string | Types.ObjectId,
  limit = 5,
): Promise<Array<{ startedAt: string; endedAt: string | null; failedChecks: number; lastError: string | null }>> {
  const id = typeof monitorId === 'string' ? new Types.ObjectId(monitorId) : monitorId;
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const checks = await Check.find(
    { monitorId: id, timestamp: { $gte: since } },
    { ok: 1, timestamp: 1, error: 1 },
  )
    .sort({ timestamp: 1 })
    .lean();

  const incidents: Array<{ startedAt: string; endedAt: string | null; failedChecks: number; lastError: string | null }> = [];
  let current: { startedAt: Date; failedChecks: number; lastError: string | null } | null = null;

  for (const check of checks) {
    if (!check.ok) {
      current ??= { startedAt: new Date(check.timestamp), failedChecks: 0, lastError: null };
      current.failedChecks += 1;
      current.lastError = check.error ?? current.lastError;
    } else if (current) {
      incidents.push({
        startedAt: current.startedAt.toISOString(),
        endedAt: new Date(check.timestamp).toISOString(),
        failedChecks: current.failedChecks,
        lastError: current.lastError,
      });
      current = null;
    }
  }

  // An unterminated run is an ongoing incident: endedAt stays null.
  if (current) {
    incidents.push({
      startedAt: current.startedAt.toISOString(),
      endedAt: null,
      failedChecks: current.failedChecks,
      lastError: current.lastError,
    });
  }

  return incidents.reverse().slice(0, limit);
}

/** Latency time series for the monitor detail chart. */
export async function getLatencySeries(
  monitorId: string | Types.ObjectId,
  hours = 24,
): Promise<Array<{ bucket: string; avgLatencyMs: number; maxLatencyMs: number; failures: number }>> {
  const id = typeof monitorId === 'string' ? new Types.ObjectId(monitorId) : monitorId;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const rows = await Check.aggregate<{
    _id: Date;
    avgLatencyMs: number | null;
    maxLatencyMs: number | null;
    failures: number;
  }>([
    { $match: { monitorId: id, timestamp: { $gte: since } } },
    {
      $group: {
        _id: { $dateTrunc: { date: '$timestamp', unit: 'hour', timezone: 'UTC' } },
        // Successful checks only — see the note in getUptimeWindows.
        avgLatencyMs: { $avg: { $cond: ['$ok', '$latencyMs', null] } },
        maxLatencyMs: { $max: { $cond: ['$ok', '$latencyMs', null] } },
        failures: { $sum: { $cond: ['$ok', 0, 1] } },
      },
    },
    { $sort: { _id: 1 } },
  ]).option({ maxTimeMS: 10_000 });

  return rows.map((r) => ({
    bucket: new Date(r._id).toISOString(),
    avgLatencyMs: Math.round(r.avgLatencyMs ?? 0),
    maxLatencyMs: Math.round(r.maxLatencyMs ?? 0),
    failures: r.failures,
  }));
}
