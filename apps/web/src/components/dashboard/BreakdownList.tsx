'use client';

import type { LabelledCount } from '@pulse/shared';
import { formatCount } from '@/lib/format';
import { EmptyState } from '@/components/ui/States';

interface BreakdownListProps {
  items: LabelledCount[];
  /** Renders the label — lets countries add a flag, referrers add a favicon. */
  renderLabel?: (label: string) => React.ReactNode;
  emptyTitle: string;
  emptyDescription?: string;
  /** Accessible name for the list, since the visible heading is on the card. */
  ariaLabel: string;
}

/**
 * A ranked list with an inline proportion bar.
 *
 * The bar is scaled against the largest item rather than the total: with a
 * long tail, scaling to the total makes every row after the first a
 * one-pixel sliver, which conveys nothing. Scaling to the max makes the
 * *relative* ordering readable, which is the question this widget answers.
 */
export function BreakdownList({
  items,
  renderLabel,
  emptyTitle,
  emptyDescription,
  ariaLabel,
}: BreakdownListProps) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} {...(emptyDescription ? { description: emptyDescription } : {})} />;
  }

  const max = Math.max(...items.map((item) => item.count), 1);
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <ul className="space-y-1" aria-label={ariaLabel}>
      {items.map((item) => {
        const share = total > 0 ? Math.round((item.count / total) * 1000) / 10 : 0;
        return (
          <li key={item.label} className="relative">
            <div className="relative flex items-center justify-between gap-3 rounded-md px-2 py-1.5">
              {/* Decorative: the number beside it carries the same information,
                  so the bar must not be announced separately. */}
              <div
                aria-hidden="true"
                className="absolute inset-y-0 left-0 rounded-md"
                style={{
                  width: `${(item.count / max) * 100}%`,
                  backgroundColor: 'var(--accent-soft)',
                }}
              />
              <span
                className="relative min-w-0 truncate text-xs"
                style={{ color: 'var(--ink)' }}
                title={item.label}
              >
                {renderLabel ? renderLabel(item.label) : item.label}
              </span>
              <span
                className="relative shrink-0 text-xs tabular-nums"
                style={{ color: 'var(--ink-muted)' }}
              >
                {formatCount(item.count)}
                <span className="sr-only-focusable absolute">{` (${share}% of shown)`}</span>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
