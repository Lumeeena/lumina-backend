/**
 * The stable error-code contract for the GraphQL API.
 *
 * A client branches on `extensions.code`, never on `message`: messages are for
 * humans and may be reworded at any time, while a code is part of the public
 * interface and only changes with a deprecation cycle. This module defines
 * which codes exist and which errors produce them; `docs/ERROR_CODES.md` is the
 * consumer-facing copy of the same taxonomy.
 *
 * Codes are grouped by what a caller should do about them:
 *
 * - `invalid_input` — the request named or contained something unusable. Fix
 *   the request; sending it unchanged again fails the same way.
 * - `not_found` — a resource the request named does not exist. Check the
 *   identifier; sending it unchanged again fails the same way.
 * - `rate_limited` — a limit turned the request away. Back off and retry.
 * - `authentication` — the API key is missing, malformed or revoked. Fix
 *   credentials; do not retry.
 * - `internal` — the server could not complete a request it understood. Retry
 *   once, then report the `correlationId` when the response carries one.
 */
import { GraphQLError, type GraphQLFormattedError } from 'graphql';

export const ERROR_CODES = {
  BAD_USER_INPUT: 'BAD_USER_INPUT',
  INVALID_CURSOR: 'INVALID_CURSOR',
  QUERY_TOO_DEEP: 'QUERY_TOO_DEEP',
  QUERY_TOO_COMPLEX: 'QUERY_TOO_COMPLEX',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  QUERY_TIMEOUT: 'QUERY_TIMEOUT',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ERROR_CATEGORIES = {
  INVALID_INPUT: 'invalid_input',
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  AUTHENTICATION: 'authentication',
  INTERNAL: 'internal',
} as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[keyof typeof ERROR_CATEGORIES];

export interface ErrorCodeDefinition {
  category: ErrorCategory;
  description: string;
}

/**
 * Every code the server can emit, with its category and meaning.
 *
 * Typed as a `Record<ErrorCode, ...>` so adding a code without documenting it
 * fails to compile.
 */
export const ERROR_CODE_TAXONOMY: Readonly<Record<ErrorCode, ErrorCodeDefinition>> = {
  BAD_USER_INPUT: {
    category: ERROR_CATEGORIES.INVALID_INPUT,
    description:
      'A query, argument or filter value the server cannot use: an unknown network, a page size or aggregate limit out of range, a time range wider than its query allows, a malformed asset, a non-integer value for a numeric event field.',
  },
  INVALID_CURSOR: {
    category: ERROR_CATEGORIES.INVALID_INPUT,
    description:
      'A pagination cursor the server did not issue, issued for a different query, or that no longer decodes. Cursors are opaque; pass back the one the previous page returned.',
  },
  QUERY_TOO_DEEP: {
    category: ERROR_CATEGORIES.INVALID_INPUT,
    description:
      'The operation nests fields deeper than GRAPHQL_MAX_DEPTH allows. Reduce nesting or ask the operator to raise the limit.',
  },
  QUERY_TOO_COMPLEX: {
    category: ERROR_CATEGORIES.INVALID_INPUT,
    description:
      'The operation costs more than GRAPHQL_MAX_COMPLEXITY allows. Lower `limit` arguments, drop nested lists, or ask the operator to raise the limit.',
  },
  NOT_FOUND: {
    category: ERROR_CATEGORIES.NOT_FOUND,
    description:
      'A resource the request named does not exist: a contract with no registered custom-event schema, or an event the schema does not declare.',
  },
  RATE_LIMITED: {
    category: ERROR_CATEGORIES.RATE_LIMITED,
    description:
      'A limit turned the request away — a per-key or anonymous request budget, or the server at its concurrent-subscription ceiling. Back off and retry.',
  },
  UNAUTHENTICATED: {
    category: ERROR_CATEGORIES.AUTHENTICATION,
    description: 'An API key was present but is malformed, unknown or revoked. Fix the key; retrying it unchanged fails the same way.',
  },
  QUERY_TIMEOUT: {
    category: ERROR_CATEGORIES.INTERNAL,
    description:
      'The database cancelled the query for running past DB_STATEMENT_TIMEOUT_MS. Narrow the request (smaller limit, fewer nested fields) and retry.',
  },
  REQUEST_TIMEOUT: {
    category: ERROR_CATEGORIES.INTERNAL,
    description: 'The HTTP request was not answered within REQUEST_TIMEOUT_MS. Retry; if it persists, report it.',
  },
  INTERNAL_SERVER_ERROR: {
    category: ERROR_CATEGORIES.INTERNAL,
    description:
      'The server failed unexpectedly. A production response is masked to `Internal server error` and carries `extensions.correlationId` for the log entry. Retry once, then report the id.',
  },
};

/**
 * An error whose code is part of the API contract.
 *
 * Deliberate errors extend this so a code reaches the client no matter which
 * transport surfaced the error — Apollo's `formatError`, the auth middleware,
 * or graphql-ws.
 */
export class LuminaError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = 'LuminaError';
    this.code = code;
  }
}

/** A request the server understood but cannot serve as written. */
export class InvalidInputError extends LuminaError {
  constructor(message: string) {
    super(message, ERROR_CODES.BAD_USER_INPUT);
    this.name = 'InvalidInputError';
  }
}

/** A limit, rather than a defect, turned the request away. */
export class RateLimitedError extends LuminaError {
  constructor(message: string) {
    super(message, ERROR_CODES.RATE_LIMITED);
    this.name = 'RateLimitedError';
  }
}

/**
 * Peel Apollo's resolver wrapping off a thrown error.
 *
 * A resolver error reaches `formatError` as a `GraphQLError` whose
 * `originalError` is what the resolver actually threw; a `GraphQLError` thrown
 * directly is returned as is.
 */
function unwrapResolverError(error: unknown): unknown {
  let current = error;
  while (current instanceof GraphQLError && current.originalError) {
    current = current.originalError;
  }
  return current;
}

/**
 * The stable code for a thrown error, or `undefined` for an error with no
 * domain meaning (a raw database failure, a bug).
 *
 * GraphQL errors that already carry a code — Apollo's, graphql-js's, the
 * query-limit plugin's — keep it; a `LuminaError` reports the code it was
 * created with.
 */
export function errorCodeFor(error: unknown): string | undefined {
  const original = unwrapResolverError(error);
  if (original instanceof LuminaError) return original.code;
  if (original instanceof GraphQLError) {
    const code = original.extensions?.['code'];
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Guarantee a formatted error carries a stable code.
 *
 * Apollo stamps every error with `INTERNAL_SERVER_ERROR` by default, including
 * deliberate ones, which would make a client unable to tell a bad filter from
 * a broken database. A specific code already on the error wins; otherwise the
 * thrown error's code is used. An error with neither keeps
 * `INTERNAL_SERVER_ERROR` and is masked before it reaches the client.
 */
export function withStableErrorCode(
  formatted: GraphQLFormattedError,
  error: unknown
): GraphQLFormattedError {
  const current = formatted.extensions?.['code'];
  if (typeof current === 'string' && current !== ERROR_CODES.INTERNAL_SERVER_ERROR) {
    return formatted;
  }
  const code = errorCodeFor(error);
  if (!code) return formatted;
  return { ...formatted, extensions: { ...(formatted.extensions ?? {}), code } };
}

/**
 * The same guarantee for a `GraphQLError` that never reaches Apollo's
 * `formatError` — subscription errors, which graphql-ws serialises itself.
 * An error with no recognisable code is labelled internal rather than left
 * codeless.
 */
export function errorWithStableCode(error: GraphQLError): GraphQLError {
  const current = error.extensions?.['code'];
  if (typeof current === 'string' && current !== ERROR_CODES.INTERNAL_SERVER_ERROR) {
    return error;
  }
  const code = errorCodeFor(error) ?? ERROR_CODES.INTERNAL_SERVER_ERROR;
  if (current === code) return error;
  return new GraphQLError(error.message, {
    nodes: error.nodes,
    source: error.source,
    positions: error.positions,
    path: error.path,
    originalError: error.originalError ?? undefined,
    extensions: {
      ...(error.extensions ?? {}),
      code,
    },
  });
}
