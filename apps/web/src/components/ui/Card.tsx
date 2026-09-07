import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article';
}) {
  return (
    <Tag
      className={`rounded-xl border p-4 sm:p-5 ${className}`}
      style={{ backgroundColor: 'var(--surface-raised)', borderColor: 'var(--border)' }}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  description,
  action,
  /** Links the card's <section> to its heading for screen readers. */
  id,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-subtle)' }}>
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
