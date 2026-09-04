import { createServer } from 'node:http';
import { connectToDatabase, disconnectFromDatabase } from '@pulse/shared/models';
import { createApp } from './app.js';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import { closeRedis } from './redis.js';
import { buildServices } from './services.js';
import { registerCronJobs, type CronHandles } from './jobs/cron.js';
import { createRealtimeServer, type RealtimeServer } from './realtime/wsServer.js';

const log = createLogger('boot');

async function main(): Promise<void> {
  const cfg = getConfig();

  await connectToDatabase();
  log.info('database connected');

  const services = buildServices();
  const app = createApp(services);
  const server = createServer(app);

  const realtime: RealtimeServer = createRealtimeServer(server);
  const cron: CronHandles | null = cfg.DISABLE_CRON ? null : registerCronJobs();

  await new Promise<void>((resolve) => server.listen(cfg.PORT, resolve));
  log.info('ingest service listening', { port: cfg.PORT, env: cfg.NODE_ENV });

  /**
   * Graceful shutdown.
   *
   * The buffer flush is the load-bearing step: without it, every rolling
   * deploy silently discards up to one full buffer of events per instance,
   * which shows up as an unexplained dip in exactly the graphs this product
   * sells. Order matters — stop accepting new work, then drain, then close the
   * connections the drain depends on.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal, buffered: services.buffer.size });

    // Force-exit backstop: if a socket refuses to close we still must not hang
    // a deploy indefinitely.
    const forceExit = setTimeout(() => {
      log.warn('shutdown timed out, forcing exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    try {
      cron?.stop();

      // 1. Stop taking new requests. In-flight ones are allowed to finish.
      await new Promise<void>((resolve) => server.close(() => resolve()));

      // 2. Drain the buffer. This is why SIGTERM handling exists at all.
      await services.buffer.close();
      log.info('event buffer drained', services.buffer.getStats());

      // 3. Tear down realtime and the backing connections.
      await realtime.close();
      await Promise.allSettled([disconnectFromDatabase(), closeRedis()]);

      clearTimeout(forceExit);
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error('error during shutdown', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  /*
   * An unhandled rejection leaves the process in an unknown state. Log it with
   * the stack, then shut down cleanly — which flushes the buffer — rather than
   * limping on or dying instantly.
   */
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', reason);
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', err);
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  log.error('failed to start', err);
  process.exit(1);
});
