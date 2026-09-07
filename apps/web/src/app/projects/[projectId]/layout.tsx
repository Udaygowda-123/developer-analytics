'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { use } from 'react';
import type { ProjectDTO } from '@pulse/shared';
import { AppShell } from '@/components/AppShell';
import { LiveCounter } from '@/components/dashboard/LiveCounter';
import { useApi } from '@/lib/use-api';

const TABS = [
  { href: '', label: 'Analytics' },
  { href: '/monitors', label: 'Monitors' },
  { href: '/settings', label: 'Settings' },
] as const;

export default function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  // Next 15 passes params as a promise to layouts; `use` unwraps it.
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const pathname = usePathname();
  const { data } = useApi<{ project: ProjectDTO }>(`/api/projects/${projectId}`);

  const base = `/projects/${projectId}`;

  return (
    <AppShell
      breadcrumb={
        <ol className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink-subtle)' }}>
          <li>
            <Link href="/projects">Projects</Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="truncate" style={{ color: 'var(--ink)' }} aria-current="page">
            {data?.project.name ?? '…'}
          </li>
        </ol>
      }
      actions={<LiveCounter projectId={projectId} />}
    >
      <nav aria-label="Project sections" className="mb-6 flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {TABS.map((tab) => {
          const href = `${base}${tab.href}`;
          const active = tab.href === '' ? pathname === base : pathname.startsWith(href);
          return (
            <Link
              key={tab.label}
              href={href}
              aria-current={active ? 'page' : undefined}
              className="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors"
              style={{
                borderColor: active ? 'var(--accent)' : 'transparent',
                color: active ? 'var(--ink)' : 'var(--ink-subtle)',
              }}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </AppShell>
  );
}
