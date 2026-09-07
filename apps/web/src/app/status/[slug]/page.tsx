import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { UptimeWindow } from '@pulse/shared';
import { UptimeBar, type DailyUptime } from '@/components/dashboard/UptimeBar';
import { INGEST_URL } from '@/lib/constants';
import { formatLatency, formatPercent, formatRelativeTime } from '@/lib/format';

/**
 * Public status page.
 *
 * A server component with no auth and no client JavaScript: this is the page
 * people load *during an incident*, which is exactly when the origin is under
 * load and a visitor's connection is the least reliable. Rendering it on the
 * server and caching it for 30 seconds means a thundering herd costs one
 * upstream request rather than thousands.
 */

interface StatusMonitor {
  id: string;
  name: string;
  state: 'up' | 'down' | 'paused' | 'unknown';
  lastCheckedAt: string | null;
  lastLatencyMs: number | null;
  uptime: UptimeWindow[];
  daily: DailyUptime[];
  incidents: Array<{
    startedAt: string;
    endedAt: string | null;
    failedChecks: number;
    lastError: string | null;
  }>;
}

interface StatusResponse {
  project: { name: string; slug: string };
  overall: 'operational' | 'degraded' | 'unknown';
  generatedAt: string;
  monitors: StatusMonitor[];
}

// ISR: regenerate at most every 30 seconds. Matches the Cache-Control the API
// sets, so the two layers do not disagree about freshness.
export const revalidate = 30;

async function fetchStatus(slug: string): Promise<StatusResponse | null> {
  try {
    const response = await fetch(`${INGEST_URL}/api/status/${encodeURIComponent(slug)}`, {
      next: { revalidate: 30 },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Status API returned ${response.status}`);
    return (await response.json()) as StatusResponse;
  } catch {
    // A failure here must not render a stack trace to the public. The page
    // falls back to an honest "cannot determine status" below.
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const status = await fetchStatus(slug);
  return {
    title: status ? `${status.project.name} status` : 'Status',
    description: status ? `Live service status for ${status.project.name}.` : undefined,
    // A status page has no business being indexed under someone's brand name.
    robots: { index: false, follow: false },
  };
}

const OVERALL = {
  operational: { label: 'All systems operational', color: 'var(--positive)' },
  degraded: { label: 'Some systems are down', color: 'var(--negative)' },
  unknown: { label: 'Status unknown', color: 'var(--ink-subtle)' },
} as const;

const MONITOR_STATE = {
  up: { label: 'Operational', color: 'var(--positive)' },
  down: { label: 'Down', color: 'var(--negative)' },
  paused: { label: 'Paused', color: 'var(--ink-subtle)' },
  unknown: { label: 'No data', color: 'var(--ink-subtle)' },
} as const;

export default async function StatusPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const status = await fetchStatus(slug);

  if (!status) notFound();

  const overall = OVERALL[status.overall];

  return (
    <div className="min-h-screen">
      <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16">
        <header className="mb-8">
          <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--ink-subtle)' }}>
            {status.project.name}
          </p>
          <h1 className="mt-1 flex items-center gap-2.5 text-2xl font-semibold" style={{ color: 'var(--ink)' }}>
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-full"
              style={{ backgroundColor: overall.color }}
            />
            {overall.label}
          </h1>
          <p className="mt-1.5 text-xs" style={{ color: 'var(--ink-subtle)' }}>
            {/* A fixed UTC label, not a relative one: this page is cached and
                server-rendered, so "12 seconds ago" would be a lie by the time
                anyone read it. */}
            Last updated{' '}
            <time dateTime={status.generatedAt}>
              {new Date(status.generatedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC
            </time>
          </p>
        </header>

        {status.monitors.length === 0 ? (
          <p
            className="rounded-xl border px-4 py-8 text-center text-sm"
            style={{ borderColor: 'var(--border)', color: 'var(--ink-subtle)' }}
          >
            No monitors are configured for this project yet.
          </p>
        ) : (
          <ul className="space-y-4">
            {status.monitors.map((monitor) => {
              const state = MONITOR_STATE[monitor.state];
              const thirtyDay = monitor.uptime.find((w) => w.window === '30d');

              return (
                <li
                  key={monitor.id}
                  className="rounded-xl border p-4 sm:p-5"
                  style={{ backgroundColor: 'var(--surface-raised)', borderColor: 'var(--border)' }}
                >
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                      {monitor.name}
                    </h2>
                    <span className="text-xs font-medium" style={{ color: state.color }}>
                      {state.label}
                    </span>
                  </div>

                  <UptimeBar days={monitor.daily} label={monitor.name} />

                  <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs">
                    {monitor.uptime.map((window) => (
                      <div key={window.window} className="flex gap-1.5">
                        <dt style={{ color: 'var(--ink-subtle)' }}>{window.window}</dt>
                        <dd className="tabular-nums" style={{ color: 'var(--ink)' }}>
                          {window.totalChecks === 0 ? '—' : formatPercent(window.uptimePct)}
                        </dd>
                      </div>
                    ))}
                    <div className="flex gap-1.5">
                      <dt style={{ color: 'var(--ink-subtle)' }}>Latency</dt>
                      <dd className="tabular-nums" style={{ color: 'var(--ink)' }}>
                        {formatLatency(thirtyDay?.avgLatencyMs ?? monitor.lastLatencyMs)}
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt style={{ color: 'var(--ink-subtle)' }}>Checked</dt>
                      <dd style={{ color: 'var(--ink)' }}>{formatRelativeTime(monitor.lastCheckedAt)}</dd>
                    </div>
                  </dl>

                  {monitor.incidents.length > 0 ? (
                    <details className="mt-4">
                      <summary className="cursor-pointer text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {monitor.incidents.length} recent incident
                        {monitor.incidents.length === 1 ? '' : 's'}
                      </summary>
                      <ul className="mt-2 space-y-1.5">
                        {monitor.incidents.map((incident) => (
                          <li key={incident.startedAt} className="text-xs" style={{ color: 'var(--ink-subtle)' }}>
                            <time dateTime={incident.startedAt}>
                              {new Date(incident.startedAt).toISOString().slice(0, 16).replace('T', ' ')}
                            </time>
                            {' — '}
                            {incident.endedAt ? 'resolved' : 'ongoing'}
                            {', '}
                            {incident.failedChecks} failed check
                            {incident.failedChecks === 1 ? '' : 's'}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <footer className="mt-10 text-center text-xs" style={{ color: 'var(--ink-subtle)' }}>
          Status powered by Pulse
        </footer>
      </main>
    </div>
  );
}
