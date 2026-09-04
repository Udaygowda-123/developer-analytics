import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectToDatabase, disconnectFromDatabase, mongoose } from '@pulse/shared/models';

/**
 * A real MongoDB for integration tests.
 *
 * A replica set rather than a standalone: the aggregation operators we rely on
 * behave identically either way, but `mongodb-memory-server`'s replica-set mode
 * gives us the same topology as `docker-compose.yml`, so a test cannot pass
 * against a topology that production does not have.
 *
 * Pinned to 7.0 because `$dateTrunc` (5.0+) and `$sortArray` (5.2+) are both
 * load-bearing in the pipelines under test — an older default binary would fail
 * in a confusing way.
 */
let replSet: MongoMemoryReplSet | null = null;

export async function startTestMongo(): Promise<string> {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    binary: { version: '7.0.14' },
  });
  const uri = replSet.getUri();
  process.env.MONGODB_URI = uri;
  await connectToDatabase({ uri, autoIndex: true });
  // Build the declared indexes so tests exercise the same plans production does.
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
  return uri;
}

export async function stopTestMongo(): Promise<void> {
  await disconnectFromDatabase();
  await replSet?.stop();
  replSet = null;
}

/** Empty every collection between tests without paying to rebuild indexes. */
export async function clearTestMongo(): Promise<void> {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}
