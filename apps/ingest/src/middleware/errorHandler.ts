import type { NextFunction, Request, Response } from 'express';
import { ApiError, toApiError } from '@pulse/shared';
import { createLogger } from '../logger.js';

const log = createLogger('http');

/** 404 for anything that fell through the router, in the standard error shape. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(ApiError.notFound(`No route for ${req.method} ${req.path}`).toBody());
}

/**
 * The single place an exception becomes a response.
 *
 * Expected failures arrive as `ApiError` and are logged at warn with their
 * context. Anything else is a bug: it is logged at error *with the stack*, and
 * the client gets a generic 500 that leaks nothing about our internals.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    // Express cannot send a second response; hand back so it can destroy the
    // socket rather than silently double-writing.
    next(err);
    return;
  }

  const apiError = toApiError(err);
  const fields = {
    method: req.method,
    path: req.path,
    status: apiError.status,
    code: apiError.code,
    requestId: res.getHeader('x-request-id'),
    ...(apiError.context ?? {}),
  };

  if (apiError.status >= 500) {
    log.error('request failed', err, fields);
  } else {
    log.warn('request rejected', { ...fields, message: apiError.message });
  }

  res.status(apiError.status).json(apiError.toBody());
}

/**
 * Express 4 does not forward rejected promises from async handlers, so an
 * `await` that throws would hang the request instead of reaching errorHandler.
 * Wrap every async route in this.
 */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}
