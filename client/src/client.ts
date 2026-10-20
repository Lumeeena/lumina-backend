/**
 * A minimal typed client for the Lumina GraphQL API.
 *
 * `request` takes one of the generated documents (e.g. `TransactionsDocument`)
 * and infers both the variables it accepts and the shape it returns from the
 * schema, so a caller writes no types of their own. It uses the platform
 * `fetch` (browsers, Node 18+), or one passed in.
 */
import type { DocumentTypeDecoration } from '@graphql-typed-document-node/core';

/** One GraphQL error as the server returns it. */
export interface LuminaErrorEntry {
  message: string;
  path?: ReadonlyArray<string | number>;
  /** `extensions.code` is a stable code (docs/ERROR_CODES.md), e.g. `BAD_USER_INPUT`. */
  extensions?: { code?: string; [key: string]: unknown };
}

/** The request reached the server, which answered with GraphQL errors. */
export class LuminaGraphQLError extends Error {
  /** Every error the server returned. */
  readonly errors: LuminaErrorEntry[];
  /** Whatever data came back alongside the errors (partial results), or null. */
  readonly data: unknown;
  /** The first error's `extensions.code`, for branching without string matching. */
  readonly code: string | undefined;

  constructor(errors: LuminaErrorEntry[], data: unknown) {
    super(errors.map(error => error.message).join('; ') || 'GraphQL request failed');
    this.name = 'LuminaGraphQLError';
    this.errors = errors;
    this.data = data;
    this.code = errors[0]?.extensions?.code;
  }
}

/** The request did not get a GraphQL response (network failure, non-JSON, 5xx without a body). */
export class LuminaHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LuminaHttpError';
    this.status = status;
  }
}

export interface LuminaClientOptions {
  /** The GraphQL endpoint, e.g. `https://api.example.com/graphql`. */
  url: string;
  /** API key, sent in `apiKeyHeader` (docs/AUTHENTICATION.md). */
  apiKey?: string;
  /** Header the server reads the key from; `x-api-key` unless the deployment set `API_KEY_HEADER`. */
  apiKeyHeader?: string;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** A `fetch` implementation; the global one by default. */
  fetch?: typeof fetch;
}

/**
 * Variables are optional exactly when the operation has no required ones,
 * i.e. when an empty object satisfies them.
 */
type VariablesArgument<TVariables> =
  Record<never, never> extends TVariables ? [variables?: TVariables] : [variables: TVariables];

export interface LuminaClient {
  /** Run a generated document; resolves to its typed `data`, or throws. */
  request<TResult, TVariables>(
    document: DocumentTypeDecoration<TResult, TVariables> & { toString(): string },
    ...variables: VariablesArgument<TVariables>
  ): Promise<TResult>;
}

export function createLuminaClient(options: LuminaClientOptions): LuminaClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation: pass `fetch` in the options (Node <18 has none built in).');
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...options.headers,
  };
  if (options.apiKey) headers[(options.apiKeyHeader ?? 'x-api-key').toLowerCase()] = options.apiKey;

  return {
    async request(document, ...rest) {
      const response = await fetchImpl(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: document.toString(), variables: rest[0] ?? {} }),
      });

      let body: { data?: unknown; errors?: LuminaErrorEntry[] };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new LuminaHttpError(response.status, `Lumina API returned a non-JSON response (HTTP ${response.status}).`);
      }

      if (body.errors?.length) throw new LuminaGraphQLError(body.errors, body.data ?? null);
      if (!response.ok || body.data === undefined || body.data === null) {
        throw new LuminaHttpError(response.status, `Lumina API request failed (HTTP ${response.status}).`);
      }
      // The document's type parameter is the shape the schema guarantees for it.
      return body.data as never;
    },
  };
}
