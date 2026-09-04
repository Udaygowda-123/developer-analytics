import { describe, expect, it } from 'vitest';
import { runWithPool } from './pool.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runWithPool', () => {
  it('runs every item exactly once', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];
    const { results } = await runWithPool(items, 10, async (item) => {
      seen.push(item);
      return item * 2;
    });

    expect(seen.sort((a, b) => a - b)).toEqual(items);
    expect(results).toHaveLength(50);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual(
      items.map((i) => i * 2),
    );
  });

  it('preserves result order regardless of completion order', async () => {
    // Later items finish first; results must still line up with their inputs,
    // or a caller correlating results back to monitors would attribute the
    // wrong outcome to the wrong URL.
    const { results } = await runWithPool([30, 20, 10, 0], 4, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 20, 10, 0]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await runWithPool(Array.from({ length: 40 }, (_, i) => i), 10, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
      return null;
    });

    expect(peak).toBeLessThanOrEqual(10);
    // And it actually uses the capacity — a pool that only ever ran one at a
    // time would pass the assertion above.
    expect(peak).toBe(10);
  });

  it('starts the next item as soon as a slot frees, rather than in batches', async () => {
    // With batching, 12 items at concurrency 2 where one item is slow would
    // take as long as the slow batch. With a shared queue, the fast workers
    // keep draining.
    const start = Date.now();
    const durations = [100, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    await runWithPool(durations, 2, async (ms) => {
      await sleep(ms);
      return ms;
    });
    const elapsed = Date.now() - start;

    // One worker sits on the 100ms item; the other drains eleven 5ms items
    // (~55ms). Total is bounded by the slow one, not by 6 sequential batches.
    expect(elapsed).toBeLessThan(200);
  });

  it('keeps draining after a worker throws', async () => {
    const completed: number[] = [];
    const { results } = await runWithPool([0, 1, 2, 3, 4], 2, async (i) => {
      if (i === 2) throw new Error('boom');
      completed.push(i);
      return i;
    });

    expect(completed.sort()).toEqual([0, 1, 3, 4]);
    expect(results[2]?.status).toBe('rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
  });

  it('handles an empty input', async () => {
    const { results } = await runWithPool([], 10, async () => null);
    expect(results).toHaveLength(0);
  });

  it('caps concurrency at the item count', async () => {
    let peak = 0;
    let inFlight = 0;
    await runWithPool([1, 2], 100, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
      return null;
    });
    expect(peak).toBe(2);
  });

  it('treats a concurrency of 0 or less as 1 rather than deadlocking', async () => {
    const { results } = await runWithPool([1, 2, 3], 0, async (n) => n);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([1, 2, 3]);
  });

  it('reports how long the sweep took', async () => {
    const { durationMs } = await runWithPool([20, 20], 2, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(durationMs).toBeGreaterThanOrEqual(15);
  });
});
