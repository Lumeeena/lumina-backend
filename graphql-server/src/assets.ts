/**
 * Asset detail in one call: supply, holder count and a bucketed volume series.
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
import { assetConditions, parseAsset, type ParsedAsset } from './search';

export class AssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

/** Daily buckets when the client passes no `bucketSeconds`. */
export const DEFAULT_BUCKET_SECONDS = 86400;
/** Trailing window when the client passes no `from`/`to`. */
export const DEFAULT_RANGE_DAYS = 30;
/** Below this a bucket is noise and the series explodes; reject it. */
export const MIN_BUCKET_SECONDS = 60;
/** Upper bound on buckets per call so one detail page cannot fan out. */
export const MAX_BUCKETS = 1000;

export interface AssetDetailQuery {
  /** Network whose holders and volume to count. */
  network: string;
  asset: string;
  from?: string | null;
  to?: string | null;
  bucketSeconds?: number | null;
}

export interface ResolvedRange {
  start: Date;
  end: Date;
  bucketSeconds: number;
}

export interface VolumeBucket {
  bucketStart: string;
  bucketEnd: string;
  volume: string;
  operationCount: number;
}

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
