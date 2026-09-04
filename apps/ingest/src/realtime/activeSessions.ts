import { getConfig } from '../config.js';
import { getRedis } from '../redis.js';

/**
 * "Active right now" — sessions seen in the last N minutes (default 5).
 *
 * Held in Redis as a sorted set per project, scored by last-seen timestamp,
 * rather than queried from Mongo. The naive alternative
 * (`distinct sessionId where timestamp > now-5m`) would run every 10 seconds
 * per connected dashboard against the hot Event collection — a scan whose cost
 * grows with traffic, to answer a question that is only ever a small number.
 *
 * A sorted set answers it in O(log n) with ZCOUNT, costs one ZADD per ingested
 * event, and self-expires. Being lossy on a Redis restart is fine: the counter
 * repopulates within one window.
 */

const KEY_PREFIX = 'active:';

export function activeKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

function windowMs(): number {
  return getConfig().ACTIVE_WINDOW_MINUTES * 60_000;
}

/** Records that `sessionId` was just seen on `projectId`. */
export async function touchSession(
  projectId: string,
  sessionId: string,
  now: number = Date.now(),
): Promise<void> {
  const redis = getRedis();
  const key = activeKey(projectId);
  // ZADD overwrites the score for an existing member, so a returning visitor
  // slides forward in the window rather than being counted twice.
  await redis
    .multi()
    .zadd(key, now, sessionId)
    // Trim on write so the set cannot grow unboundedly between reads.
    .zremrangebyscore(key, 0, now - windowMs())
    // Whole key expires once no one has been seen for two windows.
    .pexpire(key, windowMs() * 2)
    .exec();
}

/** Number of distinct sessions seen within the active window. */
export async function countActiveSessions(
  projectId: string,
  now: number = Date.now(),
): Promise<number> {
  const redis = getRedis();
  const key = activeKey(projectId);
  const cutoff = now - windowMs();
  // Evict first so an idle project reports 0 rather than a stale count.
  await redis.zremrangebyscore(key, 0, cutoff);
  return redis.zcount(key, cutoff, '+inf');
}

/** Batch variant used by the broadcast loop, which polls many projects at once. */
export async function countActiveSessionsMany(
  projectIds: string[],
  now: number = Date.now(),
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (projectIds.length === 0) return result;

  const redis = getRedis();
  const cutoff = now - windowMs();
  const pipeline = redis.pipeline();
  for (const id of projectIds) {
    pipeline.zremrangebyscore(activeKey(id), 0, cutoff);
    pipeline.zcount(activeKey(id), cutoff, '+inf');
  }

  const replies = await pipeline.exec();
  projectIds.forEach((id, i) => {
    // Two commands per project; the count is the second reply of each pair.
    const reply = replies?.[i * 2 + 1];
    const value = reply && !reply[0] ? Number(reply[1]) : 0;
    result.set(id, Number.isFinite(value) ? value : 0);
  });

  return result;
}
