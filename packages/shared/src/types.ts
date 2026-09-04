/**
 * Domain types shared by the dashboard (`apps/web`) and the ingestion service
 * (`apps/ingest`). These are deliberately plain — no Mongoose, no React — so
 * they can be imported from a browser bundle without dragging a driver along.
 */

export const EVENT_TYPES = ['pageview', 'custom'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const DEVICE_TYPES = ['desktop', 'mobile', 'tablet'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** Monitor check intervals we allow. Anything else is rejected at the boundary. */
export const MONITOR_INTERVALS = [60, 300, 900] as const;
export type MonitorInterval = (typeof MONITOR_INTERVALS)[number];

export const DATE_RANGES = ['24h', '7d', '30d', '90d'] as const;
export type DateRange = (typeof DATE_RANGES)[number];

export interface UserDTO {
  id: string;
  firebaseUid: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface ProjectDTO {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  domain: string;
  apiKey: string;
  createdAt: string;
}

export interface EventDTO {
  id: string;
  projectId: string;
  type: EventType;
  name: string;
  path: string;
  referrer: string | null;
  country: string | null;
  device: DeviceType | null;
  browser: string | null;
  os: string | null;
  sessionId: string;
  timestamp: string;
  meta: Record<string, unknown>;
}

export interface MonitorDTO {
  id: string;
  projectId: string;
  name: string;
  url: string;
  intervalSeconds: MonitorInterval;
  expectedStatus: number;
  isPaused: boolean;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  lastNotifiedAt: string | null;
  createdAt: string;
}

export interface CheckDTO {
  id: string;
  monitorId: string;
  statusCode: number | null;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  timestamp: string;
}

/* ------------------------------------------------------------------ *
 * Analytics response shapes
 * ------------------------------------------------------------------ */

export interface TimeSeriesPoint {
  /** ISO timestamp of the bucket start, in the caller's timezone offset. */
  bucket: string;
  pageviews: number;
  uniqueVisitors: number;
}

export interface LabelledCount {
  label: string;
  count: number;
}

export interface AnalyticsSummary {
  pageviews: number;
  uniqueVisitors: number;
  /** Percentage change vs. the immediately preceding window of equal length. */
  pageviewsChangePct: number | null;
  uniqueVisitorsChangePct: number | null;
}

export interface AnalyticsResponse {
  range: DateRange;
  timezone: string;
  /** Whether the numbers came from pre-aggregated rollups or raw events. */
  source: 'events' | 'rollups';
  from: string;
  to: string;
  summary: AnalyticsSummary;
  series: TimeSeriesPoint[];
  topPaths: LabelledCount[];
  topReferrers: LabelledCount[];
  countries: LabelledCount[];
  devices: LabelledCount[];
  browsers: LabelledCount[];
}

export interface UptimeWindow {
  window: '24h' | '7d' | '30d';
  uptimePct: number;
  totalChecks: number;
  failedChecks: number;
  avgLatencyMs: number | null;
}

export interface MonitorStatus {
  monitor: MonitorDTO;
  currentState: 'up' | 'down' | 'paused' | 'unknown';
  lastCheck: CheckDTO | null;
  uptime: UptimeWindow[];
}

/* ------------------------------------------------------------------ *
 * WebSocket protocol
 * ------------------------------------------------------------------ */

export type ClientMessage =
  | { type: 'subscribe'; token: string; projectId: string }
  | { type: 'unsubscribe'; projectId: string };

export type ServerMessage =
  | { type: 'subscribed'; projectId: string }
  | { type: 'unsubscribed'; projectId: string }
  | { type: 'active_visitors'; projectId: string; count: number; at: string }
  | { type: 'error'; code: string; message: string };

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Every API in this repo fails with this exact shape. No exceptions. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Field-level detail, present only for validation failures. */
    details?: Array<{ path: string; message: string }>;
  };
}

export const API_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'internal',
  'upstream_unavailable',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
