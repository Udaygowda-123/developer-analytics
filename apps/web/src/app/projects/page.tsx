'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { ProjectDTO } from '@pulse/shared';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useApi, useApiMutation } from '@/lib/use-api';

export default function ProjectsPage() {
  const { data, state, error, refetch } = useApi<{ projects: ProjectDTO[] }>('/api/projects');
  const [creating, setCreating] = useState(false);

  return (
    <AppShell
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          New project
        </Button>
      }
    >
      <div className="mb-6">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>
          Projects
        </h1>
        <p className="mt-0.5 text-sm" style={{ color: 'var(--ink-subtle)' }}>
          Each project gets its own API key, dashboard and status page.
        </p>
      </div>

      {creating ? (
        <CreateProjectForm
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refetch();
          }}
        />
      ) : null}

      {state.status === 'loading' ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <LoadingState label="Loading projects" rows={3} />
            </Card>
          ))}
        </div>
      ) : state.status === 'error' ? (
        <Card>
          <ErrorState error={error!} onRetry={refetch} title="Could not load your projects" />
        </Card>
      ) : data!.projects.length === 0 ? (
        <Card>
          <EmptyState
            title="No projects yet"
            description="Create one to get an API key and a tracking snippet."
            action={<Button onClick={() => setCreating(true)}>Create your first project</Button>}
          />
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data!.projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`} className="block h-full">
                <Card className="h-full transition-colors hover:border-[var(--border-strong)]">
                  <p className="truncate text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                    {project.name}
                  </p>
                  <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--ink-subtle)' }}>
                    {project.domain}
                  </p>
                  <p className="mt-4 text-xs" style={{ color: 'var(--ink-subtle)' }}>
                    Created {new Date(project.createdAt).toLocaleDateString()}
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}

function CreateProjectForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (project: ProjectDTO) => void;
}) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');

  const buildRequest = useCallback(
    (input: { name: string; domain: string }) => ({
      path: '/api/projects',
      method: 'POST' as const,
      body: input,
    }),
    [],
  );
  const { mutate, isPending, error } = useApiMutation<{ project: ProjectDTO }, { name: string; domain: string }>(
    buildRequest,
  );

  const inputClass = 'w-full rounded-lg border px-3 py-2 text-sm outline-none';
  const inputStyle = {
    backgroundColor: 'var(--surface)',
    borderColor: 'var(--border-strong)',
    color: 'var(--ink)',
  };

  return (
    <Card className="mb-6">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const result = await mutate({ name, domain });
            onCreated(result.project);
          } catch {
            // The hook holds the error; it is rendered below.
          }
        }}
        className="space-y-3"
      >
        <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          New project
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="project-name" className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Name
            </label>
            <input
              id="project-name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              style={inputStyle}
              placeholder="Marketing site"
            />
          </div>
          <div>
            <label htmlFor="project-domain" className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Domain
            </label>
            <input
              id="project-domain"
              required
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className={inputClass}
              style={inputStyle}
              placeholder="example.com"
              aria-describedby="project-domain-hint"
            />
            <p id="project-domain-hint" className="mt-1 text-[11px]" style={{ color: 'var(--ink-subtle)' }}>
              Used to recognise self-referrals. No https:// needed.
            </p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-xs" style={{ color: 'var(--negative)' }}>
            {error.details?.[0]?.message ?? error.message}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" size="sm" loading={isPending}>
            Create project
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
