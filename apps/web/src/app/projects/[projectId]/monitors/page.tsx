'use client';

import { use, useCallback, useState } from 'react';
import type { MonitorStatus } from '@pulse/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useApi, useApiMutation } from '@/lib/use-api';
import { formatLatency, formatPercent, formatRelativeTime } from '@/lib/format';

const STATE_STYLES = {
  up: { label: 'Operational', color: 'var(--positive)' },
  down: { label: 'Down', color: 'var(--negative)' },
  paused: { label: 'Paused', color: 'var(--ink-subtle)' },
  unknown: { label: 'Awaiting first check', color: 'var(--ink-subtle)' },
} as const;

export default function MonitorsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const [creating, setCreating] = useState(false);

  const { data, state, error, refetch } = useApi<{ monitors: MonitorStatus[] }>(
    `/api/projects/${projectId}/monitors`,
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>
            Monitors
          </h1>
          <p className="text-xs" style={{ color: 'var(--ink-subtle)' }}>
            We alert after three consecutive failures, at most once an hour.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          Add monitor
        </Button>
      </div>

      {creating ? (
        <CreateMonitorForm
          projectId={projectId}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refetch();
          }}
        />
      ) : null}

      {state.status === 'loading' ? (
        <Card>
          <LoadingState label="Loading monitors" rows={4} />
        </Card>
      ) : state.status === 'error' ? (
        <Card>
          <ErrorState error={error!} onRetry={refetch} title="Could not load monitors" />
        </Card>
      ) : data!.monitors.length === 0 ? (
        <Card>
          <EmptyState
            title="No monitors yet"
            description="Add a URL and we will check it on a schedule, record latency, and email you when it goes down."
            action={<Button onClick={() => setCreating(true)}>Add your first monitor</Button>}
          />
        </Card>
      ) : (
        <ul className="space-y-4">
          {data!.monitors.map((entry) => (
            <li key={entry.monitor.id}>
              <MonitorCard projectId={projectId} entry={entry} onChanged={refetch} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MonitorCard({
  projectId,
  entry,
  onChanged,
}: {
  projectId: string;
  entry: MonitorStatus;
  onChanged: () => void;
}) {
  const { monitor, currentState, lastCheck, uptime } = entry;
  const presentation = STATE_STYLES[currentState];

  const checkNow = useApiMutation<unknown, void>(
    useCallback(
      () => ({
        path: `/api/projects/${projectId}/monitors/${monitor.id}/check`,
        method: 'POST' as const,
      }),
      [projectId, monitor.id],
    ),
  );

  const togglePause = useApiMutation<unknown, boolean>(
    useCallback(
      (isPaused: boolean) => ({
        path: `/api/projects/${projectId}/monitors/${monitor.id}`,
        method: 'PATCH' as const,
        body: { isPaused },
      }),
      [projectId, monitor.id],
    ),
  );

  const remove = useApiMutation<unknown, void>(
    useCallback(
      () => ({
        path: `/api/projects/${projectId}/monitors/${monitor.id}`,
        method: 'DELETE' as const,
      }),
      [projectId, monitor.id],
    ),
  );

  return (
    <Card as="article">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: presentation.color }}
            />
            <h2 className="truncate text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              {monitor.name}
            </h2>
            <span className="text-xs" style={{ color: presentation.color }}>
              {presentation.label}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--ink-subtle)' }} title={monitor.url}>
            {monitor.url}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            loading={checkNow.isPending}
            onClick={async () => {
              await checkNow.mutate();
              onChanged();
            }}
          >
            Check now
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={togglePause.isPending}
            onClick={async () => {
              await togglePause.mutate(!monitor.isPaused);
              onChanged();
            }}
          >
            {monitor.isPaused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={remove.isPending}
            onClick={async () => {
              // A native confirm rather than a modal: destructive and
              // infrequent, and the browser's own dialog is unambiguously
              // keyboard accessible.
              if (!window.confirm(`Delete "${monitor.name}" and all of its check history?`)) return;
              await remove.mutate();
              onChanged();
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {uptime.map((window) => (
          <div key={window.window}>
            <dt className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--ink-subtle)' }}>
              {window.window} uptime
            </dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>
              {window.totalChecks === 0 ? '—' : formatPercent(window.uptimePct)}
            </dd>
          </div>
        ))}
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--ink-subtle)' }}>
            Last check
          </dt>
          <dd className="mt-0.5 text-sm tabular-nums" style={{ color: 'var(--ink)' }}>
            {lastCheck ? formatLatency(lastCheck.latencyMs) : '—'}
            <span className="ml-1 text-xs" style={{ color: 'var(--ink-subtle)' }}>
              {formatRelativeTime(monitor.lastCheckedAt)}
            </span>
          </dd>
        </div>
      </dl>

      {lastCheck && !lastCheck.ok && lastCheck.error ? (
        <p
          className="mt-3 rounded-lg border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--negative)', color: 'var(--negative)' }}
          role="status"
        >
          {lastCheck.error}
        </p>
      ) : null}
    </Card>
  );
}

function CreateMonitorForm({
  projectId,
  onCancel,
  onCreated,
}: {
  projectId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(300);
  const [expectedStatus, setExpectedStatus] = useState(200);

  const { mutate, isPending, error } = useApiMutation<unknown, Record<string, unknown>>(
    useCallback(
      (body: Record<string, unknown>) => ({
        path: `/api/projects/${projectId}/monitors`,
        method: 'POST' as const,
        body,
      }),
      [projectId],
    ),
  );

  const inputClass = 'w-full rounded-lg border px-3 py-2 text-sm outline-none';
  const inputStyle = {
    backgroundColor: 'var(--surface)',
    borderColor: 'var(--border-strong)',
    color: 'var(--ink)',
  };

  return (
    <Card>
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await mutate({ name, url, intervalSeconds, expectedStatus });
            onCreated();
          } catch {
            /* rendered below */
          }
        }}
      >
        <CardHeader title="New monitor" />

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="monitor-name" className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Name
            </label>
            <input
              id="monitor-name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              style={inputStyle}
              placeholder="API health"
            />
          </div>
          <div>
            <label htmlFor="monitor-url" className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              URL
            </label>
            <input
              id="monitor-url"
              required
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={inputClass}
              style={inputStyle}
              placeholder="https://api.example.com/health"
            />
          </div>
          <div>
            <label htmlFor="monitor-interval" className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Check every
            </label>
            <select
              id="monitor-interval"
              value={intervalSeconds}
              onChange={(e) => setIntervalSeconds(Number(e.target.value))}
              className={inputClass}
              style={inputStyle}
            >
              <option value={60}>1 minute</option>
              <option value={300}>5 minutes</option>
              <option value={900}>15 minutes</option>
            </select>
          </div>
          <div>
            <label htmlFor="monitor-status" className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Expected status
            </label>
            <input
              id="monitor-status"
              type="number"
              min={100}
              max={599}
              value={expectedStatus}
              onChange={(e) => setExpectedStatus(Number(e.target.value))}
              className={inputClass}
              style={inputStyle}
            />
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-xs" style={{ color: 'var(--negative)' }}>
            {error.details?.[0]?.message ?? error.message}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" size="sm" loading={isPending}>
            Add monitor
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
