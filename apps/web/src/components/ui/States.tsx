import type { ReactNode } from 'react';
import type { ApiClientError } from '@/lib/api';

/**
 * The four states every widget must handle. Having them as shared components
 * is what makes "loading, empty, error and populated" a habit rather than
 * something remembered per widget.
 */

export function Skeleton({ className = '' }: { className?: string }) {
  // aria-hidden: a skeleton is a visual placeholder. The live region on the
  // widget announces "Loading" once; announcing every grey box would be noise.
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function LoadingState({
  label,
  rows = 5,
  variant = 'list',
}: {
  label: string;
  rows?: number;
  variant?: 'list' | 'chart' | 'tiles';
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only-focusable absolute">{label}</span>
      {variant === 'chart' ? (
        <div className="flex h-64 items-end gap-1.5" aria-hidden="true">
          {/* Varied heights so the placeholder reads as a chart, not a block. */}
          {Array.from({ length: 24 }).map((_, i) => (
            <Skeleton
              key={i}
              className="flex-1"
              // Deterministic pseudo-random heights: a real random() would make
              // the skeleton flicker on every re-render.
              {...{ style: { height: `${30 + ((i * 37) % 60)}%` } }}
            />
          ))}
        </div>
      ) : variant === 'tiles' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: rows }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : (
        <div className="space-y-2.5">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-10" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      {icon ? (
        <div className="mb-3" style={{ color: 'var(--ink-subtle)' }} aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
        {title}
      </p>
      {description ? (
        <p className="mt-1 max-w-sm text-xs leading-relaxed" style={{ color: 'var(--ink-subtle)' }}>
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = 'Could not load this',
}: {
  error: ApiClientError | Error;
  onRetry?: () => void;
  title?: string;
}) {
  const retryable = 'isRetryable' in error ? error.isRetryable : true;

  return (
    // role="alert" so an error that appears after load is announced rather
    // than silently replacing the content.
    <div role="alert" className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <p className="text-sm font-medium" style={{ color: 'var(--negative)' }}>
        {title}
      </p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed" style={{ color: 'var(--ink-subtle)' }}>
        {error.message}
      </p>
      {onRetry && retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--ink)' }}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
