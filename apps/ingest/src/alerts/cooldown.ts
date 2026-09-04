import { getRedis } from '../redis.js';
import { createLogger } from '../logger.js';

const log = createLogger('alerts:cooldown');

/**
 * Alert cooldown: at most one alert per monitor per hour.
 *
 * A flapping monitor — up, down, up, down on a 60-second interval — would
 * otherwise generate an email every couple of minutes, and the first thing
 * anyone does with an alert channel like that is mute it. A muted alert channel
 * is worse than none, because it looks like coverage.
 *
 * Implemented as `SET key NX EX <ttl>`: a single atomic operation that both
 * tests and claims the slot. Doing GET-then-SET would let two concurrent
 * sweeps (or two instances) each see an empty key and both send.
 *
 * Redis holds this rather than a `lastNotifiedAt` column because it is the only
 * shared state between instances and it should expire on its own. The
 * `lastNotifiedAt` field on the Monitor is kept in sync purely so the UI can
 * show when the last alert went out.
 */

export type AlertKind = 'down' | 'recovered';

function cooldownKey(monitorId: string, kind: AlertKind): string {
  return `alert:cooldown:${kind}:${monitorId}`;
}

/**
 * Attempts to claim the right to send. Returns true exactly once per monitor
 * per kind per TTL window.
 *
 * Fails *closed* on a Redis error: if we cannot prove we have not already sent,
 * we do not send. An occasional missed alert is recoverable; an unbounded email
 * loop caused by a cache outage is not.
 */
export async function claimAlertSlot(
  monitorId: string,
  kind: AlertKind,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    const result = await getRedis().set(cooldownKey(monitorId, kind), Date.now(), 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (err) {
    log.error('cooldown check failed, suppressing alert', err, { monitorId, kind });
    return false;
  }
}

/**
 * Clears a monitor's down-cooldown when it recovers, so a *new* incident later
 * alerts immediately rather than being swallowed by the previous incident's
 * remaining cooldown. Without this, an outage 10 minutes after a resolved one
 * would go unreported for 50 minutes.
 */
export async function releaseAlertSlot(monitorId: string, kind: AlertKind): Promise<void> {
  try {
    await getRedis().del(cooldownKey(monitorId, kind));
  } catch (err) {
    log.warn('failed to clear cooldown', { monitorId, kind, message: String(err) });
  }
}

/** For the UI / tests: seconds remaining, or 0 if not in cooldown. */
export async function cooldownRemaining(monitorId: string, kind: AlertKind): Promise<number> {
  try {
    const ttl = await getRedis().ttl(cooldownKey(monitorId, kind));
    return ttl > 0 ? ttl : 0;
  } catch {
    return 0;
  }
}
