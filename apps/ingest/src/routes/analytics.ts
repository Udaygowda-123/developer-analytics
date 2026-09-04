import { Router, type Request, type Response } from 'express';
import { analyticsQuerySchema, zodErrorToApiError } from '@pulse/shared';
import { requireAuth, requireProjectAccess, type ProjectRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getAnalytics } from '../analytics/service.js';
import { countActiveSessions } from '../realtime/activeSessions.js';

export function createAnalyticsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/projects/:projectId/analytics',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const { project } = req as ProjectRequest;
      const parsed = analyticsQuerySchema.safeParse({
        projectId: String(project._id),
        range: req.query.range ?? undefined,
        timezone: req.query.timezone ?? undefined,
        path: req.query.path ?? undefined,
      });
      if (!parsed.success) throw zodErrorToApiError(parsed.error, 'Invalid analytics query');

      const analytics = await getAnalytics(parsed.data);
      res.json(analytics);
    }),
  );

  /**
   * REST fallback for the live counter, for clients that cannot hold a
   * WebSocket open (and for the initial render, so the number is correct
   * before the first broadcast tick arrives 10s later).
   */
  router.get(
    '/projects/:projectId/active',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const { project } = req as ProjectRequest;
      const count = await countActiveSessions(String(project._id));
      res.json({ projectId: String(project._id), count, at: new Date().toISOString() });
    }),
  );

  return router;
}
