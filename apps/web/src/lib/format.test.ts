import { describe, expect, it } from 'vitest';
import {
  countryFlag,
  countryName,
  formatBucketLabel,
  formatBucketTooltip,
  formatChange,
  formatCount,
  formatExact,
  formatLatency,
  formatPercent,
  formatRelativeTime,
} from './format';

describe('formatCount', () => {
  it('leaves small numbers alone', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });

  it('abbreviates thousands, dropping a decimal that is always zero', () => {
    expect(formatCount(1200)).toBe('1.2k');
    expect(formatCount(9900)).toBe('9.9k');
    expect(formatCount(12_480)).toBe('12k');
  });

  it('abbreviates millions', () => {
    expect(formatCount(1_500_000)).toBe('1.5M');
    expect(formatCount(24_000_000)).toBe('24M');
  });

  it('returns a dash rather than NaN', () => {
    expect(formatCount(Number.NaN)).toBe('—');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatExact', () => {
  it('keeps full precision', () => {
    expect(formatExact(12_480)).toBe((12_480).toLocaleString());
    expect(formatExact(0)).toBe('0');
  });
});

describe('formatPercent', () => {
  it('formats to two decimals by default', () => {
    expect(formatPercent(99.9995)).toBe('100.00%');
    expect(formatPercent(99.965)).toBe('99.97%');
  });

  it('renders null as a dash, never as zero', () => {
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatChange', () => {
  it('signs the value and reports a direction', () => {
    expect(formatChange(23.4)).toEqual({ label: '+23.4%', direction: 'up' });
    expect(formatChange(-5.1)).toEqual({ label: '-5.1%', direction: 'down' });
  });

  it('says "no change" rather than "+0%"', () => {
    expect(formatChange(0)).toEqual({ label: 'No change', direction: 'flat' });
  });

  it('says there is no prior data instead of implying infinite growth', () => {
    expect(formatChange(null)).toEqual({ label: 'No prior data', direction: 'none' });
  });
});

describe('formatLatency', () => {
  it('uses ms below a second and seconds above', () => {
    expect(formatLatency(95)).toBe('95 ms');
    expect(formatLatency(999)).toBe('999 ms');
    expect(formatLatency(1500)).toBe('1.50 s');
  });

  it('renders null as a dash', () => {
    expect(formatLatency(null)).toBe('—');
  });
});

describe('formatBucketLabel', () => {
  it('labels 24h buckets by hour in the requested timezone, not the browser default', () => {
    const utc = formatBucketLabel('2024-06-15T14:00:00.000Z', '24h', 'UTC');
    const tokyo = formatBucketLabel('2024-06-15T14:00:00.000Z', '24h', 'Asia/Tokyo');
    // 14:00Z is 23:00 in Tokyo — the labels must differ, or the axis would
    // silently contradict the server's timezone-aware bucketing.
    expect(utc).not.toBe(tokyo);
  });

  it('labels day buckets by date', () => {
    const label = formatBucketLabel('2024-06-15T00:00:00.000Z', '7d', 'UTC');
    expect(label).toMatch(/Jun/);
    expect(label).toMatch(/15/);
  });

  it('uses the same timezone in the tooltip as the axis', () => {
    const tooltip = formatBucketTooltip('2024-06-15T00:00:00.000Z', '7d', 'UTC');
    expect(tooltip).toMatch(/Jun/);
    expect(tooltip).toMatch(/2024/);
  });
});

describe('formatRelativeTime', () => {
  it('says "never" for a null timestamp', () => {
    expect(formatRelativeTime(null)).toBe('never');
  });

  it('describes recent times coarsely', () => {
    expect(formatRelativeTime(new Date(Date.now() - 2_000).toISOString())).toBe('just now');
    expect(formatRelativeTime(new Date(Date.now() - 90_000).toISOString())).toBe('2m ago');
    expect(formatRelativeTime(new Date(Date.now() - 7_200_000).toISOString())).toBe('2h ago');
    expect(formatRelativeTime(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe('3d ago');
  });
});

describe('country helpers', () => {
  it('resolves a code to a display name', () => {
    expect(countryName('US')).toMatch(/United States/);
    expect(countryName('unknown')).toBe('Unknown');
  });

  it('renders a flag emoji for a valid code and a globe otherwise', () => {
    expect(countryFlag('GB')).toBe('🇬🇧');
    expect(countryFlag('unknown')).toBe('🌐');
    expect(countryFlag('xyz')).toBe('🌐');
  });
});
