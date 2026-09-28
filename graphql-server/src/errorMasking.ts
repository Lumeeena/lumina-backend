/**
 * Mask unexpected resolver errors in production responses.
 *
 * A raw Postgres error carries table names, column names and query fragments
 * to the caller. Unexpected failures are therefore replaced by a generic
 * message and a correlation id; the full error is logged with the same id so
 * an operator can look it up. Deliberate errors — the ones written for callers
 * — pass through unchanged. See docs/SECURITY_HARDENING.md.
 */
import { randomUUID } from 'crypto';
import { unwrapResolverError } from '@apollo/server/errors';
import type { GraphQLFormattedError } from 'graphql';
import { AssetError } from './assets';
import { ApiKeyError } from './auth';
import { CustomQueryError } from './customEvents';
import { logger } from './logger';
import { SubscriberLimitError } from './pubsub';
import { SearchError } from './search';
import { parseBool } from './security';

export const MASKED_ERROR_MESSAGE = 'Internal server error';

/** Errors raised on purpose, with messages meant for the caller. */
const DELIBERATE_ERRORS: Array<new (...args: never[]) => Error> = [
  CustomQueryError,
  SearchError,
  AssetError,
  ApiKeyError,
  SubscriberLimitError,
];

/**
 * Masking is on in production and off elsewhere, so development keeps full
 * messages. `MASK_INTERNAL_ERRORS=true|false` overrides either default.
 */
export function shouldMaskErrors(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBool(env['MASK_INTERNAL_ERRORS']) ?? env['NODE_ENV'] === 'production';
}

export interface ErrorMaskOptions {
  enabled: boolean;
  log?: (fields: Record<string, unknown>, message: string) => void;
  newId?: () => string;
}

export function createErrorMasker(options: ErrorMaskOptions) {
  const log = options.log ?? ((fields, message) => logger.error(fields, message));
  const newId = options.newId ?? randomUUID;

  return function maskError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
    if (!options.enabled) return formatted;
    // Only failures that Apollo classified as internal are candidates: other
    // codes (validation, timeouts, bad input) are already caller-facing.
    if (formatted.extensions?.['code'] !== 'INTERNAL_SERVER_ERROR') return formatted;

    const original = unwrapResolverError(error);
    if (DELIBERATE_ERRORS.some(type => original instanceof type)) return formatted;

    const correlationId = newId();
    log(
      {
        correlationId,
        err: original instanceof Error ? { message: original.message, stack: original.stack } : String(original),
        path: formatted.path,
      },
      'unexpected GraphQL error masked in response'
    );
    return {
      message: MASKED_ERROR_MESSAGE,
      locations: formatted.locations,
      path: formatted.path,
      extensions: { code: 'INTERNAL_SERVER_ERROR', correlationId },
    };
  };
}
