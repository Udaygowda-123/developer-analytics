import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBuffer } from './eventBuffer.js';

interface TestEvent {
  n: number;
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

function makeBuffer(overrides: Partial<{ maxSize: number; maxAgeMs: number; maxPending: number }> = {}) {
  const batches: TestEvent[][] = [];
  const buffer = new EventBuffer<TestEvent>({
    maxSize: overrides.maxSize ?? 500,
    maxAgeMs: overrides.maxAgeMs ?? 2_000,
    ...(overrides.maxPending !== undefined ? { maxPending: overrides.maxPending } : {}),
    logger: silentLogger,
    flushFn: async (batch) => {
      batches.push([...batch]);
    },
  });
  return { buffer, batches };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('size trigger', () => {
  it('does not flush before reaching maxSize', () => {
    const { buffer, batches } = makeBuffer({ maxSize: 500 });
    for (let i = 0; i < 499; i++) buffer.push({ n: i });
    expect(batches).toHaveLength(0);
    expect(buffer.size).toBe(499);
  });

  it('flushes exactly at maxSize', async () => {
    const { buffer, batches } = makeBuffer({ maxSize: 500 });
    for (let i = 0; i < 500; i++) buffer.push({ n: i });
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0]).toHaveLength(500);
    expect(buffer.size).toBe(0);
  });

  it('splits a large burst into whole batches', async () => {
    const { buffer, batches } = makeBuffer({ maxSize: 100 });
    for (let i = 0; i < 1000; i++) buffer.push({ n: i });
    await vi.waitFor(() => expect(batches).toHaveLength(10));
    expect(batches.every((b) => b.length === 100)).toBe(true);
    // Nothing lost, nothing duplicated.
    const seen = batches.flat().map((e) => e.n).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });
});

describe('age trigger', () => {
  it('flushes after maxAgeMs even with a single event', async () => {
    const { buffer, batches } = makeBuffer({ maxAgeMs: 2_000 });
    buffer.push({ n: 1 });
    expect(batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([{ n: 1 }]);
  });

  it('arms the timer on the first event of a batch, not on every push', async () => {
    // This is the property that stops a steady trickle from deferring the flush
    // forever: 10 events arriving 500ms apart must still flush 2s after the
    // *first* one, not 2s after the last.
    const { buffer, batches } = makeBuffer({ maxAgeMs: 2_000, maxSize: 1_000 });

    buffer.push({ n: 0 });
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(500);
      buffer.push({ n: i });
    }
    // 1500ms elapsed, nothing flushed yet.
    expect(batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(4);
  });

  it('re-arms for the next batch after a flush', async () => {
    const { buffer, batches } = makeBuffer({ maxAgeMs: 1_000 });
    buffer.push({ n: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(batches).toHaveLength(1);

    buffer.push({ n: 2 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([{ n: 2 }]);
  });

  it('cancels the pending timer when a size flush fires first', async () => {
    const { buffer, batches } = makeBuffer({ maxSize: 3, maxAgeMs: 1_000 });
    buffer.push({ n: 1 });
    buffer.push({ n: 2 });
    buffer.push({ n: 3 });
    await vi.waitFor(() => expect(batches).toHaveLength(1));

    // The age timer must not fire an empty second flush.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(batches).toHaveLength(1);
  });
});

describe('flush semantics', () => {
  it('is a no-op when empty', async () => {
    const { buffer, batches } = makeBuffer();
    await buffer.flush();
    expect(batches).toHaveLength(0);
  });

  it('does not lose events pushed while a flush is in flight', async () => {
    const started: number[] = [];
    // One resolver per flush — the second flush must not overwrite the first's,
    // or the test would silently only unblock one of them.
    const releases: Array<() => void> = [];
    const batches: TestEvent[][] = [];

    const buffer = new EventBuffer<TestEvent>({
      maxSize: 2,
      maxAgeMs: 10_000,
      logger: silentLogger,
      flushFn: async (batch) => {
        started.push(batch.length);
        await new Promise<void>((resolve) => releases.push(resolve));
        batches.push([...batch]);
      },
    });

    buffer.push({ n: 1 });
    buffer.push({ n: 2 }); // triggers a flush that is now blocked
    await vi.waitFor(() => expect(started).toHaveLength(1));

    // These arrive mid-flush; they belong to the *next* batch, not this one.
    buffer.push({ n: 3 });
    buffer.push({ n: 4 });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(buffer.size).toBe(0);

    for (const release of releases) release();
    await vi.waitFor(() => expect(batches).toHaveLength(2));

    const all = batches.flat().map((e) => e.n).sort();
    expect(all).toEqual([1, 2, 3, 4]);
  });

  it('drops a failed batch loudly rather than retrying it', async () => {
    let attempts = 0;
    const buffer = new EventBuffer<TestEvent>({
      maxSize: 2,
      maxAgeMs: 10_000,
      logger: silentLogger,
      flushFn: async () => {
        attempts += 1;
        throw new Error('mongo is down');
      },
    });

    buffer.push({ n: 1 });
    buffer.push({ n: 2 });
    await vi.waitFor(() => expect(attempts).toBe(1));

    // No retry: a second flush would only happen for new events.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toBe(1);

    const stats = buffer.getStats();
    expect(stats.failedFlushes).toBe(1);
    expect(stats.eventsDropped).toBe(2);
    expect(stats.eventsFlushed).toBe(0);
  });
});

describe('back-pressure', () => {
  it('sheds events past maxPending instead of growing without bound', async () => {
    let releaseFlush: (() => void) | null = null;
    const buffer = new EventBuffer<TestEvent>({
      // maxSize high enough that pushes never trigger a size flush on their own.
      maxSize: 1_000_000,
      maxAgeMs: 10_000,
      maxPending: 10,
      logger: silentLogger,
      flushFn: async () => {
        await new Promise<void>((resolve) => {
          releaseFlush = resolve;
        });
      },
    });

    const accepted: boolean[] = [];
    for (let i = 0; i < 15; i++) accepted.push(buffer.push({ n: i }));

    expect(accepted.filter(Boolean)).toHaveLength(10);
    expect(accepted.filter((a) => !a)).toHaveLength(5);
    expect(buffer.getStats().eventsDropped).toBe(5);

    releaseFlush?.();
  });
});

describe('close (SIGTERM path)', () => {
  it('flushes whatever is buffered', async () => {
    const { buffer, batches } = makeBuffer({ maxSize: 500, maxAgeMs: 10_000 });
    for (let i = 0; i < 7; i++) buffer.push({ n: i });
    expect(batches).toHaveLength(0);

    await buffer.close();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(7);
  });

  it('waits for a flush that was already in flight', async () => {
    let finished = false;
    let release: (() => void) | null = null;
    const buffer = new EventBuffer<TestEvent>({
      maxSize: 2,
      maxAgeMs: 10_000,
      logger: silentLogger,
      flushFn: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        finished = true;
      },
    });

    buffer.push({ n: 1 });
    buffer.push({ n: 2 });
    await vi.waitFor(() => expect(release).not.toBeNull());

    const closing = buffer.close();
    release?.();
    await closing;

    expect(finished).toBe(true);
  });

  it('rejects events after close so a shutdown cannot be extended', async () => {
    const { buffer, batches } = makeBuffer();
    buffer.push({ n: 1 });
    await buffer.close();

    expect(buffer.push({ n: 2 })).toBe(false);
    expect(buffer.isClosed).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(batches).toHaveLength(1);
  });

  it('is safe to close twice', async () => {
    const { buffer } = makeBuffer();
    buffer.push({ n: 1 });
    await buffer.close();
    await expect(buffer.close()).resolves.toBeUndefined();
  });
});

describe('stats', () => {
  it('tracks flushes and events', async () => {
    const { buffer } = makeBuffer({ maxSize: 5, maxAgeMs: 10_000 });
    for (let i = 0; i < 12; i++) buffer.push({ n: i });
    await vi.waitFor(() => expect(buffer.getStats().flushes).toBe(2));

    await buffer.close();
    const stats = buffer.getStats();
    expect(stats.flushes).toBe(3);
    expect(stats.eventsFlushed).toBe(12);
    expect(stats.eventsDropped).toBe(0);
    expect(stats.buffered).toBe(0);
  });
});
