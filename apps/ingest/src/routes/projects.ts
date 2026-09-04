import { Router, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import {
  ApiError,
  createProjectSchema,
  updateProjectSchema,
  zodErrorToApiError,
  type ProjectDTO,
} from '@pulse/shared';
import { Check, DailyRollup, Event, Monitor, Project } from '@pulse/shared/models';
import { generateApiKey, generateSlug } from '@pulse/shared/server';
import { requireAuth, requireProjectAccess, type AuthedRequest, type ProjectRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createLogger } from '../logger.js';
import { invalidateAnalyticsCache } from '../analytics/service.js';
import type { ProjectCache } from '../ingest/projectCache.js';

const log = createLogger('routes:projects');

function toDTO(project: {
  _id: unknown;
  ownerId: unknown;
  name: string;
  slug: string;
  domain: string;
  apiKey: string;
  createdAt?: Date;
}): ProjectDTO {
  return {
    id: String(project._id),
    ownerId: String(project.ownerId),
    name: project.name,
    slug: project.slug,
    domain: project.domain,
    apiKey: project.apiKey,
    createdAt: (project.createdAt ?? new Date()).toISOString(),
  };
}

export function createProjectsRouter(deps: { projectCache: ProjectCache }): Router {
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/projects',
    asyncHandler(async (req: Request, res: Response) => {
      const { auth } = req as AuthedRequest;
      const projects = await Project.find({ ownerId: auth.user._id as Types.ObjectId })
        .sort({ createdAt: -1 })
        .lean();
      res.json({ projects: projects.map((p) => toDTO(p as never)) });
    }),
  );

  router.post(
    '/projects',
    asyncHandler(async (req: Request, res: Response) => {
      const { auth } = req as AuthedRequest;
      const parsed = createProjectSchema.safeParse(req.body);
      if (!parsed.success) throw zodErrorToApiError(parsed.error);

      // Slug carries a random suffix, so a collision is a ~1-in-16M retry
      // rather than a user-visible error. Retry once, then give up loudly.
      let created;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          created = await Project.create({
            ownerId: auth.user._id,
            name: parsed.data.name,
            domain: parsed.data.domain,
            slug: generateSlug(parsed.data.name),
            apiKey: generateApiKey(),
          });
          break;
        } catch (err) {
          const isDuplicate = (err as { code?: number }).code === 11000;
          if (!isDuplicate || attempt === 1) {
            if (isDuplicate) throw ApiError.conflict('Could not allocate a unique project slug');
            throw err;
          }
        }
      }

      log.info('project created', { projectId: String(created!._id), ownerId: String(auth.user._id) });
      res.status(201).json({ project: toDTO(created!.toObject() as never) });
    }),
  );

  router.get(
    '/projects/:projectId',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ project: toDTO((req as ProjectRequest).project.toObject() as never) });
    }),
  );

  router.patch(
    '/projects/:projectId',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = updateProjectSchema.safeParse(req.body);
      if (!parsed.success) throw zodErrorToApiError(parsed.error);

      const { project } = req as ProjectRequest;
      if (parsed.data.name !== undefined) project.name = parsed.data.name;
      if (parsed.data.domain !== undefined) project.domain = parsed.data.domain;
      await project.save();

      // The cached entry holds the domain (used for referrer normalisation),
      // so it is now stale on this instance.
      deps.projectCache.invalidate(project.apiKey);
      res.json({ project: toDTO(project.toObject() as never) });
    }),
  );

  /** Rotate the API key. The old key stops working as soon as caches expire. */
  router.post(
    '/projects/:projectId/rotate-key',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const { project } = req as ProjectRequest;
      const oldKey = project.apiKey;
      project.apiKey = generateApiKey();
      await project.save();
      deps.projectCache.invalidate(oldKey);
      log.info('api key rotated', { projectId: String(project._id) });
      res.json({ project: toDTO(project.toObject() as never) });
    }),
  );

  router.delete(
    '/projects/:projectId',
    requireProjectAccess,
    asyncHandler(async (req: Request, res: Response) => {
      const { project } = req as ProjectRequest;
      const projectId = project._id;

      const monitors = await Monitor.find({ projectId }, { _id: 1 }).lean();
      const monitorIds = monitors.map((m) => m._id);

      /*
       * Independent deletes across five collections with no ordering
       * constraint between them — nothing reads a partially deleted project,
       * because the Project document itself is removed last and every read
       * path starts from it. Running them concurrently turns five round trips
       * into one wait.
       */
      await Promise.all([
        Event.deleteMany({ projectId }),
        DailyRollup.deleteMany({ projectId }),
        Check.deleteMany({ monitorId: { $in: monitorIds } }),
        Monitor.deleteMany({ projectId }),
        invalidateAnalyticsCache(String(projectId)),
      ]);
      await Project.deleteOne({ _id: projectId });

      deps.projectCache.invalidate(project.apiKey);
      log.info('project deleted', { projectId: String(projectId), monitors: monitorIds.length });
      res.status(204).end();
    }),
  );

  return router;
}
