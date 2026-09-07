import type { ApiErrorBody, ApiErrorCode } from '@pulse/shared';
import { INGEST_URL } from './constants';

/**
 * Typed client for the ingest service's API.
 *
 * Every failure becomes an `ApiClientError` carrying the server's error code,
 * so components can branch on `error.code === 'unauthorized'` rather than
 * pattern-matching on message strings.
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | 'network';
  readonly details?: Array<{ path: string; message: string }>;

  constructor(
    status: number,
    code: ApiErrorCode | 'network',
    message: string,
    details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }

  /** True for failures a retry might fix; drives the "Try again" button. */
  get isRetryable(): boolean {
    return this.code === 'network' || this.status >= 500 || this.status === 429;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined>;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, INGEST_URL);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    // An AbortError is the caller cancelling, not a failure — re-throw it
    // untouched so effects can ignore it rather than rendering an error state.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiClientError(0, 'network', 'Could not reach the Pulse API. Is it running?');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = payload as ApiErrorBody | null;
    throw new ApiClientError(
      response.status,
      body?.error?.code ?? 'internal',
      body?.error?.message ?? `Request failed with status ${response.status}`,
      body?.error?.details,
    );
  }

  return payload as T;
}
