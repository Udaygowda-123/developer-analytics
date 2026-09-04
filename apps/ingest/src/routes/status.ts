import { Router, type Request, type Response } from 'express';
import { ApiError } from '@pulse/shared';
import { Check, Monitor, Project } from '@pulse/shared/models';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getDailyUptime, getRecentIncidents, getUptimeWindows } from '../monitors/uptimeService.js';

/**
 * Public, unauthenticated status data for `/status/[slug]`.
 *
 * Deliberately exposes only what a status page needs: monitor names, up/down
 * state, uptime history and incident windows. Never the URL being monitored
 * (which may be an internal health endpoint), never the API key, never
 * anything identifying the owner.
 */
export function createStatusRouter(): Router {
  const router = Router();

  router.get(
    '/status/:slug',
    asyncHandler(async (req: Request, res: Response) => {
      const slug = String(req.params.slug ?? '').toLowerCase();
      if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw ApiError.notFound('Status page not found');

      const project = await Project.findOne({ slug }, { _id: 1, name: 1, slug: 1 }).lean();
      if (!project) throw ApiError.notFound('Status page not found');

      const monitors = await Monitor.find(
        { projectId: project._id },
        { name: 1, isPaused: 1, lastStatusOk: 1, lastCheckedAt: 1 },
      )
        .sort({ createdAt: 1 })
        .lean();

      const entries = await Promise.all(
        monitors.map(async (m) => {
          // Independent per-monitor reads, same argument as the monitors route.
          const [uptime, daily, incidents, lastCheck] = await Promise.all([
            getUptimeWindows(m._id),
            getDailyUptime(m._id, 90),
            getRecentIncidents(m._id, 5),
            Check.findOne({ monitorId: m._id }, { ok: 1, latencyMs: 1, timestamp: 1 })
              .sort({ timestamp: -1 })
              .lean(),
          ]);

          return {
            id: String(m._id),
            name: m.name,
            state: m.isPaused
              ? ('paused' as const)
              : m.lastStatusOk === true
                ? ('up' as const)
                : m.lastStatusOk === false
                  ? ('down' as const)
                  : ('unknown' as const),
            lastCheckedAt: m.lastCheckedAt ? new Date(m.lastCheckedAt).toISOString() : null,
            lastLatencyMs: lastCheck?.latencyMs ?? null,
            uptime,
            daily,
            incidents,
          };
        }),
      );

      const anyDown = entries.some((e) => e.state === 'down');
      const anyUnknown = entries.some((e) => e.state === 'unknown');

      // Cacheable at the edge. `stale-while-revalidate` keeps the page instant
      // during a traffic spike — which is exactly when people load a status
      // page — while a background refresh fetches the current state.
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');

      res.json({
        project: { name: project.name, slug: project.slug },
        overall: anyDown ? 'degraded' : anyUnknown && entries.length > 0 ? 'unknown' : 'operational',
        generatedAt: new Date().toISOString(),
        monitors: entries,
      });
    }),
  );

  return router;
}
