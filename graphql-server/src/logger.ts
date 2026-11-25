/**
 * Structured logging for the GraphQL server. Mirrors the indexer's setup —
 * values as fields, JSON by default, `LOG_PRETTY=true` for local runs.
 */
import pino from 'pino';

/**
 * Minimum level written, from `LOG_LEVEL`. Defaults to `info`, which keeps
 * `info`, `warn` and `error` lines and drops `debug` and `trace`. The source does
 * not record why `info` was chosen over another default.
 */
const level = process.env.LOG_LEVEL ?? 'info';

/**
 * `LOG_PRETTY=true` swaps the JSON output for `pino-pretty`, which is easier to
 * read in a terminal. Any other value, including unset, keeps JSON, so log
 * shippers receive one parseable object per line. Only the exact string `true`
 * enables it.
 */
const pretty = process.env.LOG_PRETTY === 'true';

/**
 * The root logger. Every line it writes carries `service: 'lumina-graphql'` and
 * an ISO-8601 `time`, so a line can be attributed to this server when several
 * services' logs land in one place. Most modules log through `subsystem` instead,
 * which also records which module wrote the line.
 */
export const logger = pino({
  level,
  base: { service: 'lumina-graphql' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(pretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});

/**
 * A child of `logger` that tags every line with `subsystem: name`, so a line can
 * be traced to the module that wrote it (for example `horizon` or `auth`).
 *
 * Pass `correlationId` to bind one request's id to all of its lines; omit it
 * elsewhere, and the field is left out rather than set to `undefined`. The child
 * inherits the root level and `service` field.
 *
 * @param name The module name. Use the same name across calls in one module.
 * @param correlationId Optional request id to bind to every line from this child.
 */
export function subsystem(name: string, correlationId?: string) {
  const bindings: Record<string, unknown> = { subsystem: name };
  if (correlationId) {
    bindings.correlationId = correlationId;
  }
  return logger.child(bindings);
}
