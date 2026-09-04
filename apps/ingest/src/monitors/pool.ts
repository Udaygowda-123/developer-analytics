/**
 * A bounded concurrency pool, implemented here rather than pulled from npm so
 * the back-pressure behaviour is explicit and testable.
 *
 * The problem it solves: when the scheduler wakes and finds 500 monitors due,
 * neither obvious option works.
 *
 *   - Sequentially (`for … await`) at up to 10s per check is 83 minutes for one
 *     sweep. Every monitor misses its interval and the product does not work.
 *   - All at once (`Promise.all(all500)`) opens 500 concurrent sockets, blows
 *     through the file-descriptor limit, and — because they all resolve at
 *     roughly the same moment — writes 500 Check documents in one burst. It
 *     also makes us look like an attacker to anyone hosting several of the
 *     targets.
 *
 * A fixed number of workers pulling from a shared queue gives steady, bounded
 * resource use: exactly `size` sockets in flight, work starting the instant a
 * slot frees rather than at the end of a batch.
 *
 * Note the workers pull from a shared index rather than being handed a
 * pre-sliced chunk each. Chunking would leave workers idle whenever their chunk
 * happened to contain fast checks, and the whole sweep would take as long as
 * the slowest chunk.
 */

export interface PoolResult<R> {
  results: Array<PromiseSettledResult<R>>;
  durationMs: number;
}

export async function runWithPool<T, R>(
  items: readonly T[],
  size: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PoolResult<R>> {
  const startedAt = Date.now();
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);

  if (items.length === 0) {
    return { results, durationMs: Date.now() - startedAt };
  }

  const concurrency = Math.max(1, Math.min(Math.floor(size), items.length));
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      // `cursor++` is atomic with respect to other workers because JS is
      // single-threaded and there is no await between the read and the write.
      const index = cursor++;
      if (index >= items.length) return;

      const item = items[index] as T;
      try {
        results[index] = { status: 'fulfilled', value: await worker(item, index) };
      } catch (reason) {
        // A worker must never die: one failed check has to leave the other
        // nine workers draining the queue.
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, runWorker));

  return { results, durationMs: Date.now() - startedAt };
}
