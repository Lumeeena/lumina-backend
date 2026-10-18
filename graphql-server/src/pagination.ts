import { GraphQLError } from 'graphql';

/** Page size a query uses when the caller does not ask for one. */
export const DEFAULT_PAGE_LIMIT = 20;

/** Maximum allowed page size across all queries. */
export const MAX_PAGE_SIZE = 100;

export function getPageSize(limit: number | null | undefined, defaultLimit = DEFAULT_PAGE_LIMIT): number {
  const pageSize = limit ?? defaultLimit;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new GraphQLError(`Page size must be a positive integer; received ${pageSize}.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  if (pageSize > MAX_PAGE_SIZE) {
    throw new GraphQLError(
      `Requested page size ${pageSize} exceeds the maximum of ${MAX_PAGE_SIZE}.`,
      { extensions: { code: 'BAD_USER_INPUT' } }
    );
  }
  return pageSize;
}

/** The values a cursor may carry: a sort key is a number or a string. */
export type CursorValue = number | string;

/** Direction for cursor-based pagination (Issue #287). */
export type PaginationDirection = 'FORWARD' | 'BACKWARD';

/**
 * A cursor the server cannot use.
 *
 * A `GraphQLError` with a code rather than a plain `Error`, so the code reaches
 * the client instead of being flattened to `INTERNAL_SERVER_ERROR`.
 */
export class InvalidCursorError extends GraphQLError {
  constructor(detail: string) {
    super(`Invalid cursor: ${detail} Cursors are opaque — pass back the one a previous page returned.`, {
      extensions: { code: 'INVALID_CURSOR' },
    });
    this.name = 'InvalidCursorError';
  }
}

/**
 * What a query keysets on: the ordering columns, their types, and the query they
 * belong to.
 */
export interface Keyset {
  /** The paginated query these cursors belong to — see `decodeCursor`. */
  query: string;
  /** Ordering columns, in the order the keyset compares them. */
  columns: readonly string[];
  /** Postgres type of each column, for the bind cast. */
  types: readonly string[];
}

/**
 * Every paginated query's keyset.
 *
 * Keyed by the GraphQL field name: a cursor names the query that issued it, so
 * handing a `transactions` cursor to `events` is rejected with an error saying
 * so rather than compared against the wrong columns.
 */
export const KEYSETS = {
  transactions: { query: 'transactions', columns: ['ledger', 'hash'], types: ['bigint', 'text'] },
  ledgers: { query: 'ledgers', columns: ['sequence'], types: ['bigint'] },
  accountsActivity: { query: 'accounts', columns: ['last_modified_ledger', 'address'], types: ['bigint', 'text'] },
  accountsAddress: { query: 'accounts', columns: ['address'], types: ['text'] },
  operations: { query: 'operations', columns: ['ledger', 'id'], types: ['bigint', 'text'] },
  assetOperations: { query: 'operations', columns: ['ledger', 'id'], types: ['bigint', 'text'] },
  events: { query: 'events', columns: ['ledger', 'id'], types: ['bigint', 'text'] },
  customEvents: { query: 'customEvents', columns: ['ledger', 'event_id'], types: ['bigint', 'text'] },
  search: { query: 'search', columns: ['rank', 'ledger', 'hash'], types: ['real', 'bigint', 'text'] },
} as const satisfies Record<string, Keyset>;

/** The keyset for a paginated query, by its GraphQL field name. */
export function keysetFor(query: string): Keyset {
  const keyset = Object.values(KEYSETS).find(candidate => candidate.query === query);
  if (!keyset) throw new Error(`No keyset is declared for ${query}.`);
  return keyset;
}

/**
 * Encode a sort-key tuple, tagged with the query that issued it.
 *
 * base64url rather than a readable string so that a client which starts building
 * cursors by hand does not become a compatibility constraint.
 */
export function encodeCursor(query: string, values: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify({ q: query, k: values }), 'utf-8').toString('base64url');
}

/**
 * Decode a cursor into its sort-key tuple, or throw `InvalidCursorError`.
 */
export function decodeCursor(raw: string, query: string, arity: number): CursorValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
  } catch {
    throw new InvalidCursorError('it is not a cursor this server issued.');
  }

  const envelope = parsed as { q?: unknown; k?: unknown } | null;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new InvalidCursorError('it is not a cursor this server issued.');
  }

  if (envelope.q !== query) {
    throw new InvalidCursorError(
      typeof envelope.q === 'string'
        ? `it was issued by \`${envelope.q}\`, not by \`${query}\`.`
        : 'it is not a cursor this server issued.'
    );
  }

  if (!Array.isArray(envelope.k) || envelope.k.length !== arity) {
    throw new InvalidCursorError(
      `expected ${arity} sort key ${arity === 1 ? 'value' : 'values'} for \`${query}\`, got ${
        Array.isArray(envelope.k) ? envelope.k.length : typeof envelope.k
      }.`
    );
  }

  for (const value of envelope.k) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new InvalidCursorError('it does not contain a sort key.');
    }
  }

  return envelope.k as CursorValue[];
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
  cursor: string | null;
}

/**
 * The `pageInfo` for one page of results supporting bidirectional pagination.
 *
 * Provides both `startCursor` and `endCursor`, so a client can page forwards
 * using `endCursor` or backwards using `startCursor`.
 */
export function pageInfo<T>(
  keyset: Keyset,
  items: readonly T[],
  limit: number,
  keyOf: (item: T) => CursorValue | readonly CursorValue[],
  direction: PaginationDirection = 'FORWARD',
  hasPrior = false
): PageInfo {
  const first = items.at(0);
  const last = items.at(-1);

  if (first === undefined || last === undefined) {
    return {
      hasNextPage: false,
      hasPreviousPage: hasPrior,
      startCursor: null,
      endCursor: null,
      cursor: null,
    };
  }

  const firstKey = keyOf(first);
  const firstValues = typeof firstKey === 'string' || typeof firstKey === 'number' ? [firstKey] : [...firstKey];
  const lastKey = keyOf(last);
  const lastValues = typeof lastKey === 'string' || typeof lastKey === 'number' ? [lastKey] : [...lastKey];

  if (firstValues.length !== keyset.columns.length || lastValues.length !== keyset.columns.length) {
    throw new Error(
      `${keyset.query}: cursor values count does not match keyset columns count (${keyset.columns.length}).`
    );
  }

  const startCursor = encodeCursor(keyset.query, firstValues);
  const endCursor = encodeCursor(keyset.query, lastValues);

  const isFullPage = items.length === limit;
  const hasNextPage = direction === 'FORWARD' ? isFullPage : hasPrior;
  const hasPreviousPage = direction === 'FORWARD' ? hasPrior : isFullPage;

  return {
    hasNextPage,
    hasPreviousPage,
    startCursor,
    endCursor,
    cursor: endCursor,
  };
}

/**
 * Bind a keyset to a parameter list and return the SQL row comparison that
 * resumes strictly before or after it, depending on pagination direction.
 *
 * For descending ordering (default in ledger/transaction feeds):
 * - FORWARD uses `<` (older ledgers/rows)
 * - BACKWARD uses `>` (newer ledgers/rows)
 *
 * For ascending ordering:
 * - FORWARD uses `>`
 * - BACKWARD uses `<`
 */
export function cursorCondition(
  params: unknown[],
  keyset: Keyset,
  cursor?: string | null,
  direction: PaginationDirection = 'FORWARD',
  order: 'ASC' | 'DESC' = 'DESC'
): string | null {
  if (!cursor) return null;
  const values = decodeCursor(cursor, keyset.query, keyset.columns.length);
  const first = params.length + 1;
  const bound = keyset.columns.map((_, index) => `$${first + index}::${keyset.types[index]}`);
  params.push(...values);

  const isForward = direction === 'FORWARD';
  const operator = order === 'DESC' ? (isForward ? '<' : '>') : (isForward ? '>' : '<');
  return `(${keyset.columns.join(', ')}) ${operator} (${bound.join(', ')})`;
}
