'use client';

import { use, useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProjectDTO } from '@pulse/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { useApi, useApiMutation } from '@/lib/use-api';
import { INGEST_URL } from '@/lib/constants';

export default function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const router = useRouter();
  const { data, state, error, refetch } = useApi<{ project: ProjectDTO }>(
    `/api/projects/${projectId}`,
  );

  if (state.status === 'loading') {
    return (
      <Card>
        <LoadingState label="Loading settings" rows={5} />
      </Card>
    );
  }
  if (state.status === 'error') {
    return (
      <Card>
        <ErrorState error={error!} onRetry={refetch} title="Could not load settings" />
      </Card>
    );
  }

  const project = data!.project;

  return (
    <div className="space-y-5">
      <SnippetCard project={project} />
      <ApiKeyCard project={project} onRotated={refetch} />
      <StatusPageCard project={project} />
      <DangerZone project={project} onDeleted={() => router.push('/projects')} />
    </div>
  );
}

function SnippetCard({ project }: { project: ProjectDTO }) {
  const snippet = `<script defer\n  src="${INGEST_URL}/pulse.js"\n  data-key="${project.apiKey}"\n  data-host="${INGEST_URL}"></script>`;

  return (
    <Card as="section">
      <CardHeader
        title="Tracking snippet"
        description="Paste this before </head>. It is under 2 KB and loads deferred, so it never blocks rendering."
      />
      <CopyBlock value={snippet} label="tracking snippet" />
      <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--ink-subtle)' }}>
        Pageviews are tracked automatically, including client-side navigations. For custom events
        call <code>window.pulse.track(&apos;signup&apos;, &#123; plan: &apos;pro&apos; &#125;)</code>.
      </p>
    </Card>
  );
}

function ApiKeyCard({ project, onRotated }: { project: ProjectDTO; onRotated: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const { mutate, isPending } = useApiMutation<{ project: ProjectDTO }, void>(
    useCallback(
      () => ({ path: `/api/projects/${project.id}/rotate-key`, method: 'POST' as const }),
      [project.id],
    ),
  );

  const masked = `${project.apiKey.slice(0, 12)}${'•'.repeat(20)}${project.apiKey.slice(-4)}`;

  return (
    <Card as="section">
      <CardHeader
        title="API key"
        description="Authenticates events sent to /collect. Treat it as a credential."
        action={
          <Button
            size="sm"
            variant="secondary"
            loading={isPending}
            onClick={async () => {
              if (
                !window.confirm(
                  'Rotate the API key? The current key stops working within a minute, and any snippet still using it will stop sending events.',
                )
              ) {
                return;
              }
              await mutate();
              onRotated();
            }}
          >
            Rotate
          </Button>
        }
      />
      <CopyBlock value={project.apiKey} display={revealed ? project.apiKey : masked} label="API key" />
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        className="mt-2 text-xs underline"
        style={{ color: 'var(--ink-subtle)' }}
      >
        {revealed ? 'Hide' : 'Reveal'} key
      </button>
    </Card>
  );
}

function StatusPageCard({ project }: { project: ProjectDTO }) {
  const url = `/status/${project.slug}`;
  return (
    <Card as="section">
      <CardHeader
        title="Public status page"
        description="Shareable and unauthenticated. Shows monitor state and uptime — never the URLs being monitored."
      />
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-sm underline"
        style={{ color: 'var(--accent)' }}
      >
        {url}
      </a>
    </Card>
  );
}

function DangerZone({ project, onDeleted }: { project: ProjectDTO; onDeleted: () => void }) {
  const [confirmText, setConfirmText] = useState('');
  const { mutate, isPending, error } = useApiMutation<void, void>(
    useCallback(() => ({ path: `/api/projects/${project.id}`, method: 'DELETE' as const }), [project.id]),
  );

  // Typing the name is deliberate friction: this deletes every event, rollup,
  // monitor and check, and none of it is recoverable.
  const canDelete = confirmText === project.name;

  return (
    <Card as="section" className="border-[var(--negative)]">
      <CardHeader
        title="Delete this project"
        description="Removes every event, rollup, monitor and check. This cannot be undone."
      />
      <label htmlFor="confirm-delete" className="mb-1 block text-xs" style={{ color: 'var(--ink-muted)' }}>
        Type <strong>{project.name}</strong> to confirm
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="confirm-delete"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
          style={{
            backgroundColor: 'var(--surface)',
            borderColor: 'var(--border-strong)',
            color: 'var(--ink)',
          }}
        />
        <Button
          variant="danger"
          disabled={!canDelete}
          loading={isPending}
          onClick={async () => {
            await mutate();
            onDeleted();
          }}
        >
          Delete project
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--negative)' }}>
          {error.message}
        </p>
      ) : null}
    </Card>
  );
}

function CopyBlock({
  value,
  display,
  label,
}: {
  value: string;
  display?: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-start gap-2">
      <pre
        className="min-w-0 flex-1 overflow-x-auto rounded-lg border px-3 py-2 text-xs"
        style={{
          backgroundColor: 'var(--surface-muted)',
          borderColor: 'var(--border)',
          color: 'var(--ink)',
        }}
      >
        <code>{display ?? value}</code>
      </pre>
      <Button
        size="sm"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard access can be denied (insecure context, permissions).
            // Fail quietly — the value is selectable on screen either way.
          }
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {/* Announces the result to screen readers, which cannot see the button
          label change. */}
      <span aria-live="polite" className="sr-only-focusable absolute">
        {copied ? `${label} copied to clipboard` : ''}
      </span>
    </div>
  );
}
