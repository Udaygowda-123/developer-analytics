import cron, { type ScheduledTask } from 'node-cron';
import { createLogger } from '../logger.js';
import { sweepDueMonitors } from '../monitors/scheduler.js';
import { rollupYesterday } from './rollup.js';
import { pruneOldEvents } from './retention.js';

const log = createLogger('cron');

/**
 * All scheduled work lives here so there is one place to look for "what runs
 * on a timer".
 *
 * Every job is wrapped so a throw is logged and swallowed: node-cron does not
 * catch rejections, and one unhandled error would otherwise kill the process
 * and take ingestion down with it.
 */
function guarded(name: string, fn: () => Promise<unknown>): () => void {
  return () => {
    void fn().catch((err) => log.error(`${name} failed`, err));
  };
}

export interface CronHandles {
  stop(): void;
}

export function registerCronJobs(): CronHandles {
  const tasks: ScheduledTask[] = [];

  /*
   * Monitor sweep, every 30 seconds.
   *
   * Deliberately faster than the shortest monitor interval (60s) so a monitor
   * is never checked appreciably late: with a 60s sweep, a monitor due at
   * t+1s would not run until t+60s, effectively doubling its interval. The
   * sweep itself is cheap when nothing is due — one indexed query.
   */
  tasks.push(
    cron.schedule('*/30 * * * * *', guarded('monitor sweep', () => sweepDueMonitors()), {
      // Explicit, so the cron expressions below mean what they say regardless
      // of the host's timezone.
      timezone: 'UTC',
    }),
  );

  /*
   * Nightly rollup at 02:00 UTC — after midnight in every zone we might be
   * summarising, and in the quietest part of the traffic curve for most sites,
   * so the scan competes with as little ingestion as possible.
   */
  tasks.push(
    cron.schedule('0 2 * * *', guarded('daily rollup', () => rollupYesterday()), {
      timezone: 'UTC',
    }),
  );

  /*
   * Retention at 03:00 UTC — an hour after the rollup, so the day that just
   * aged out has certainly been summarised before anything is deleted. The job
   * verifies this itself too; the gap is belt and braces.
   */
  tasks.push(
    cron.schedule('0 3 * * *', guarded('event retention', () => pruneOldEvents()), {
      timezone: 'UTC',
    }),
  );

  log.info('cron jobs registered', { count: tasks.length });

  return {
    stop() {
      for (const task of tasks) task.stop();
      log.info('cron jobs stopped');
    },
  };
}
