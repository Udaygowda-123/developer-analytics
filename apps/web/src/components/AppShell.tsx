'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/Button';

/** Header + main region shared by every authenticated page. */
export function AppShell({
  children,
  breadcrumb,
  actions,
}: {
  children: ReactNode;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
}) {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      router.push('/login');
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header
        className="sticky top-0 z-30 border-b backdrop-blur"
        style={{ backgroundColor: 'color-mix(in srgb, var(--surface) 85%, transparent)', borderColor: 'var(--border)' }}
      >
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <Link
            href="/projects"
            className="flex shrink-0 items-center gap-2 text-sm font-semibold"
            style={{ color: 'var(--ink)' }}
          >
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: 'var(--accent)' }}
            />
            Pulse
          </Link>

          {breadcrumb ? (
            <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
              {breadcrumb}
            </nav>
          ) : (
            <div className="flex-1" />
          )}

          <div className="flex items-center gap-2">
            {actions}
            {user?.email ? (
              <span
                className="hidden max-w-[16ch] truncate text-xs sm:inline"
                style={{ color: 'var(--ink-subtle)' }}
                title={user.email}
              >
                {user.email}
              </span>
            ) : null}
            <Button variant="ghost" size="sm" onClick={handleSignOut} loading={signingOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
