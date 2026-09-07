'use client';

import { DATE_RANGES, type DateRange } from '@pulse/shared';
import { DATE_RANGE_LABELS } from '@/lib/constants';

const SHORT_LABELS: Record<DateRange, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
};

/**
 * Date range selector.
 *
 * A radiogroup rather than a row of buttons: these are mutually exclusive
 * options with exactly one active, which is what a radio group *is*. Arrow
 * keys move between them natively, and only the selected option is in the tab
 * order, so tabbing past the control takes one keystroke rather than four.
 */
export function RangePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  disabled?: boolean;
}) {
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const currentIndex = DATE_RANGES.indexOf(value);
    let nextIndex: number | null = null;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % DATE_RANGES.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + DATE_RANGES.length) % DATE_RANGES.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = DATE_RANGES.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      onChange(DATE_RANGES[nextIndex] as DateRange);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Date range"
      onKeyDown={handleKeyDown}
      className="inline-flex rounded-lg border p-0.5"
      style={{ backgroundColor: 'var(--surface-raised)', borderColor: 'var(--border)' }}
    >
      {DATE_RANGES.map((range) => {
        const selected = range === value;
        return (
          <button
            key={range}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={DATE_RANGE_LABELS[range]}
            // Roving tabindex: the group is one tab stop, not four.
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(range)}
            className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              backgroundColor: selected ? 'var(--accent-soft)' : 'transparent',
              color: selected ? 'var(--accent)' : 'var(--ink-muted)',
            }}
          >
            {SHORT_LABELS[range]}
          </button>
        );
      })}
    </div>
  );
}
