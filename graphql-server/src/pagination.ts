/**
 * The cursor contract shared by every paginated query.
 *
 * ## One contract, not one convention
 *
 * A cursor is an opaque base64url string carrying the sort-key tuple of the last
 * row on the page it came from — `[ledger, hash]` for transactions, `[sequence]`
 * for ledgers, `[rank, ledger, hash]` for search. The tuple is compared in SQL
 * against the ordering the query already uses, which is what makes a page
 * boundary stay where it was as new rows land; an `OFFSET` would shift every
 * later page and duplicate a row across the seam.
 *
 * Encoding the tuple rather than the row's id is deliberate. A cursor that named
 * only an id would have to look the row up to learn where to resume, so a cursor
 * pointing at a row that has since gone away silently resumes from nothing and
 * answers with an empty page. Carrying the values means a cursor is either
 * decodable — and then it is a position — or it is not, and every query decides
 * that the same way.
 *
 * ## Reaching the end is not an error
 *
 * A well-formed cursor with no rows past it returns an empty page: that is how a
 * client learns it has finished. A cursor that cannot be decoded is an error
 * (`INVALID_CURSOR`) on every paginated query, because the alternative — an
 * empty page that a client reads as "the end" — silently truncates a result set
 * and looks like a bug in their code rather than in the request.
 */
import { GraphQLError } from 'graphql';

/** Page size a query uses when the caller does not ask for one. */
export const DEFAULT_PAGE_LIMIT = 20;

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
      extensions: { code: 'INVALID_CURSOR' },
    });
    this.name = 'InvalidCursorError';
  }
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
  cursor: string | null;
}

/**
 * The `pageInfo` for one page of results.
 *
 * `hasNextPage` is "a full page came back", which costs nothing extra and is
 * what every other paginated query has always reported. The cursor is the last
 * row's sort key whenever there is one, including on a short final page: a client
 * that stops because `hasNextPage` is false has nothing to do with it, and a
 * client that pages anyway gets the empty page that means it is done.
 *
 * `keyOf` returns the columns the query keysets on, in the same order — one
 * value for a single-column ordering, a tuple for a composite one.
 */
export function pageInfo<T>(
  keyset: Keyset,
  items: readonly T[],
  limit: number,
  keyOf: (item: T) => CursorValue | readonly CursorValue[]
): PageInfo {
  const last = items.at(-1);
  if (last === undefined) return { hasNextPage: false, cursor: null };
  const key = keyOf(last);
  const values = typeof key === 'string' || typeof key === 'number' ? [key] : [...key];
  if (values.length !== keyset.columns.length) {
    // A resolver minting the wrong number of values would issue cursors its own
    // query rejects; failing here names the mistake at its source.
    throw new Error(
      `${keyset.query}: cursor has ${values.length} sort keys but its keyset has ${keyset.columns.length}.`
    );
  }
  return { hasNextPage: items.length === limit, cursor: encodeCursor(keyset.query, values) };
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
  cursor?: string | null
): string | null {
  if (!cursor) return null;
  const values = decodeCursor(cursor, keyset.query, keyset.columns.length);
  const first = params.length + 1;
  const bound = keyset.columns.map((_, index) => `$${first + index}::${keyset.types[index]}`);
  params.push(...values);
  return `(${keyset.columns.join(', ')}) < (${bound.join(', ')})`;
}
