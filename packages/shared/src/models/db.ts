import mongoose from 'mongoose';

/**
 * Next.js dev mode and the Express service both re-enter this module, so the
 * connection promise is cached on `globalThis`. Without this, hot reload opens
 * a new pool on every edit and Mongo eventually refuses connections.
 */
type ConnCache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };

const globalForMongoose = globalThis as unknown as { __pulseMongoose?: ConnCache };
const cache: ConnCache = (globalForMongoose.__pulseMongoose ??= { conn: null, promise: null });

export interface ConnectOptions {
  uri?: string;
  /** Build the indexes declared on the schemas. Off in prod: see below. */
  autoIndex?: boolean;
}

export async function connectToDatabase(options: ConnectOptions = {}): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  const uri = options.uri ?? process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
  }

  if (!cache.promise) {
    // autoIndex in production would have every booting instance attempt to
    // build indexes on the hot Event collection at once. Default it to dev only
    // and create indexes deliberately via `npm run db:indexes`.
    const autoIndex = options.autoIndex ?? process.env.NODE_ENV !== 'production';

    cache.promise = mongoose
      .connect(uri, {
        autoIndex,
        // The ingest service can burst; give it room but keep a floor so the
        // 2-second buffer flush never waits on pool acquisition.
        maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE ?? 20),
        minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE ?? 2),
        serverSelectionTimeoutMS: 10_000,
      })
      .then((m) => m);
  }

  try {
    cache.conn = await cache.promise;
  } catch (err) {
    // Clear the cached rejection so the next call retries instead of
    // replaying the same failed promise forever.
    cache.promise = null;
    throw err;
  }

  return cache.conn;
}

export async function disconnectFromDatabase(): Promise<void> {
  if (cache.conn) {
    await cache.conn.disconnect();
  }
  cache.conn = null;
  cache.promise = null;
}

export { mongoose };
