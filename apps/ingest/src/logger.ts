/**
 * Structured JSON logging. One line per event, always with a `msg` and a
 * component, so production logs are greppable and machine-parseable.
 *
 * `logger.error` always takes the error itself, never a pre-stringified
 * message — losing the stack trace is how a 500 becomes unfixable.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * `object` rather than `Record<string, unknown>` so a plain interface (which
 * has no index signature) can be logged directly — otherwise every stats type
 * in the codebase would need a redundant index signature just to be loggable.
 */
export type LogFields = object;

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function activeLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return process.env.NODE_ENV === 'test' ? 'warn' : 'info';
}

function serialiseError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause !== undefined ? { cause: serialiseError(err.cause) } : {}),
    };
  }
  return { thrown: String(err) };
}

function emit(level: Level, component: string, msg: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    component,
    msg,
    ...fields,
  });
  // stderr for warn/error keeps them separable in a container log pipeline.
  if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, err: unknown, fields?: LogFields): void;
  child(component: string): Logger;
}

export function createLogger(component: string): Logger {
  return {
    debug: (msg, fields) => emit('debug', component, msg, fields),
    info: (msg, fields) => emit('info', component, msg, fields),
    warn: (msg, fields) => emit('warn', component, msg, fields),
    error: (msg, err, fields) => emit('error', component, msg, { ...fields, err: serialiseError(err) }),
    child: (sub) => createLogger(`${component}:${sub}`),
  };
}

export const logger = createLogger('pulse');
