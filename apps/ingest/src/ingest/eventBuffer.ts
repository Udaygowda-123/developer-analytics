import { createLogger, type Logger } from '../logger.js';

/**
 * In-memory write buffer for the ingestion hot path.
 *
 * Why buffer at all: a pageview is ~200 bytes, and an `insertMany` of 500 of
 * them costs almost exactly the same round trip as an `insertOne` of one. The
 * per-write cost is dominated by network latency and the journal commit, not by
 * document size. Writing per-request caps us at roughly (pool size / RTT)
 * inserts per second — around 2k/s on a 10ms link with a 20-connection pool,
 * and every one of those requests holds a connection while it waits. Batching
 * 500 at a time turns 500 round trips into one, so the same pool sustains
 * two orders of magnitude more events, and `/collect` returns in microseconds
 * because it never touches the database at all.
 *
 * The cost is a bounded durability window: up to `maxSize` events or
 * `maxAgeMs` of events can be lost if the process is killed uncleanly. For
 * product analytics that is an acceptable trade — losing 2 seconds of pageviews
 * during a hard crash changes no decision anyone makes from this data. It would
 * not be acceptable for billing events, and this is the wrong design for those.
 *
 * Two triggers, whichever comes first:
 *   - size:  the buffer reaches `maxSize` (default 500) — bounds memory and
 *            keeps a traffic spike from growing the batch without limit
 *   - time:  `maxAgeMs` (default 2000ms) since the first event in the batch —
 *            bounds staleness so a low-traffic site's events still land
 *            promptly instead of waiting for 500 visitors to show up
 *
 * The timer is armed when a batch *starts*, not restarted on every push, so a
 * steady trickle of events cannot postpone the flush indefinitely.
 */

export interface BufferedEvent {
  [key: string]: unknown;
}

export interface EventBufferOptions<T> {
  maxSize?: number;
  maxAgeMs?: number;
  /** Performs the actual write. Injected so tests need no database. */
  flushFn: (batch: T[]) => Promise<void>;
  logger?: Logger;
  /**
   * Hard ceiling on buffered events while a flush is in flight. Beyond this we
   * shed load rather than grow the heap without bound — an unbounded queue in
   * front of a slow database is how a service turns a blip into an OOM kill.
   */
  maxPending?: number;
}

export interface BufferStats {
  buffered: number;
  flushes: number;
  eventsFlushed: number;
  eventsDropped: number;
  failedFlushes: number;
  inFlight: number;
}

export class EventBuffer<T = BufferedEvent> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Tracks in-flight flushes so `close()` can await genuinely everything. */
  private inFlight = new Set<Promise<void>>();

  private readonly maxSize: number;
  private readonly maxAgeMs: number;
  private readonly maxPending: number;
  private readonly flushFn: (batch: T[]) => Promise<void>;
  private readonly log: Logger;

  private stats = { flushes: 0, eventsFlushed: 0, eventsDropped: 0, failedFlushes: 0 };

  constructor(options: EventBufferOptions<T>) {
    this.maxSize = options.maxSize ?? 500;
    this.maxAgeMs = options.maxAgeMs ?? 2_000;
    this.maxPending = options.maxPending ?? this.maxSize * 20;
    this.flushFn = options.flushFn;
    this.log = options.logger ?? createLogger('ingest:buffer');
  }

  /**
   * Adds an event. Never awaits the database — returns synchronously so the
   * HTTP handler can reply 202 immediately.
   *
   * Returns false if the event was shed under back-pressure.
   */
  push(event: T): boolean {
    if (this.closed) {
      this.stats.eventsDropped += 1;
      return false;
    }

    if (this.buffer.length >= this.maxPending) {
      this.stats.eventsDropped += 1;
      // Warn, not error: shedding load is the designed behaviour, but it should
      // be visible in the logs because it means the writer cannot keep up.
      this.log.warn('event dropped, buffer at capacity', {
        maxPending: this.maxPending,
        dropped: this.stats.eventsDropped,
      });
      return false;
    }

    this.buffer.push(event);

    if (this.buffer.length >= this.maxSize) {
      void this.flush('size');
      return true;
    }

    // Arm the age timer only when this event opens a new batch. Re-arming on
    // every push would let continuous traffic defer the flush forever.
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush('age');
      }, this.maxAgeMs);
      // Do not hold the event loop open purely for a pending flush timer.
      this.timer.unref?.();
    }

    return true;
  }

  /**
   * Drains the current buffer and writes it.
   *
   * The buffer is swapped out *synchronously* before the first await, so events
   * arriving during the write go into the next batch instead of being written
   * twice or lost.
   */
  async flush(reason: 'size' | 'age' | 'manual' | 'shutdown' = 'manual'): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    const work = (async () => {
      const startedAt = Date.now();
      try {
        await this.flushFn(batch);
        this.stats.flushes += 1;
        this.stats.eventsFlushed += batch.length;
        this.log.debug('flushed', {
          reason,
          count: batch.length,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        this.stats.failedFlushes += 1;
        this.stats.eventsDropped += batch.length;
        // Deliberately not re-queued. A failed batch is usually a symptom of a
        // database that is down or overloaded; retrying would amplify the load
        // and the retry queue would grow without bound. Analytics events are
        // the right thing to drop here, loudly.
        this.log.error('flush failed, batch dropped', err, {
          reason,
          count: batch.length,
          durationMs: Date.now() - startedAt,
        });
      }
    })();

    this.inFlight.add(work);
    work.finally(() => this.inFlight.delete(work)).catch(() => {});

    await work;
  }

  /**
   * Flushes everything and stops accepting new events.
   *
   * Called from the SIGTERM handler: without this, a rolling deploy silently
   * discards up to `maxSize` events per instance on every release, which shows
   * up as an unexplained traffic dip in exactly the graphs this product sells.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush('shutdown');
    // Await flushes that were already running when close() was called.
    await Promise.allSettled([...this.inFlight]);
  }

  get size(): number {
    return this.buffer.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  getStats(): BufferStats {
    return { ...this.stats, buffered: this.buffer.length, inFlight: this.inFlight.size };
  }
}
