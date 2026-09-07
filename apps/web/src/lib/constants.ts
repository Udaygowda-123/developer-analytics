/** Navigation hint only — see the note in `auth-context.tsx`. Never trusted. */
export const SESSION_COOKIE = 'pulse_session';

export const INGEST_URL = process.env.NEXT_PUBLIC_INGEST_URL ?? 'http://localhost:4000';

export const INGEST_WS_URL =
  process.env.NEXT_PUBLIC_INGEST_WS_URL ?? INGEST_URL.replace(/^http/, 'ws') + '/ws';

export const DATE_RANGE_LABELS = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
} as const;
