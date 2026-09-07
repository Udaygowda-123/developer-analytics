import { formatChange } from '@/lib/format';

interface StatTileProps {
  label: string;
  value: string;
  changePct?: number | null;
  hint?: string;
  /** Whether an increase is good. Downtime going up is not a win. */
  higherIsBetter?: boolean;
}

export function StatTile({ label, value, changePct, hint, higherIsBetter = true }: StatTileProps) {
  const change = changePct === undefined ? null : formatChange(changePct);

  const changeColor =
    !change || change.direction === 'none' || change.direction === 'flat'
      ? 'var(--ink-subtle)'
      : (change.direction === 'up') === higherIsBetter
        ? 'var(--positive)'
        : 'var(--negative)';

  return (
    <div
      className="rounded-xl border p-4"
      style={{ backgroundColor: 'var(--surface-raised)', borderColor: 'var(--border)' }}
    >
      <p className="text-xs font-medium" style={{ color: 'var(--ink-subtle)' }}>
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>
        {value}
      </p>
      {change ? (
        <p className="mt-1 flex items-center gap-1 text-xs" style={{ color: changeColor }}>
          {change.direction === 'up' || change.direction === 'down' ? (
            <span aria-hidden="true">{change.direction === 'up' ? '↑' : '↓'}</span>
          ) : null}
          {/* The arrow is decorative; the label carries the meaning, and the
              sr-only suffix says what it is compared against. */}
          <span>{change.label}</span>
          <span className="sr-only-focusable absolute">compared with the previous period</span>
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs" style={{ color: 'var(--ink-subtle)' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
