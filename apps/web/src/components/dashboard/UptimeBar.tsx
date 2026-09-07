import { uptimeTier } from '@pulse/shared';
import { formatPercent } from '@/lib/format';

export interface DailyUptime {
  date: string;
  uptimePct: number | null;
  totalChecks: number;
  failedChecks: number;
}

const TIER_COLORS = {
  operational: 'var(--positive)',
  degraded: 'var(--warning)',
  down: 'var(--negative)',
  unknown: 'var(--border-strong)',
} as const;

/**
 * The 90-day uptime strip.
 *
 * A day with no checks is rendered in the "unknown" grey, never green. A
 * status page that paints missing data as healthy is worse than one that has
 * no data at all, because it invites trust it has not earned.
 */
export function UptimeBar({ days, label }: { days: DailyUptime[]; label: string }) {
  const measured = days.filter((day) => day.uptimePct !== null);
  const overall =
    measured.length > 0
      ? measured.reduce((sum, day) => sum + (day.uptimePct ?? 0), 0) / measured.length
      : null;

  return (
    <div>
      <div
        className="flex items-end gap-[2px] overflow-hidden"
        role="img"
        aria-label={`${label}: ${
          overall === null ? 'no data' : `${formatPercent(overall)} uptime`
        } over the last ${days.length} days`}
      >
        {days.map((day) => {
          const tier = uptimeTier(day.uptimePct);
          return (
            <div
              key={day.date}
              className="h-8 min-w-[3px] flex-1 rounded-[2px]"
              style={{ backgroundColor: TIER_COLORS[tier] }}
              // Native tooltip: cheap, keyboard-reachable via the aria-label
              // above, and needs no JS.
              title={
                day.uptimePct === null
                  ? `${day.date}: no data`
                  : `${day.date}: ${formatPercent(day.uptimePct)} (${day.failedChecks}/${day.totalChecks} failed)`
              }
            />
          );
        })}
      </div>
      <div
        className="mt-1.5 flex justify-between text-[11px]"
        style={{ color: 'var(--ink-subtle)' }}
        aria-hidden="true"
      >
        <span>{days.length} days ago</span>
        <span>{overall === null ? 'No data' : `${formatPercent(overall)} uptime`}</span>
        <span>Today</span>
      </div>
    </div>
  );
}
