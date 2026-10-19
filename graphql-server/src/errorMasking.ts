/**
 * Mask unexpected resolver errors in production responses.
 *
 * A raw Postgres error carries table names, column names and query fragments
 * to the caller. Unexpected failures are therefore replaced by a generic
 * message and a correlation id; the full error is logged with the same id so
 * an operator can look it up. Deliberate errors — `LuminaError` subclasses
 * with a caller-facing code — pass through unchanged. See
 * docs/SECURITY_HARDENING.md.
 */
import { randomUUID } from 'crypto';
import { unwrapResolverError } from '@apollo/server/errors';
import type { GraphQLFormattedError } from 'graphql';
import { ERROR_CODES, LuminaError } from './errorCodes';
import { logger } from './logger';
import { parseBool } from './security';

export const MASKED_ERROR_MESSAGE = 'Internal server error';

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
    if (formatted.extensions?.['code'] !== ERROR_CODES.INTERNAL_SERVER_ERROR) return formatted;

    const original = unwrapResolverError(error);
    // Deliberate errors carry their own code from `withStableErrorCode`, so
    // they no longer look internal; this check keeps them safe if the masker
    // is ever called on its own.
    if (original instanceof LuminaError) return formatted;

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
      extensions: { code: ERROR_CODES.INTERNAL_SERVER_ERROR, correlationId },
    };
  };
}
