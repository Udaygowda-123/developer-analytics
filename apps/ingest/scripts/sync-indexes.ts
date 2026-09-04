import { connectToDatabase, disconnectFromDatabase, mongoose } from '@pulse/shared/models';
import { createLogger } from '../src/logger.js';

const log = createLogger('indexes');

/**
 * Builds the indexes declared on the schemas.
 *
 * Run this deliberately rather than letting every booting instance do it:
 * `autoIndex` is off in production because a dozen instances all attempting to
 * build an index on the hot Event collection at once is a self-inflicted
 * outage. `syncIndexes` also drops indexes no longer declared, so this is the
 * one place index state is reconciled.
 */
async function main(): Promise<void> {
  await connectToDatabase({ autoIndex: false });

  for (const [name, model] of Object.entries(mongoose.models)) {
    const startedAt = Date.now();
    const dropped = await model.syncIndexes();
    const indexes = await model.listIndexes();
    log.info('indexes synced', {
      model: name,
      indexes: indexes.map((i) => i.name),
      dropped,
      durationMs: Date.now() - startedAt,
    });
  }

  await disconnectFromDatabase();
}

main().catch((err) => {
  log.error('index sync failed', err);
  process.exit(1);
});
