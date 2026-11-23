/**
 * Asset detail and directory queries:
 * - **Detail (`getAssetDetail`)**: supply, holder count, and a bucketed volume series in one call.
 * - **Directory (`getAssets`, `getAssetByKey`)**: keyset-paginated browsing by holder count or
 *   7-day volume, plus single-asset lookup from the pre-aggregated `assets` and
 *   `asset_volume_buckets` tables.
 *
 * ## How supply is derived
 *
 * Supply is the sum of `balance` over every row in `accounts.balances` that
 * names the asset — `asset_code` + `asset_issuer` for issued assets,
 * `asset_type = 'native'` for XLM — restricted to balances greater than zero.
 * Holders is the count of those rows (one per account holding the asset).
 * Amounts are summed as `numeric` and returned as strings, so large supplies
 * never pass through a JS number or JSON float.
 *
 * ## Limitations (read before quoting the number)
 *
 * - The indexer only writes accounts it has seen activity for, so supply and
 *   holders cover indexed accounts, not the whole network. A fresh database
 *   understates both until it catches up.
 * - Balances are a last-seen snapshot (`accounts.balances` is overwritten on
 *   each account re-index), not a historical reconstruction. Supply is "as of
 *   the last time each holder was indexed", which is only a single point in
 *   time when every holder is freshly indexed.
 * - Zero-balance trustlines are excluded from holders but would still count
 *   as holders on a ledger-state view; unauthorized, frozen or clawed-back
 *   balances are included because the snapshot carries no authorization flag
 *   per balance entry.
 * - Buying/selling liabilities are not subtracted; the snapshot's `balance`
 *   is the gross holding.
 * - Volume sums `details->>'amount'` on operations matching the same asset
 *   predicate the `operations(asset:)` filter uses (payment asset or either
 *   side of an offer), bucketed by `created_at`. Operations without a numeric
 *   amount contribute to the bucket's operation count but not its volume, and
 *   operations from failed transactions are included because the table carries
 *   no per-operation success flag.
 */
import type { Pool } from 'pg';
import { InvalidInputError } from './errorCodes';
import { assetConditions, parseAsset, type ParsedAsset } from './search';

/** An asset-detail request the server cannot serve: bad bucket size, range, timestamp or cursor. */
export class AssetError extends InvalidInputError {
  constructor(message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

/**
 * Daily buckets (86,400s) when the client omits `bucketSeconds`.
 * Pairs with `DEFAULT_RANGE_DAYS` (30) to yield ~30 data points by default,
 * balancing chart readability with `generate_series` / join cost.
 */
export const DEFAULT_BUCKET_SECONDS = 86400;
/**
 * Trailing 30-day window when the client omits `from`/`to`.
 * Provides a meaningful recent trend without scanning unbounded operation history.
 */
export const DEFAULT_RANGE_DAYS = 30;
/**
 * Minimum allowed bucket width (60s).
 * Sub-minute buckets are mostly noise against ~5s ledger close times and would
 * quickly hit `MAX_BUCKETS` even over short time ranges.
 */
export const MIN_BUCKET_SECONDS = 60;
/**
 * Upper bound on buckets per detail query (1,000).
 * Caps `generate_series` output and GraphQL response size so a single call
 * cannot fan out into tens of thousands of rows.
 */
export const MAX_BUCKETS = 1000;

/** Input parameters for `getAssetDetail`. */
export interface AssetDetailQuery {
  /** Network whose holders and volume to count. */
  network: string;
  asset: string;
  from?: string | null;
  to?: string | null;
  bucketSeconds?: number | null;
}

/** Validated, concrete time bounds and bucket width produced by `resolveRange`. */
export interface ResolvedRange {
  start: Date;
  end: Date;
  bucketSeconds: number;
}

/** Single time-bucketed volume point returned in `AssetDetail.series`. */
export interface VolumeBucket {
  bucketStart: string;
  bucketEnd: string;
  volume: string;
  operationCount: number;
}

/** Combined supply, holder count, and volume series returned by `getAssetDetail`. */
export interface AssetDetail {
  asset: string;
  code: string | null;
  issuer: string | null;
  native: boolean;
  supply: string;
  holders: number;
  series: VolumeBucket[];
}

interface SupplyRow {
  holders: string | number;
  supply: string | number | null;
}

interface SeriesRow {
  bucket_start: Date | string;
  bucket_end: Date | string;
  volume: string | number | null;
  operation_count: string | number | null;
}

/**
 * Validate the range and bucket size. Bounds are passed through to Postgres
 * as parameters; the bucket width reaches SQL only as a number multiplied by
 * `INTERVAL '1 second'`, never interpolated, so an hostile input cannot
 * become SQL.
 */
export function resolveRange(query: AssetDetailQuery): ResolvedRange {
  const bucketSeconds = query.bucketSeconds ?? DEFAULT_BUCKET_SECONDS;

  if (!Number.isInteger(bucketSeconds) || bucketSeconds < MIN_BUCKET_SECONDS) {
    throw new AssetError(
      `Bucket size must be an integer of at least ${MIN_BUCKET_SECONDS} seconds.`
    );
  }

  const end = query.to != null && query.to !== '' ? parseTime(query.to, 'to') : new Date();
  const start =
    query.from != null && query.from !== ''
      ? parseTime(query.from, 'from')
      : new Date(end.getTime() - DEFAULT_RANGE_DAYS * 86400 * 1000);

  if (!(start < end)) {
    throw new AssetError('Range start ("from") must be before range end ("to").');
  }

  const bucketCount = Math.ceil((end.getTime() - start.getTime()) / (bucketSeconds * 1000));
  if (bucketCount > MAX_BUCKETS) {
    throw new AssetError(
      `Range spans ${bucketCount} buckets of ${bucketSeconds}s, above the limit of ${MAX_BUCKETS}. ` +
        'Narrow the range or use a larger bucket.'
    );
  }

  return { start, end, bucketSeconds };
}

function parseTime(value: string, label: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AssetError(`Invalid "${label}" timestamp: ${JSON.stringify(value)}. Use ISO-8601.`);
  }
  return parsed;
}

/**
 * WHERE clause over the `b` lateral alias in the supply query. Kept separate
 * from `assetConditions` (which targets `operations.details`) because the two
 * tables spell the same asset differently: a balance entry vs an operation.
 */
export function balanceConditions(asset: ParsedAsset, params: unknown[]): string {
  if (asset.native) {
    params.push('native');
    return `(b->>'asset_type' = $${params.length} AND (b->>'balance')::numeric > 0)`;
  }
  params.push(asset.code, asset.issuer);
  const code = `$${params.length - 1}`;
  const issuer = `$${params.length}`;
  return `((b->>'asset_code' = ${code} AND b->>'asset_issuer' = ${issuer}) AND (b->>'balance')::numeric > 0)`;
}

/**
 * Compute current holder count and total gross supply for `asset` on `network`
 * from `accounts.balances`, excluding zero-balance trustlines.
 * Returns `{ supply: '0', holders: 0 }` when no matching balances exist;
 * `supply` is returned as a decimal string to preserve `numeric` precision.
 */
export async function getAssetSupply(
  pool: Pool,
  network: string,
  asset: ParsedAsset
): Promise<{ supply: string; holders: number }> {
  const params: unknown[] = [network];
  const { rows } = await pool.query<SupplyRow>(
    `SELECT COUNT(*)::int AS holders, COALESCE(SUM((b->>'balance')::numeric), 0)::text AS supply
       FROM accounts, LATERAL jsonb_array_elements(balances) AS b
      WHERE network = $1 AND ${balanceConditions(asset, params)}`,
    params
  );
  const row = rows[0];
  return {
    supply: row == null || row.supply == null ? '0' : String(row.supply),
    holders: row == null ? 0 : Number(row.holders),
  };
}

/**
 * Query a zero-filled, ascending time series of operation volume and count for
 * `asset` over `range`. Uses `generate_series` left-joined to `operations` via
 * `assetConditions` and ignores non-numeric `details->>'amount'` values when
 * summing volume.
 */
export async function getAssetVolumeSeries(
  pool: Pool,
  network: string,
  asset: ParsedAsset,
  range: ResolvedRange
): Promise<VolumeBucket[]> {
  const params: unknown[] = [range.start.toISOString(), range.end.toISOString(), range.bucketSeconds, network];
  const assetClause = assetConditions(asset, params);

  const { rows } = await pool.query<SeriesRow>(
    `WITH buckets AS (
       SELECT generate_series($1::timestamptz, $2::timestamptz, $3 * INTERVAL '1 second') AS bucket_start
     )
     SELECT buckets.bucket_start AS bucket_start,
            (buckets.bucket_start + $3 * INTERVAL '1 second') AS bucket_end,
            COALESCE(
              SUM((operations.details->>'amount')::numeric)
                FILTER (WHERE operations.details->>'amount' ~ '^[0-9]+(\\.[0-9]+)?$'),
              0
            )::text AS volume,
            COUNT(operations.id)::int AS operation_count
       FROM buckets
       LEFT JOIN operations
         ON operations.created_at >= buckets.bucket_start
        AND operations.created_at < buckets.bucket_start + $3 * INTERVAL '1 second'
        AND operations.created_at >= $1::timestamptz
        AND operations.created_at <= $2::timestamptz
        AND operations.network = $4
        AND ${assetClause}
      GROUP BY buckets.bucket_start
      ORDER BY buckets.bucket_start ASC`,
    params
  );

  return rows.map(row => ({
    bucketStart: row.bucket_start instanceof Date ? row.bucket_start.toISOString() : String(row.bucket_start),
    bucketEnd: row.bucket_end instanceof Date ? row.bucket_end.toISOString() : String(row.bucket_end),
    volume: row.volume == null ? '0' : String(row.volume),
    operationCount: Number(row.operation_count ?? 0),
  }));
}

/**
 * Everything an asset detail page needs in one resolver call: the current
 * supply and holder count plus the bucketed volume series. Two SQL queries —
 * one over `accounts`, one over `operations` — so the page still costs one
 * GraphQL round trip, and the series reuses the exact asset predicate the
 * operations filter uses, so its buckets always agree with the underlying
 * operation list.
 */
export async function getAssetDetail(pool: Pool, query: AssetDetailQuery): Promise<AssetDetail> {
  const parsed = parseAsset(query.asset);
  const range = resolveRange(query);

  const [{ supply, holders }, series] = await Promise.all([
    getAssetSupply(pool, query.network, parsed),
    getAssetVolumeSeries(pool, query.network, parsed, range),
  ]);

  return {
    asset: parsed.native ? 'XLM' : `${parsed.code}:${parsed.issuer}`,
    code: parsed.code,
    issuer: parsed.issuer,
    native: parsed.native,
    supply,
    holders,
    series,
  };
}

// ─── Assets browsing (Issue #74) ─────────────────────────────────────────────

/** Filter, sort, and keyset-pagination parameters for `getAssets`. */
export interface AssetsQuery {
  network: string;
  sortBy?: 'HOLDERS' | 'VOLUME';
  search?: string | null;
  limit?: number;
  cursor?: string | null;
}

/** Indexed issued-asset summary returned by `getAssets` and `getAssetByKey`. */
export interface Asset {
  code: string;
  issuer: string;
  holderCount: number;
  firstSeenLedger: number;
  lastActivityLedger: number;
  recentVolume?: string;
  issuerHomeDomain?: string | null;
  issuerMetadata?: string | null;
  isLookalike?: boolean;
}

/** Forward-pagination metadata for `AssetPage`. */
export interface AssetPageInfo {
  hasNextPage: boolean;
  cursor: string | null;
}

/** Paginated list of assets returned by `getAssets`. */
export interface AssetPage {
  items: Asset[];
  pageInfo: AssetPageInfo;
}

interface AssetRow {
  asset_code: string;
  asset_issuer: string;
  holder_count: number;
  first_seen_ledger: number;
  last_activity_ledger: number;
  recent_volume: string | null;
  issuer_home_domain: string | null;
  issuer_metadata: unknown | null;
  is_lookalike: boolean | null;
}

/**
 * Parse keyset pagination cursor for assets.
 * Format: "holderCount|code|issuer" or "volume|code|issuer"
 */
function parseCursor(cursor: string): { value: string; code: string; issuer: string } {
  const parts = cursor.split('|');
  if (parts.length !== 3) {
    throw new AssetError('Invalid cursor format');
  }
  return { value: parts[0], code: parts[1], issuer: parts[2] };
}

/**
 * Encode keyset pagination cursor for assets.
 */
function encodeCursor(value: string | number, code: string, issuer: string): string {
  return `${value}|${code}|${issuer}`;
}

/**
 * Get a single asset by code and issuer on `network`, including its trailing
 * 7-day volume from `asset_volume_buckets`. Returns `null` if not indexed.
 */
export async function getAssetByKey(
  pool: Pool,
  network: string,
  code: string,
  issuer: string
): Promise<Asset | null> {
  const { rows } = await pool.query<AssetRow>(
    `SELECT a.asset_code, a.asset_issuer, a.holder_count, a.first_seen_ledger, a.last_activity_ledger,
            COALESCE(
              (SELECT SUM(volume)::text
               FROM asset_volume_buckets
               WHERE asset_code = a.asset_code
                 AND asset_issuer = a.asset_issuer
                 AND network = a.network
                 AND bucket_time >= NOW() - INTERVAL '7 days'),
              '0'
            ) AS recent_volume,
            a.issuer_home_domain,
            a.issuer_metadata,
            a.is_lookalike
       FROM assets a
      WHERE a.asset_code = $1 AND a.asset_issuer = $2 AND a.network = $3`,
    [code, issuer, network]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    code: row.asset_code,
    issuer: row.asset_issuer,
    holderCount: row.holder_count,
    firstSeenLedger: row.first_seen_ledger,
    lastActivityLedger: row.last_activity_ledger,
    recentVolume: row.recent_volume ?? '0',
    issuerHomeDomain: row.issuer_home_domain,
    issuerMetadata: row.issuer_metadata ? JSON.stringify(row.issuer_metadata) : null,
    isLookalike: row.is_lookalike ?? false,
  };
}

/**
 * Browse assets with keyset pagination, sorted by holder count (default) or
 * trailing 7-day volume (descending), with `(asset_code, asset_issuer)` ascending
 * tie-breakers. Defaults to `limit = 20` and fetches `limit + 1` rows to
 * determine `hasNextPage` without a separate `COUNT(*)` query. Throws
 * `AssetError` on malformed cursors (`"value|code|issuer"`).
 */
export async function getAssets(pool: Pool, query: AssetsQuery): Promise<AssetPage> {
  const limit = query.limit ?? 20;
  const sortBy = query.sortBy ?? 'HOLDERS';
  const params: unknown[] = [query.network, limit + 1]; // Fetch one extra to check hasNextPage
  const whereClauses: string[] = ['a.network = $1'];
  let orderClause: string;
  let cursorClause = '';

  // Add search filter
  if (query.search && query.search.trim() !== '') {
    params.push(`%${query.search.trim()}%`);
    whereClauses.push(`a.asset_code ILIKE $${params.length}`);
  }

  // Handle cursor for pagination
  if (query.cursor) {
    try {
      const { value, code, issuer } = parseCursor(query.cursor);
      
      if (sortBy === 'VOLUME') {
        params.push(value, code, issuer);
        cursorClause = `AND (
          v.recent_volume < $${params.length - 2}::numeric 
          OR (v.recent_volume = $${params.length - 2}::numeric AND (a.asset_code > $${params.length - 1} OR (a.asset_code = $${params.length - 1} AND a.asset_issuer > $${params.length})))
        )`;
      } else {
        params.push(value, code, issuer);
        // The leading `<=` is implied by the OR below, but only it can become an
        // index condition on idx_assets_network_holders: without it a page walks
        // the index from the top and filters out every row before the cursor.
        cursorClause = `AND a.holder_count <= $${params.length - 2}::int
        AND (
          a.holder_count < $${params.length - 2}::int
          OR (a.holder_count = $${params.length - 2}::int AND (a.asset_code > $${params.length - 1} OR (a.asset_code = $${params.length - 1} AND a.asset_issuer > $${params.length})))
        )`;
      }
    } catch (err) {
      throw new AssetError('Invalid pagination cursor');
    }
  }

  // Build query based on sort order
  let query_sql: string;
  if (sortBy === 'VOLUME') {
    orderClause = 'v.recent_volume DESC, a.asset_code ASC, a.asset_issuer ASC';
    query_sql = `
      WITH volume_agg AS (
        SELECT asset_code, asset_issuer, network,
               COALESCE(SUM(volume), 0) AS recent_volume
          FROM asset_volume_buckets
         WHERE network = $1
           AND bucket_time >= NOW() - INTERVAL '7 days'
         GROUP BY asset_code, asset_issuer, network
      )
      SELECT a.asset_code, a.asset_issuer, a.holder_count,
             a.first_seen_ledger, a.last_activity_ledger,
             COALESCE(v.recent_volume, 0)::text AS recent_volume,
             a.issuer_home_domain,
             a.issuer_metadata,
             a.is_lookalike
        FROM assets a
        LEFT JOIN volume_agg v ON v.asset_code = a.asset_code
                               AND v.asset_issuer = a.asset_issuer
                               AND v.network = a.network
       WHERE ${whereClauses.join(' AND ')}
         ${cursorClause}
       ORDER BY ${orderClause}
       LIMIT $2
    `;
  } else {
    orderClause = 'a.holder_count DESC, a.asset_code ASC, a.asset_issuer ASC';
    query_sql = `
      SELECT a.asset_code, a.asset_issuer, a.holder_count,
             a.first_seen_ledger, a.last_activity_ledger,
             COALESCE(
               (SELECT SUM(volume)::text
                FROM asset_volume_buckets
                WHERE asset_code = a.asset_code
                  AND asset_issuer = a.asset_issuer
                  AND network = a.network
                  AND bucket_time >= NOW() - INTERVAL '7 days'),
               '0'
             ) AS recent_volume,
             a.issuer_home_domain,
             a.issuer_metadata,
             a.is_lookalike
        FROM assets a
       WHERE ${whereClauses.join(' AND ')}
         ${cursorClause}
       ORDER BY ${orderClause}
       LIMIT $2
    `;
  }

  const { rows } = await pool.query<AssetRow>(query_sql, params);

  // Check if there are more results
  const hasNextPage = rows.length > limit;
  const items = rows.slice(0, limit);

  // Generate cursor from last item
  let nextCursor: string | null = null;
  if (hasNextPage && items.length > 0) {
    const last = items[items.length - 1];
    const cursorValue = sortBy === 'VOLUME' ? (last.recent_volume ?? '0') : last.holder_count.toString();
    nextCursor = encodeCursor(cursorValue, last.asset_code, last.asset_issuer);
  }

  return {
    items: items.map(row => ({
      code: row.asset_code,
      issuer: row.asset_issuer,
      holderCount: row.holder_count,
      firstSeenLedger: row.first_seen_ledger,
      lastActivityLedger: row.last_activity_ledger,
      recentVolume: row.recent_volume ?? '0',
      issuerHomeDomain: row.issuer_home_domain,
      issuerMetadata: row.issuer_metadata ? JSON.stringify(row.issuer_metadata) : null,
      isLookalike: row.is_lookalike ?? false,
    })),
    pageInfo: {
      hasNextPage,
      cursor: nextCursor,
    },
  };
}
