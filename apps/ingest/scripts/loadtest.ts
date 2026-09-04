/**
 * Fires N events at a running ingest service and reports what happened.
 *
 * This is the thing worth demoing: it shows that `/collect` answers in
 * microseconds because it never touches the database on the request path, and
 * that the buffer turns tens of thousands of events into a couple of hundred
 * `insertMany` calls.
 *
 * Usage:
 *   npm run loadtest                       # 10,000 events at concurrency 50
 *   EVENTS=50000 CONCURRENCY=200 npm run loadtest
 *
 * Requires the service to be running (`npm run dev`) and an API key:
 *   PULSE_API_KEY=pk_live_... npm run loadtest
 */

const TARGET = process.env.LOADTEST_TARGET ?? 'http://localhost:4000';
const EVENTS = Number(process.env.EVENTS ?? 10_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const API_KEY = process.env.PULSE_API_KEY ?? '';

const PATHS = ['/', '/pricing', '/docs', '/blog/launch', '/features', '/changelog'];
const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
];
const COUNTRIES = ['US', 'GB', 'DE', 'IN', 'CA', 'FR', 'AU', 'JP'];

interface Outcome {
  status: number;
  latencyMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

async function fireOne(index: number): Promise<Outcome> {
  const startedAt = performance.now();
  const response = await fetch(`${TARGET}/collect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pulse-Key': API_KEY,
      'user-agent': UAS[index % UAS.length]!,
      // Vary the IP so the session hash produces a realistic spread of
      // distinct visitors rather than one enormous session.
      'x-forwarded-for': `10.${index % 251}.${(index >> 8) % 251}.${(index >> 16) % 251}`,
      'cf-ipcountry': COUNTRIES[index % COUNTRIES.length]!,
    },
    body: JSON.stringify({
      type: 'pageview',
      path: PATHS[index % PATHS.length],
      referrer: index % 3 === 0 ? 'https://news.ycombinator.com/' : null,
      screenWidth: index % 2 === 0 ? 1920 : 390,
    }),
  });

  return { status: response.status, latencyMs: performance.now() - startedAt };
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('Set PULSE_API_KEY to a pk_live_ key (npm run seed prints one).');
    process.exit(1);
  }

  // Confirm the service is up before firing, so a connection-refused storm
  // does not get reported as "0ms p50".
  try {
    const health = await fetch(`${TARGET}/health`);
    if (!health.ok) throw new Error(`health check returned ${health.status}`);
  } catch (err) {
    console.error(`Cannot reach ${TARGET}. Is the ingest service running?\n  ${String(err)}`);
    process.exit(1);
  }

  console.log(`\n  Firing ${EVENTS.toLocaleString()} events at ${TARGET} (concurrency ${CONCURRENCY})\n`);

  const outcomes: Outcome[] = [];
  const startedAt = performance.now();
  let cursor = 0;

  // Same shared-cursor pool as the monitor scheduler: bounded concurrency,
  // no idle workers.
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= EVENTS) return;
        try {
          outcomes.push(await fireOne(index));
        } catch {
          outcomes.push({ status: 0, latencyMs: 0 });
        }
      }
    }),
  );

  const totalMs = performance.now() - startedAt;
  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const byStatus = new Map<number, number>();
  for (const o of outcomes) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);

  const accepted = byStatus.get(202) ?? 0;
  const rateLimited = byStatus.get(429) ?? 0;
  const failed = outcomes.length - accepted - rateLimited;

  // Read the buffer's own counters so the report shows the batching working,
  // not just the client-side view.
  let bufferStats: unknown = null;
  try {
    bufferStats = (await (await fetch(`${TARGET}/health`)).json() as { buffer?: unknown }).buffer;
  } catch {
    /* health is best-effort here */
  }

  console.log(`  Wall clock        ${(totalMs / 1000).toFixed(2)} s`);
  console.log(`  Throughput        ${Math.round(outcomes.length / (totalMs / 1000)).toLocaleString()} req/s`);
  console.log('');
  console.log(`  202 Accepted      ${accepted.toLocaleString()}`);
  console.log(`  429 Rate limited  ${rateLimited.toLocaleString()}`);
  console.log(`  Failed            ${failed.toLocaleString()}`);
  console.log('');
  console.log(`  Latency p50       ${percentile(latencies, 50).toFixed(2)} ms`);
  console.log(`  Latency p95       ${percentile(latencies, 95).toFixed(2)} ms`);
  console.log(`  Latency p99       ${percentile(latencies, 99).toFixed(2)} ms`);
  console.log(`  Latency max       ${(latencies[latencies.length - 1] ?? 0).toFixed(2)} ms`);
  console.log('');
  console.log('  Buffer stats     ', JSON.stringify(bufferStats));
  console.log('');

  if (rateLimited > 0) {
    console.log(
      `  Note: ${rateLimited.toLocaleString()} requests were rate limited. That is the limiter\n` +
        '  working as designed (100 req / 10s per key). Raise RATE_LIMIT_MAX to\n' +
        '  measure raw ingestion throughput.\n',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
