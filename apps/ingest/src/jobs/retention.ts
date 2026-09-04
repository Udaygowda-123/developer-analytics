import { DailyRollup, Event } from '@pulse/shared/models';
import { utcMidnight } from '@pulse/shared';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('jobs:retention');

export interface RetentionStats {
  cutoff: string;
  eventsDeleted: number;
  batches: number;
  skippedUnrolledDays: number;
  durationMs: number;
}

/**
 * Deletes raw events older than the retention window (default 90 days).
 *
 * Two safeguards, both there because this job is irreversible:
 *
 *  1. **Never delete a day that has not been rolled up.** The rollup is the
 *     only remaining record once the raw events are gone, so we verify a
 *     `DailyRollup` document exists for each day before deleting it. A rollup
 *     that failed silently would otherwise turn into permanent data loss on the
 *     next retention run.
 *
 *  2. **Delete in batches, not one enormous `deleteMany`.** A single delete of
 *     tens of millions of documents holds locks for minutes and blocks
 *     ingestion. Batching keeps each operation short and lets the job yield.
 *
 * A TTL index would be far simpler and is the usual answer — but a TTL index
 * cannot be told "only if the rollup succeeded", which is precisely the
 * guarantee that matters here.
 */
export async function pruneOldEvents(now: Date = new Date()): Promise<RetentionStats> {
  const startedAt = Date.now();
  const cfg = getConfig();
  const cutoff = new Date(utcMidnight(now).getTime() - cfg.EVENT_RETENTION_DAYS * 86_400_000);

  log.info('retention starting', { cutoff: cutoff.toISOString(), retentionDays: cfg.EVENT_RETENTION_DAYS });

  // Find the oldest event still present; everything from there up to the
  // cutoff is a candidate, one day at a time.
  const oldest = await Event.findOne({}, { timestamp: 1 }).sort({ timestamp: 1 }).lean();
  if (!oldest?.timestamp) {
    const stats: RetentionStats = {
      cutoff: cutoff.toISOString(),
      eventsDeleted: 0,
      batches: 0,
      skippedUnrolledDays: 0,
      durationMs: Date.now() - startedAt,
    };
    log.info('retention complete (no events)', stats);
    return stats;
  }

  let eventsDeleted = 0;
  let batches = 0;
  let skippedUnrolledDays = 0;

  for (
    let dayStart = utcMidnight(new Date(oldest.timestamp)).getTime();
    dayStart < cutoff.getTime();
    dayStart += 86_400_000
  ) {
    const from = new Date(dayStart);
    const to = new Date(dayStart + 86_400_000);

    // Which projects had events that day, and which of those have a rollup?
    const projectIds = await Event.distinct('projectId', { timestamp: { $gte: from, $lt: to } });
    if (projectIds.length === 0) continue;

    const rolled = await DailyRollup.find(
      { date: from, projectId: { $in: projectIds } },
      { projectId: 1 },
    ).lean();
    const rolledSet = new Set(rolled.map((r) => String(r.projectId)));

    const safeToDelete = projectIds.filter((id) => rolledSet.has(String(id)));
    const unrolled = projectIds.length - safeToDelete.length;
    if (unrolled > 0) {
      skippedUnrolledDays += 1;
      log.warn('skipping projects with no rollup for this day', {
        day: from.toISOString().slice(0, 10),
        unrolledProjects: unrolled,
      });
    }
    if (safeToDelete.length === 0) continue;

    const result = await Event.deleteMany({
      projectId: { $in: safeToDelete },
      timestamp: { $gte: from, $lt: to },
    });
    eventsDeleted += result.deletedCount ?? 0;
    batches += 1;

    // Yield between days so a long prune does not starve the event loop that
    // the ingestion buffer's flush timer lives on.
    await new Promise((resolve) => setImmediate(resolve));
  }

  const stats: RetentionStats = {
    cutoff: cutoff.toISOString(),
    eventsDeleted,
    batches,
    skippedUnrolledDays,
    durationMs: Date.now() - startedAt,
  };
  log.info('retention complete', stats);
  return stats;
}
