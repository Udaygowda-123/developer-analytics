import { describe, expect, it } from 'vitest';
import { percentChange, uptimePercentage, uptimeTier } from './uptime.js';

describe('uptimePercentage', () => {
  it('is 100 when nothing failed', () => {
    expect(uptimePercentage({ totalChecks: 288, failedChecks: 0 })).toBe(100);
  });

  it('is 0 when everything failed', () => {
    expect(uptimePercentage({ totalChecks: 10, failedChecks: 10 })).toBe(0);
  });

  it('computes a partial outage to 3 decimals', () => {
    // 1 failure in 2880 five-minute checks over 10 days.
    expect(uptimePercentage({ totalChecks: 2880, failedChecks: 1 })).toBe(99.965);
  });

  it('truncates rather than rounds, so a real outage never shows as 100%', () => {
    // 1 in 200_000 is 99.9995%, which rounds to 100.000 but must not display so.
    const pct = uptimePercentage({ totalChecks: 200_000, failedChecks: 1 });
    expect(pct).toBe(99.999);
    expect(pct).toBeLessThan(100);
  });

  it('returns null with no checks rather than claiming 100%', () => {
    expect(uptimePercentage({ totalChecks: 0, failedChecks: 0 })).toBeNull();
    expect(uptimePercentage({ totalChecks: -5, failedChecks: 0 })).toBeNull();
    expect(uptimePercentage({ totalChecks: Number.NaN, failedChecks: 0 })).toBeNull();
  });

  it('clamps nonsensical failure counts instead of returning a negative percentage', () => {
    expect(uptimePercentage({ totalChecks: 10, failedChecks: 25 })).toBe(0);
    expect(uptimePercentage({ totalChecks: 10, failedChecks: -3 })).toBe(100);
  });
});

describe('uptimeTier', () => {
  it('maps percentages to SLA tiers', () => {
    expect(uptimeTier(null)).toBe('unknown');
    expect(uptimeTier(100)).toBe('operational');
    expect(uptimeTier(99.9)).toBe('operational');
    expect(uptimeTier(99.899)).toBe('degraded');
    expect(uptimeTier(95)).toBe('degraded');
    expect(uptimeTier(94.999)).toBe('down');
    expect(uptimeTier(0)).toBe('down');
  });
});

describe('percentChange', () => {
  it('computes growth to one decimal', () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(90, 100)).toBe(-10);
    expect(percentChange(1234, 1000)).toBe(23.4);
  });

  it('returns null when the previous period was zero', () => {
    expect(percentChange(500, 0)).toBeNull();
  });

  it('is zero for no change', () => {
    expect(percentChange(100, 100)).toBe(0);
  });
});
