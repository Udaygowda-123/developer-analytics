import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type Express } from 'express';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createCollectRouter } from './ingest/collectRouter.js';
import { createProjectsRouter } from './routes/projects.js';
import { createAnalyticsRouter } from './routes/analytics.js';
import { createMonitorsRouter } from './routes/monitors.js';
import { createStatusRouter } from './routes/status.js';
import type { Services } from './services.js';

const log = createLogger('app');
const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(services: Services): Express {
  const cfg = getConfig();
  const app = express();

  /*
   * We read `x-forwarded-for` for the session hash, which is only trustworthy
   * behind a proxy that overwrites it. Setting this explicitly (rather than
   * leaving it off and reading the header anyway) documents the assumption and
   * makes `req.ip` consistent with what the geo helper does.
   */
  app.set('trust proxy', cfg.NODE_ENV === 'production' ? 1 : true);
  app.disable('x-powered-by');

  /*
   * Two CORS policies, because the two surfaces have opposite requirements.
   *
   * `/collect` and `/status` must accept requests from *any* origin — the whole
   * point is that a customer's website, on a domain we have never seen, can
   * post to it. There is no credential in a cookie to protect, so a wildcard is
   * safe here; the API key in the body is what authenticates.
   *
   * Everything else carries a Firebase ID token and is restricted to the
   * dashboard's own origins.
   */
  const publicCors = cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Pulse-Key'],
    maxAge: 86_400,
  });

  const dashboardCors = cors({
    origin: cfg.DASHBOARD_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  /*
   * A tight body limit on the ingestion path. The default 100kb is far more
   * than an event needs, and the limit is the cheapest possible defence
   * against someone posting megabytes at an endpoint that answers in
   * microseconds.
   */
  const collectBody = express.json({ limit: '16kb', type: ['application/json', 'text/plain'] });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      buffer: services.buffer.getStats(),
      projectCache: services.projectCache.getStats(),
    });
  });

  // The tracking snippet, served from this origin so a customer only has to
  // trust one host. Long cache with immutable semantics — the file is
  // versioned by content, not by URL, and changes rarely.
  app.use(
    '/',
    express.static(path.join(here, '../public'), {
      maxAge: '1h',
      setHeaders: (res) => res.setHeader('Access-Control-Allow-Origin', '*'),
    }),
  );

  app.use('/', publicCors, collectBody, createCollectRouter(services));
  app.use('/api', publicCors, createStatusRouter());

  const dashboardBody = express.json({ limit: '64kb' });
  app.use('/api', dashboardCors, dashboardBody, createProjectsRouter({ projectCache: services.projectCache }));
  app.use('/api', dashboardCors, dashboardBody, createAnalyticsRouter());
  app.use('/api', dashboardCors, dashboardBody, createMonitorsRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  log.info('express app created', { origins: cfg.DASHBOARD_ORIGINS });
  return app;
}
