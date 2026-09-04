import { ZodError } from 'zod';
import type { ApiErrorBody, ApiErrorCode } from '../types.js';

/**
 * One error type, one wire shape. Route handlers throw `ApiError`; a single
 * handler in each app turns it into a response. Nothing in this repo does
 * `catch (e) { console.log(e) }` — either the error is expected and becomes an
 * ApiError, or it is a bug and gets logged with context and re-raised as a 500.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: Array<{ path: string; message: string }>;
  /** Extra context for the log line — never sent to the client. */
  readonly context?: Record<string, unknown>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options: {
      details?: Array<{ path: string; message: string }>;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (options.details) this.details = options.details;
    if (options.context) this.context = options.context;
  }

  static badRequest(message: string, details?: Array<{ path: string; message: string }>): ApiError {
    return new ApiError(400, 'bad_request', message, details ? { details } : {});
  }
  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }
  static forbidden(message = 'You do not have access to this resource'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(message = 'Not found'): ApiError {
    return new ApiError(404, 'not_found', message);
  }
  static conflict(message: string): ApiError {
    return new ApiError(409, 'conflict', message);
  }
  static rateLimited(message = 'Too many requests'): ApiError {
    return new ApiError(429, 'rate_limited', message);
  }
  static internal(message = 'Something went wrong', context?: Record<string, unknown>): ApiError {
    return new ApiError(500, 'internal', message, context ? { context } : {});
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** Flatten a ZodError into the `details` array clients can render per-field. */
export function zodErrorToApiError(err: ZodError, message = 'Invalid request'): ApiError {
  return ApiError.badRequest(
    message,
    err.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  );
}

/**
 * Normalise anything thrown into an ApiError. Unknown throwables become a
 * generic 500 with the original attached as `cause` so the log keeps the stack
 * while the client learns nothing about our internals.
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) return zodErrorToApiError(err);
  if (err instanceof Error) {
    return new ApiError(500, 'internal', 'Something went wrong', { cause: err });
  }
  return new ApiError(500, 'internal', 'Something went wrong', { context: { thrown: String(err) } });
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
