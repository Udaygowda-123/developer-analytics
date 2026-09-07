import type { DateRange } from '@pulse/shared';

/** Presentation helpers. Pure, so they are unit-testable and SSR-safe. */

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 1000) return String(value);
  if (Math.abs(value) < 1_000_000) {
    const thousands = value / 1000;
    // 1.2k, but 12k rather than 12.0k — a decimal that is always zero is noise.
    return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
}

/**
 * Full precision with locale separators, for headline numbers.
 *
 * `formatCount` deliberately loses precision (12,480 → "12k") because it is
 * built for axis ticks and list rows where space is the constraint. A summary
 * tile has the room, and rounding the headline figure while the chart beneath
 * it shows the real shape is how a dashboard starts contradicting itself.
 */
export function formatExact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

export function formatPercent(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function formatChange(value: number | null): { label: string; direction: 'up' | 'down' | 'flat' | 'none' } {
  if (value === null) return { label: 'No prior data', direction: 'none' };
  if (value === 0) return { label: 'No change', direction: 'flat' };
  const direction = value > 0 ? 'up' : 'down';
  return { label: `${value > 0 ? '+' : ''}${value}%`, direction };
}

export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/**
 * Axis labels for a time series.
 *
 * Rendered in the user's selected timezone, not the browser's — the whole
 * point of asking the server to bucket by timezone is undone if the axis then
 * relabels the buckets in a different one.
 */
export function formatBucketLabel(iso: string, range: DateRange, timeZone: string): string {
  const date = new Date(iso);
  if (range === '24h') {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone }).format(date);
}

export function formatBucketTooltip(iso: string, range: DateRange, timeZone: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    ...(range === '24h'
      ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    timeZone,
  }).format(date);
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const deltaMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return seconds <= 5 ? 'just now' : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The browser's IANA timezone, with a safe fallback for odd environments. */
export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function countryName(code: string): string {
  if (code === 'unknown') return 'Unknown';
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function countryFlag(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return '🌐';
  // Regional indicator symbols are 0x1F1E6 ('A') upward.
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
