/**
 * Keyset pagination for Lumina's GraphQL API.
 *
 * A well-formed cursor with no rows past it returns an empty page: that is how a
 * client learns it has finished. A cursor that cannot be decoded is an error
 * (`INVALID_CURSOR`) on every paginated query, because the alternative — an
 * empty page that a client reads as "the end" — silently truncates a result set
 * and looks like a bug in their code rather than in the request.
 */
import { GraphQLError } from 'graphql';
import { ERROR_CODES } from './errorCodes';

/** Page size a query uses when the caller does not ask for one. */
export const DEFAULT_PAGE_LIMIT = 20;

/** Maximum allowable page size across all paginated queries. */
export const MAX_PAGE_SIZE = 100;

/**
 * Maximum rows a single non-paginated aggregate may return.
 *
 * `DEFAULT_PAGE_LIMIT` / `MAX_PAGE_SIZE` bound a paginated *page*; the
 * aggregate queries (`networkStats`, `activityRollups`, `sponsoredAccounts`)
 * have no cursor to page with — the caller asks for a time range or a sponsor
 * and gets everything in it. Without a ceiling the whole result is materialised
 * in memory and serialised into one GraphQL response, so memory would grow with
 * the request rather than staying flat. This is the ceiling those queries
 * enforce: large enough for a full year of daily rollups (366) or a month of
 * hourly ones (744), small enough that the response stays bounded.
 */
export const MAX_AGGREGATE_ROWS = 1000;

/**
 * The row ceiling for a non-paginated aggregate, or throw `BAD_USER_INPUT`.
 *
 * An optional caller `limit` is clamped against `MAX_AGGREGATE_ROWS` the same
 * way `getPageSize` clamps a page: a request above the ceiling is an error, not
 * a silently truncated result, so the caller can narrow the request rather than
 * believe they received everything.
 */
export function getAggregateLimit(limit: number | null | undefined, defaultLimit: number): number {
  const requested = limit ?? defaultLimit;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new GraphQLError(`Limit must be a positive integer; received ${requested}.`, {
      extensions: { code: ERROR_CODES.BAD_USER_INPUT },
    });
  }
  if (requested > MAX_AGGREGATE_ROWS) {
    throw new GraphQLError(
      `Requested limit ${requested} exceeds the maximum of ${MAX_AGGREGATE_ROWS} for this query. ` +
        'Narrow the range or use a coarser granularity.',
      { extensions: { code: ERROR_CODES.BAD_USER_INPUT } }
    );
  }
  return requested;
}

/** Seconds in the bucket a `hour` / `day` granularity names. */
export function granularitySeconds(granularity: 'hour' | 'day'): number {
  return granularity === 'day' ? 86_400 : 3_600;
}

/**
 * How many buckets `[startTime, endTime)` spans at a granularity, or `null` for
 * a range that does not parse.
 *
 * A range is bounded by a row cap rather than a page cursor, so the check that
 * matters is how many buckets it asks for *before* the query returns. Treating
 * a range that spans more buckets than the cap as an error — rather than
 * quietly `LIMIT`-ing it — is what keeps a caller from reading a truncated
 * series as a complete one.
 */
export function countBuckets(
  startTime: string,
  endTime: string,
  granularity: 'hour' | 'day'
): number | null {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return Math.ceil((end - start) / 1000 / granularitySeconds(granularity));
}

/**
 * Throw if a time range spans more buckets than `limit` allows.
 *
 * `null` from `countBuckets` means the range itself is malformed, which the
 * database would answer as an empty result; leave it for the query to handle
 * rather than inventing an error here.
 */
export function assertRangeWithinLimit(
  startTime: string,
  endTime: string,
  granularity: 'hour' | 'day',
  limit: number
): void {
  const buckets = countBuckets(startTime, endTime, granularity);
  if (buckets === null) return;
  if (buckets > limit) {
    throw new GraphQLError(
      `Range spans ${buckets} ${granularity} buckets, above the maximum of ${limit}. ` +
        'Narrow the range or use a coarser granularity.',
      { extensions: { code: ERROR_CODES.BAD_USER_INPUT } }
    );
  }
}

export type PaginationDirection = 'FORWARD' | 'BACKWARD';

export function getPageSize(limit: number | null | undefined, defaultLimit = DEFAULT_PAGE_LIMIT): number {
  const pageSize = limit ?? defaultLimit;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new GraphQLError(`Page size must be a positive integer; received ${pageSize}.`, {
      extensions: { code: ERROR_CODES.BAD_USER_INPUT },
    });
  }
  if (pageSize > MAX_PAGE_SIZE) {
    throw new GraphQLError(
      `Requested page size ${pageSize} exceeds the maximum of ${MAX_PAGE_SIZE}.`,
      { extensions: { code: ERROR_CODES.BAD_USER_INPUT } }
    );
  }
  return pageSize;
}

/** The values a cursor may carry: a sort key is a number or a string. */
export type CursorValue = number | string;

/**
 * A cursor the server cannot use.
 *
 * A `GraphQLError` with a code rather than a plain `Error`, so the code reaches
 * the client instead of being flattened to `INTERNAL_SERVER_ERROR` — this is a
 * mistake in the request, and a client has to be able to tell that apart from a
 * failure on the server side.
 */
export class InvalidCursorError extends GraphQLError {
  constructor(detail: string) {
    super(`Invalid cursor: ${detail} Cursors are opaque — pass back the one a previous page returned.`, {
      extensions: { code: ERROR_CODES.INVALID_CURSOR },
    });
    this.name = 'InvalidCursorError';
  }
}

/**
 * Precision level of a returned total count.
 */
export enum CountPrecision {
  EXACT = 'EXACT',
  ESTIMATE = 'ESTIMATE',
}

/**
 * Returned total count with transparency on whether it is an exact count or an estimate.
 */
export interface TotalCount {
  value: number;
  precision: CountPrecision;
  isEstimate: boolean;
}

/**
 * What a query keysets on: the ordering columns, their types, and the query they
 * belong to.
 *
 * Declared once per paginated query and used by both the SQL that reads the
 * cursor and the resolver that mints it, so the two cannot disagree about what a
 * cursor holds.
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
 * so rather than compared against the wrong columns — which, where two queries
 * happen to have the same arity, would otherwise resume somewhere plausible and
 * wrong.
 */
export const KEYSETS = {
  accountLifecycle: { query: 'accountLifecycle', columns: ['ledger', 'id'], types: ['bigint', 'text'] },
  transactions: { query: 'transactions', columns: ['ledger', 'hash'], types: ['bigint', 'text'] },
  ledgers: { query: 'ledgers', columns: ['sequence'], types: ['bigint'] },
  accountsActivity: { query: 'accounts', columns: ['last_modified_ledger', 'address'], types: ['bigint', 'text'] },
  accountsAddress: { query: 'accounts', columns: ['address'], types: ['text'] },
  operations: { query: 'operations', columns: ['ledger', 'id'], types: ['bigint', 'text'] },
  assetOperations: { query: 'operations', columns: ['ledger', 'id'], types: ['bigint', 'text'] },
  events: { query: 'events', columns: ['ledger', 'id'], types: ['bigint', 'text'] },
  customEvents: { query: 'customEvents', columns: ['ledger', 'event_id'], types: ['bigint', 'text'] },
  search: { query: 'search', columns: ['rank', 'ledger', 'hash'], types: ['real', 'bigint', 'text'] },
  trades: { query: 'trades', columns: ['ledger_close_time', 'id'], types: ['timestamptz', 'text'] },
  claimableBalances: {
    query: 'claimableBalances',
    columns: ['created_ledger', 'balance_id'],
    types: ['bigint', 'text'],
  },
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
 * cursors by hand does not become a compatibility constraint on how a query
 * orders its results.
 */
export function encodeCursor(query: string, values: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify({ q: query, k: values }), 'utf-8').toString('base64url');
}

/**
 * Decode a cursor into its sort-key tuple, or throw `InvalidCursorError`.
 *
 * `arity` is the keyset's width, and `query` the query it belongs to. Checking
 * both is what makes "an invalid cursor" mean the same thing on every query
 * rather than each one noticing a different kind of breakage.
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
  totalCount?: TotalCount | null;
}

/**
 * The `pageInfo` for one page of results.
 *
 * `hasNextPage` and `hasPreviousPage` describe the page in the traversal
 * direction: a full page going forward means there is more after it, a full
 * page going backward means there is more before it. `startCursor` and
 * `endCursor` name the first and last rows on the page; `cursor` is the one to
 * pass back for the next page (the end cursor in a forward traversal).
 *
 * `keyOf` returns the columns the query keysets on, in the same order — one
 * value for a single-column ordering, a tuple for a composite one.
 */
export function pageInfo<T>(
  keyset: Keyset,
  items: readonly T[],
  limit: number,
  keyOf: (item: T) => CursorValue | readonly CursorValue[],
  direction: PaginationDirection = 'FORWARD',
  hasPrior = false,
  totalCount?: TotalCount | null
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
      totalCount: totalCount ?? null,
    };
  }

  const firstKey = keyOf(first);
  const firstValues = typeof firstKey === 'string' || typeof firstKey === 'number' ? [firstKey] : [...firstKey];
  const lastKey = keyOf(last);
  const lastValues = typeof lastKey === 'string' || typeof lastKey === 'number' ? [lastKey] : [...lastKey];
  if (firstValues.length !== keyset.columns.length || lastValues.length !== keyset.columns.length) {
    // A resolver minting the wrong number of values would issue cursors its own
    // query rejects; failing here names the mistake at its source.
    throw new Error(
      `${keyset.query}: cursor has ${lastValues.length} sort keys but its keyset has ${keyset.columns.length}.`
    );
  }

  const startCursor = encodeCursor(keyset.query, firstValues);
  const endCursor = encodeCursor(keyset.query, lastValues);
  const isFullPage = items.length === limit;

  return {
    hasNextPage: direction === 'FORWARD' ? isFullPage : hasPrior,
    hasPreviousPage: direction === 'FORWARD' ? hasPrior : isFullPage,
    startCursor,
    endCursor,
    cursor: endCursor,
    totalCount: totalCount ?? null,
  };
}

/**
 * Bind a keyset to a parameter list and return the SQL row comparison that
 * resumes strictly after it, or `null` when there is no cursor.
 *
 * Each value is cast to the type of the column it is compared with: a bound
 * parameter is untyped, so comparing a `bigint` column to an uncast text
 * parameter makes Postgres sort the key as a string, where "9" is greater than
 * "10".
 */
export function cursorCondition(
  params: unknown[],
  keyset: Keyset,
  cursor?: string | null,
  direction: PaginationDirection = 'FORWARD',
  baseOrder: 'ASC' | 'DESC' = 'DESC'
): string | null {
  if (!cursor) return null;
  const values = decodeCursor(cursor, keyset.query, keyset.columns.length);
  const first = params.length + 1;
  const bound = keyset.columns.map((_, index) => `$${first + index}::${keyset.types[index]}`);
  params.push(...values);
  const operator = baseOrder === 'ASC'
    ? (direction === 'FORWARD' ? '>' : '<')
    : (direction === 'FORWARD' ? '<' : '>');
  return `(${keyset.columns.join(', ')}) ${operator} (${bound.join(', ')})`;
}
