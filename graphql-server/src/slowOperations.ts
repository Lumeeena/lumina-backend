/**
 * Log individual slow GraphQL operations.
 *
 * The duration histogram shows that a slow p99 exists; this says which
 * operation caused it and with what (redacted) variables. Fast requests pay
 * for one clock read and a comparison — variables are only touched, and a log
 * line only built, once the threshold is exceeded.
 */
import type { ApolloServerPlugin } from '@apollo/server';
import { logger } from './logger';
import { parseNonNegativeInt } from './security';

export const DEFAULT_SLOW_OPERATION_THRESHOLD_MS = 1000;
export const REDACTED = '[REDACTED]';

/** Variable names whose values must never reach a log line. */
const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|api[-_]?key|apikey|authori[sz]ation|cookie|credential|signature|seed|mnemonic|private/i;

/** 0 disables slow-operation logging. */
export function loadSlowOperationThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseNonNegativeInt(env['SLOW_OPERATION_THRESHOLD_MS'], DEFAULT_SLOW_OPERATION_THRESHOLD_MS);
}

export function redactVariables(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.map(v => redactVariables(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? REDACTED : redactVariables(v, depth + 1),
      ])
    );
  }
  return value;
}

export interface SlowOperationOptions {
  thresholdMs: number;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

export function slowOperationPlugin(options: SlowOperationOptions): ApolloServerPlugin<any> {
  const log = options.log ?? ((fields, message) => logger.warn(fields, message));
  return {
    async requestDidStart() {
      if (options.thresholdMs <= 0) return {};
      const start = process.hrtime.bigint();
      return {
        async willSendResponse(ctx) {
          const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
          if (durationMs < options.thresholdMs) return;
          log(
            {
              operation: ctx.operationName ?? 'anonymous',
              type: ctx.operation?.operation ?? 'unknown',
              durationMs: Math.round(durationMs),
              thresholdMs: options.thresholdMs,
              variables: redactVariables(ctx.request.variables ?? {}),
            },
            'slow GraphQL operation'
          );
        },
      };
    },
  };
}
