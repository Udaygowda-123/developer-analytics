import { Check, Monitor, Project, User, type MonitorDoc } from '@pulse/shared/models';
import type { HydratedDocument } from 'mongoose';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { CheckOutcome } from '../monitors/checkRunner.js';
import { claimAlertSlot, releaseAlertSlot } from './cooldown.js';
import { getMailer } from './mailer.js';
import { MonitorDownEmail } from './emails/MonitorDownEmail.js';
import { MonitorRecoveredEmail } from './emails/MonitorRecoveredEmail.js';

const log = createLogger('alerts');

export interface HandleCheckResultInput {
  monitor: HydratedDocument<MonitorDoc>;
  outcome: CheckOutcome;
  /** The counter *before* this check was recorded. */
  previousConsecutiveFailures: number;
}

/**
 * Decides whether a check result warrants an email.
 *
 * Two transitions matter, and only the transitions:
 *
 *   DOWN      — the failure counter has just reached the threshold (default 3).
 *               Three consecutive failures rather than one because a single
 *               failed request is usually a transient network blip, and paging
 *               someone for those is how alerting gets ignored. At a 60s
 *               interval that is ~2 minutes of confirmed downtime before
 *               anyone is told.
 *
 *   RECOVERED — a success arrives while the counter was at or above the
 *               threshold, i.e. we had previously told someone it was down.
 *               A success after one or two failures is not a recovery, because
 *               no down alert was ever sent for it.
 *
 * Everything in between is silence, which is the point.
 */
export async function handleCheckResult({
  monitor,
  outcome,
  previousConsecutiveFailures,
}: HandleCheckResultInput): Promise<'sent_down' | 'sent_recovered' | 'suppressed' | 'none'> {
  const cfg = getConfig();
  const threshold = cfg.FAILURE_THRESHOLD;
  const monitorId = String(monitor._id);

  if (!outcome.ok) {
    const failures = monitor.consecutiveFailures;
    // Fire on crossing the threshold, and keep re-attempting on every
    // subsequent failure so a long outage re-alerts once per cooldown window.
    if (failures < threshold) return 'none';

    const claimed = await claimAlertSlot(monitorId, 'down', cfg.ALERT_COOLDOWN_SECONDS);
    if (!claimed) {
      log.debug('down alert suppressed by cooldown', { monitorId, failures });
      return 'suppressed';
    }

    const recipient = await resolveRecipient(monitor);
    if (!recipient) return 'none';

    const failingSince = await estimateFailingSince(monitorId, failures);

    try {
      await getMailer().send({
        to: recipient.email,
        subject: `🔴 ${monitor.name} is down`,
        body: MonitorDownEmail({
          monitorName: monitor.name,
          url: monitor.url,
          error: outcome.error ?? 'Unknown error',
          consecutiveFailures: failures,
          failingSince: failingSince.toISOString(),
          dashboardUrl: `${cfg.PUBLIC_APP_URL}/projects/${String(monitor.projectId)}/monitors`,
        }),
      });
      await Monitor.updateOne({ _id: monitor._id }, { $set: { lastNotifiedAt: new Date() } });
      log.info('down alert sent', { monitorId, to: recipient.email, failures });
      return 'sent_down';
    } catch (err) {
      // Release the slot so the next sweep can retry rather than waiting out a
      // full hour of cooldown for an email that was never delivered.
      await releaseAlertSlot(monitorId, 'down');
      log.error('failed to send down alert', err, { monitorId });
      return 'none';
    }
  }

  // Success path — only a recovery if we had actually alerted.
  if (previousConsecutiveFailures < threshold) return 'none';

  const claimed = await claimAlertSlot(monitorId, 'recovered', cfg.ALERT_COOLDOWN_SECONDS);
  if (!claimed) {
    log.debug('recovery alert suppressed by cooldown', { monitorId });
    return 'suppressed';
  }

  const recipient = await resolveRecipient(monitor);
  if (!recipient) return 'none';

  const downSince = await estimateFailingSince(monitorId, previousConsecutiveFailures);

  try {
    await getMailer().send({
      to: recipient.email,
      subject: `🟢 ${monitor.name} has recovered`,
      body: MonitorRecoveredEmail({
        monitorName: monitor.name,
        url: monitor.url,
        downtimeLabel: humaniseDuration(Date.now() - downSince.getTime()),
        statusCode: outcome.statusCode,
        latencyMs: outcome.latencyMs,
        dashboardUrl: `${cfg.PUBLIC_APP_URL}/projects/${String(monitor.projectId)}/monitors`,
      }),
    });
    await Monitor.updateOne({ _id: monitor._id }, { $set: { lastNotifiedAt: new Date() } });
    // The incident is over; a future outage must alert immediately.
    await releaseAlertSlot(monitorId, 'down');
    log.info('recovery alert sent', { monitorId, to: recipient.email });
    return 'sent_recovered';
  } catch (err) {
    await releaseAlertSlot(monitorId, 'recovered');
    log.error('failed to send recovery alert', err, { monitorId });
    return 'none';
  }
}

/** Alerts go to the project owner. */
async function resolveRecipient(
  monitor: HydratedDocument<MonitorDoc>,
): Promise<{ email: string } | null> {
  const project = await Project.findById(monitor.projectId, { ownerId: 1 }).lean();
  if (!project) {
    log.warn('monitor has no project, cannot alert', { monitorId: String(monitor._id) });
    return null;
  }
  const owner = await User.findById(project.ownerId, { email: 1 }).lean();
  if (!owner?.email) {
    log.warn('project owner has no email, cannot alert', { monitorId: String(monitor._id) });
    return null;
  }
  return { email: owner.email };
}

/**
 * When the current failure streak began — the timestamp of the check just
 * before the streak. Read from the Check history rather than tracked as a
 * field, because the streak length is already known and history is authoritative.
 */
async function estimateFailingSince(monitorId: string, streakLength: number): Promise<Date> {
  const checks = await Check.find({ monitorId }, { timestamp: 1 })
    .sort({ timestamp: -1 })
    .limit(Math.max(1, streakLength))
    .lean();
  const oldest = checks[checks.length - 1];
  return oldest?.timestamp ? new Date(oldest.timestamp) : new Date();
}

export function humaniseDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return remainder ? `${hours}h ${remainder}m` : `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
