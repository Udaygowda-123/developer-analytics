import { Router, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import {
  ApiError,
  createMonitorSchema,
  updateMonitorSchema,
  zodErrorToApiError,
  type CheckDTO,
  type MonitorDTO,
  type MonitorStatus,
} from '@pulse/shared';
import { Check, Monitor } from '@pulse/shared/models';
import { requireAuth, requireProjectAccess, type ProjectRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createLogger } from '../logger.js';
import { getLatencySeries, getUptimeWindows } from '../monitors/uptimeService.js';
import { checkAndRecord } from '../monitors/scheduler.js';
import { getConfig } from '../config.js';

const log = createLogger('routes:monitors');

function monitorToDTO(m: Record<string, unknown>): MonitorDTO {
  return {
    id: String(m._id),
    projectId: String(m.projectId),
    name: String(m.name),
    url: String(m.url),
    intervalSeconds: m.intervalSeconds as MonitorDTO['intervalSeconds'],
    expectedStatus: Number(m.expectedStatus),
    isPaused: Boolean(m.isPaused),
    consecutiveFailures: Number(m.consecutiveFailures ?? 0),
    lastCheckedAt: m.lastCheckedAt ? new Date(m.lastCheckedAt as Date).toISOString() : null,
    lastNotifiedAt: m.lastNotifiedAt ? new Date(m.lastNotifiedAt as Date).toISOString() : null,
    createdAt: new Date((m.createdAt as Date) ?? Date.now()).toISOString(),
  };
}

function checkToDTO(c: Record<string, unknown>): CheckDTO {
  return {
    id: String(c._id),
    monitorId: String(c.monitorId),
    statusCode: (c.statusCode as number | null) ?? null,
    latencyMs: Number(c.latencyMs),
    ok: Boolean(c.ok),
    error: (c.error as string | null) ?? null,
    timestamp: new Date(c.timestamp as Date).toISOString(),
  };
}

function currentState(m: { isPaused: boolean; lastStatusOk?: boolean | null }): MonitorStatus['currentState'] {
  if (m.isPaused) return 'paused';
  if (m.lastStatusOk === true) return 'up';
  if (m.lastStatusOk === false) return 'down';
  return 'unknown';
}

/** Resolves `:monitorId` within the already-authorised project. */
async function loadMonitor(req: Request) {
  const { project } = req as ProjectRequest;
  const monitorId = req.params.monitorId ?? '';
  if (!/^[a-f\d]{24}$/i.test(monitorId)) throw ApiError.notFound('Monitor not found');
  // Scoped by projectId as well as _id, so a valid monitor id from another
  // project is a 404 rather than a cross-tenant read.
  const monitor = await Monitor.findOne({ _id: monitorId, projectId: project._id });
  if (!monitor) throw ApiError.notFound('Monitor not found');
  return monitor;
}

export function createMonitorsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/projects/:projectId/monitors',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const { project } = req as ProjectRequest;
      const monitors = await Monitor.find({ projectId: project._id }).sort({ createdAt: 1 }).lean();

      /*
       * Per-monitor uptime and last-check lookups are independent of each
       * other — different monitors, no shared state — so they run concurrently
       * rather than serially. Bounded by the number of monitors on one
       * project, which is small; the scheduler's pool exists for the unbounded
       * case, this does not need one.
       */
      const statuses: MonitorStatus[] = await Promise.all(
        monitors.map(async (m) => {
          const [uptime, lastCheck] = await Promise.all([
            getUptimeWindows(m._id as Types.ObjectId),
            Check.findOne({ monitorId: m._id }).sort({ timestamp: -1 }).lean(),
          ]);
          return {
            monitor: monitorToDTO(m as never),
            currentState: currentState(m as never),
            lastCheck: lastCheck ? checkToDTO(lastCheck as never) : null,
            uptime,
          };
        }),
      );

      res.json({ monitors: statuses });
    }),
  );

  router.post(
    '/projects/:projectId/monitors',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const { project } = req as ProjectRequest;
      const parsed = createMonitorSchema.safeParse(req.body);
      if (!parsed.success) throw zodErrorToApiError(parsed.error);

      const monitor = await Monitor.create({
        projectId: project._id,
        name: parsed.data.name,
        url: parsed.data.url,
        intervalSeconds: parsed.data.intervalSeconds,
        expectedStatus: parsed.data.expectedStatus,
        // lastCheckedAt stays null so the next sweep picks it up immediately —
        // a monitor you just created should report a status within 30 seconds,
        // not after a full interval.
      });

      log.info('monitor created', { monitorId: String(monitor._id), projectId: String(project._id) });
      res.status(201).json({ monitor: monitorToDTO(monitor.toObject() as never) });
    }),
  );

  router.get(
    '/projects/:projectId/monitors/:monitorId',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const monitor = await loadMonitor(req);

      // Three independent reads over the same monitor's history — uptime
      // windows, the latency chart, and the recent check list. None feeds
      // another, so they overlap.
      const [uptime, latency, checks] = await Promise.all([
        getUptimeWindows(monitor._id),
        getLatencySeries(monitor._id, 24),
        Check.find({ monitorId: monitor._id }).sort({ timestamp: -1 }).limit(50).lean(),
      ]);

      res.json({
        monitor: monitorToDTO(monitor.toObject() as never),
        currentState: currentState(monitor as never),
        uptime,
        latency,
        checks: checks.map((c) => checkToDTO(c as never)),
      });
    }),
  );

  router.patch(
    '/projects/:projectId/monitors/:monitorId',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = updateMonitorSchema.safeParse(req.body);
      if (!parsed.success) throw zodErrorToApiError(parsed.error);

      const monitor = await loadMonitor(req);
      if (parsed.data.name !== undefined) monitor.name = parsed.data.name;
      if (parsed.data.url !== undefined) monitor.url = parsed.data.url;
      if (parsed.data.intervalSeconds !== undefined) monitor.intervalSeconds = parsed.data.intervalSeconds;
      if (parsed.data.expectedStatus !== undefined) monitor.expectedStatus = parsed.data.expectedStatus;
      if (parsed.data.isPaused !== undefined) {
        monitor.isPaused = parsed.data.isPaused;
        // Un-pausing resets the failure streak: failures accrued before a pause
        // should not count toward an alert once monitoring resumes.
        if (!parsed.data.isPaused) monitor.consecutiveFailures = 0;
      }
      await monitor.save();

      res.json({ monitor: monitorToDTO(monitor.toObject() as never) });
    }),
  );

  router.delete(
    '/projects/:projectId/monitors/:monitorId',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const monitor = await loadMonitor(req);
      await Promise.all([
        Check.deleteMany({ monitorId: monitor._id }),
        Monitor.deleteOne({ _id: monitor._id }),
      ]);
      log.info('monitor deleted', { monitorId: String(monitor._id) });
      res.status(204).end();
    }),
  );

  /** Run a check right now — used by the UI's "check now" button and by E2E. */
  router.post(
    '/projects/:projectId/monitors/:monitorId/check',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const monitor = await loadMonitor(req);
      const outcome = await checkAndRecord(monitor, getConfig().MONITOR_TIMEOUT_MS);
      res.status(201).json({ check: outcome });
    }),
  );

  return router;
}
