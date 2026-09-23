/**
 * Structured logging for the GraphQL server. Mirrors the indexer's setup —
 * values as fields, JSON by default, `LOG_PRETTY=true` for local runs.
 */
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_PRETTY === 'true';

export const logger = pino({
  level,
  base: { service: 'lumina-graphql' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(pretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});

export function subsystem(name: string, correlationId?: string) {
  const bindings: Record<string, unknown> = { subsystem: name };
  if (correlationId) {
    bindings.correlationId = correlationId;
  }
  return logger.child(bindings);
}
