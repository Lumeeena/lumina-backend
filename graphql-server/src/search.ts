/**
 * Memo search and asset filtering.
 *
 * ## Ranking
 *
 * Relevance is trigram similarity, not `ts_rank`. `to_tsvector` is built for
 * prose — it stems words and discards short tokens — and Stellar memos are
 * mostly not prose: order references, exchange deposit tags, invoice numbers.
 * Stemming "ORDER-4471" is not just unhelpful, it is wrong. Trigram treats the
 * memo as a string, so substrings, typos and case differences all behave the
 * same way, and one GIN index serves both ranking and `ILIKE`.
 *
 * An exact case-insensitive match is boosted above everything else, because
 * someone pasting a full memo is looking for that transaction, not for things
 * that resemble it.
 *
 * ## Pagination
 *
 * Keyset, on the ranking tuple itself: `(rank, ledger, hash)`. Rank is
 * deterministic for a fixed query string, so a page boundary stays where it was
 * even as new ledgers land — which an `OFFSET` would not, since a newly indexed
 * matching transaction would shift every subsequent page by one and duplicate a
 * row across the seam.
 */
import type { Pool } from 'pg';
import { mapOperation, mapTransaction, type OperationRow, type TransactionRow } from './db';

/**
 * Below this, trigram matches are noise — two unrelated short strings share
 * trigrams surprisingly often. Tuned low enough that a partial memo still
 * matches, high enough that a three-character query does not return the table.
 */
export const MIN_SIMILARITY = 0.15;

/** Longest query we will run. Beyond this it is not a memo search. */
export const MAX_QUERY_LENGTH = 256;

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchError';
  }
}

export interface SearchCursor {
  rank: number;
  ledger: number;
  hash: string;
}

/**
 * Cursors are opaque to clients, so they are base64 rather than a readable
 * tuple — a client that starts constructing them by hand becomes a
 * compatibility constraint on the ranking function.
 */
export function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

export function decodeCursor(raw: string): SearchCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
    if (
      typeof parsed?.rank !== 'number' ||
      typeof parsed?.ledger !== 'number' ||
      typeof parsed?.hash !== 'string'
    ) {
      return null;
    }
    return { rank: parsed.rank, ledger: parsed.ledger, hash: parsed.hash };
  } catch {
    return null;
  }
}

export interface SearchOptions {
  /** Network to search — ranking and cursors are scoped to it. */
  network: string;
  query: string;
  limit: number;
  cursor?: string | null;
}

interface RankedTransactionRow extends TransactionRow {
  rank: number;
}

/**
 * Transactions whose memo matches `query`, most relevant first.
 *
 * Returns the mapped transactions plus the cursor for the next page, so the
 * resolver never has to know how ranking is computed.
 */
export async function searchTransactions(pool: Pool, options: SearchOptions) {
  const query = options.query.trim();

  if (query.length === 0) {
    throw new SearchError('Search query cannot be empty.');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new SearchError(`Search query cannot exceed ${MAX_QUERY_LENGTH} characters.`);
  }

  // An exact case-insensitive hit ranks above every fuzzy one: pasting a full
  // memo means looking for that transaction, not for things resembling it.
  const rankExpression = `GREATEST(similarity(memo, $1), CASE WHEN lower(memo) = lower($1) THEN 1 ELSE 0 END)`;

  const params: unknown[] = [query, MIN_SIMILARITY, options.network];
  const conditions = [
    'network = $3',
    'memo IS NOT NULL',
    // `%` uses the GIN trigram index; the explicit threshold keeps the
    // behaviour independent of the session's pg_trgm.similarity_threshold.
    'memo % $1',
    `${rankExpression} >= $2`,
  ];

  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    if (!cursor) {
      throw new SearchError('Invalid cursor.');
    }
    params.push(cursor.rank, cursor.ledger, cursor.hash);
    const base = params.length - 2;
    // Keyset on the full ordering tuple, so the boundary is stable as new
    // ledgers land rather than shifting the way an OFFSET would.
    conditions.push(
      `(${rankExpression}, ledger, hash) < ($${base}::real, $${base + 1}::bigint, $${base + 2})`
    );
  }

  params.push(options.limit);

  const { rows } = await pool.query<RankedTransactionRow>(
    `SELECT *, ${rankExpression} AS rank
       FROM transactions
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank DESC, ledger DESC, hash DESC
      LIMIT $${params.length}`,
    params
  );

  const items = rows.map(mapTransaction);
  const last = rows.at(-1);

  return {
    items,
    nextCursor: last
      ? encodeCursor({ rank: Number(last.rank), ledger: Number(last.ledger), hash: last.hash })
      : null,
  };
}

export interface ParsedAsset {
  /** Null for the native asset. */
  code: string | null;
  issuer: string | null;
  native: boolean;
}

/**
 * Parse the `CODE:ISSUER` form the API exposes.
 *
 * `XLM` and `native` both mean the native asset, which carries no code or
 * issuer on an operation — only `asset_type`. Without handling that explicitly,
 * native payments would be unfindable by asset, which is the most common asset
 * there is.
 */
export function parseAsset(asset: string): ParsedAsset {
  const trimmed = asset.trim();
  if (trimmed.length === 0) {
    throw new SearchError('Asset filter cannot be empty.');
  }

  if (trimmed.toUpperCase() === 'XLM' || trimmed.toLowerCase() === 'native') {
    return { code: null, issuer: null, native: true };
  }

  const [code, issuer, ...rest] = trimmed.split(':');
  if (!code || !issuer || rest.length > 0) {
    throw new SearchError(
      `Asset filter must be "CODE:ISSUER" (or "XLM" for the native asset), got "${asset}".`
    );
  }

  return { code, issuer, native: false };
}

/**
 * Build the SQL conditions matching operations that involve `asset`.
 *
 * An asset can appear on an operation in three roles — the payment asset, or
 * either side of an offer — so a filter that only checked `asset_code` would
 * silently miss every trade in that asset.
 */
export function assetConditions(asset: ParsedAsset, params: unknown[]): string {
  if (asset.native) {
    params.push('native');
    const p = `$${params.length}`;
    return `(details->>'asset_type' = ${p}
          OR details->>'selling_asset_type' = ${p}
          OR details->>'buying_asset_type' = ${p})`;
  }

  params.push(asset.code, asset.issuer);
  const code = `$${params.length - 1}`;
  const issuer = `$${params.length}`;

  return `((details->>'asset_code' = ${code} AND details->>'asset_issuer' = ${issuer})
        OR (details->>'selling_asset_code' = ${code} AND details->>'selling_asset_issuer' = ${issuer})
        OR (details->>'buying_asset_code' = ${code} AND details->>'buying_asset_issuer' = ${issuer}))`;
}

export interface AssetOperationsOptions {
  /** Network whose operations to filter. */
  network: string;
  asset: string;
  account?: string | null;
  type?: string | null;
  limit: number;
  cursor?: string | null;
}

/** Operations involving one asset, newest first. */
export async function getOperationsByAsset(pool: Pool, options: AssetOperationsOptions) {
  const parsed = parseAsset(options.asset);
  const params: unknown[] = [options.network];
  const conditions = ['network = $1', assetConditions(parsed, params)];

  if (options.account) {
    params.push(options.account);
    conditions.push(`source_account = $${params.length}`);
  }
  if (options.type) {
    params.push(options.type.toLowerCase());
    conditions.push(`type = $${params.length}`);
  }
  if (options.cursor) {
    params.push(options.cursor);
    conditions.push(
      `(ledger, id) < (SELECT ledger, id FROM operations WHERE id = $${params.length} LIMIT 1)`
    );
  }

  params.push(options.limit);

  const { rows } = await pool.query<OperationRow>(
    `SELECT * FROM operations
      WHERE ${conditions.join(' AND ')}
      ORDER BY ledger DESC, id DESC
      LIMIT $${params.length}`,
    params
  );

  return rows.map(mapOperation);
}
