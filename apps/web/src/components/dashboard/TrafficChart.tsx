'use client';

import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DateRange, TimeSeriesPoint } from '@pulse/shared';
import { formatBucketLabel, formatBucketTooltip, formatCount } from '@/lib/format';

interface TrafficChartProps {
  series: TimeSeriesPoint[];
  range: DateRange;
  timezone: string;
}

/**
 * Pageviews and unique visitors over time.
 *
 * Two series on one axis rather than a dual axis: visitors are always ≤
 * pageviews, so they share a scale honestly. A second y-axis would let the
 * lines cross in ways that imply a relationship the data does not contain.
 */
export function TrafficChart({ series, range, timezone }: TrafficChartProps) {
  const data = useMemo(
    () =>
      series.map((point) => ({
        ...point,
        label: formatBucketLabel(point.bucket, range, timezone),
        tooltipLabel: formatBucketTooltip(point.bucket, range, timezone),
      })),
    [series, range, timezone],
  );

  // Show every nth tick so labels never collide on a 90-day range or a narrow
  // screen. Recharts' own `interval="preserveStartEnd"` still overlaps at 90.
  const tickInterval = Math.max(0, Math.ceil(data.length / 8) - 1);

  /**
   * The chart itself is aria-hidden and paired with a real table in a visually
   * hidden container. An SVG of paths is not navigable by a screen reader
   * however many ARIA attributes it carries; a table of the same numbers is.
   */
  return (
    <div>
      <div className="h-64 w-full sm:h-72" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="pageviewsFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-series-1)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--color-series-1)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="visitorsFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-series-2)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--color-series-2)" stopOpacity={0} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              interval={tickInterval}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11 }}
              minTickGap={8}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={44}
              tick={{ fontSize: 11 }}
              tickFormatter={(value: number) => formatCount(value)}
              // Always include zero: a truncated y-axis exaggerates every
              // wiggle, which on a traffic chart is actively misleading.
              domain={[0, 'auto']}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
              contentStyle={{
                backgroundColor: 'var(--surface-raised)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                fontSize: '12px',
                color: 'var(--ink)',
              }}
              // Both callbacks declare `string` return types explicitly.
              // Without that, Recharts infers its `NameType` generic from the
              // returned string literals and then rejects the very callback it
              // inferred it from.
              labelFormatter={(_label: unknown, payload: ReadonlyArray<{ payload?: unknown }>): string =>
                (payload?.[0]?.payload as { tooltipLabel?: string } | undefined)?.tooltipLabel ?? ''
              }
              formatter={(value: number, name: string): [string, string] => [
                value.toLocaleString(),
                name === 'pageviews' ? 'Pageviews' : 'Unique visitors',
              ]}
            />
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
              formatter={(value: string) => (value === 'pageviews' ? 'Pageviews' : 'Unique visitors')}
            />
            <Area
              type="monotone"
              dataKey="pageviews"
              stroke="var(--color-series-1)"
              strokeWidth={2}
              fill="url(#pageviewsFill)"
              // Honour the OS preference rather than animating regardless.
              isAnimationActive={!prefersReducedMotion()}
            />
            <Area
              type="monotone"
              dataKey="uniqueVisitors"
              stroke="var(--color-series-2)"
              strokeWidth={2}
              fill="url(#visitorsFill)"
              isAnimationActive={!prefersReducedMotion()}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <table className="sr-only-focusable absolute">
        <caption>Pageviews and unique visitors over the selected period</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Pageviews</th>
            <th scope="col">Unique visitors</th>
          </tr>
        </thead>
        <tbody>
          {data.map((point) => (
            <tr key={point.bucket}>
              <th scope="row">{point.tooltipLabel}</th>
              <td>{point.pageviews}</td>
              <td>{point.uniqueVisitors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
