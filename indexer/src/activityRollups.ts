/**
 * Activity rollups writer and backfill (#380).
 *
 * Populates `activity_rollups` (created by migration 017) for both `hour` and
 * `day` granularities so `networkStats`, `activityRollups`, and
 * `getRollupConsistency` return real aggregates matching the base tables.
 *
 * ## Why in-transaction recomputation (rather than incremental deltas or a cron job)
 *
 * 1. **Reindex idempotence:** Reindexing a ledger executes `ON CONFLICT DO
 *    NOTHING` on `transactions` and `operations`. An incremental `SET
 *    transaction_count = transaction_count + $delta` would double-count every
 *    reindexed ledger unless an extra ledger-tracking table were maintained.
 *    Recomputing the touched `[bucket_start, bucket_end)` window directly from
 *    `transactions` and `operations` via `ON CONFLICT DO UPDATE` is strictly
 *    idempotent: running `indexLedger` N times yields the exact same bucket.
 * 2. **Exact `active_accounts`:** `COUNT(DISTINCT source_account)` over an hour
 *    or day cannot be derived by summing per-ledger counts.
 * 3. **Atomic freshness:** Updating inside `indexLedger`'s transaction guarantees
 *    that a rolled-back ledger never leaks into rollups and committed ledgers
 *    are immediately visible to `networkStats`.
 */
import type { Pool, PoolClient } from 'pg';

export type RollupGranularity = 'hour' | 'day';

export const ROLLUP_GRANULARITIES: readonly RollupGranularity[] = ['hour', 'day'];

/**
 * Truncate an ISO-8601 timestamp or Date to the UTC start of its `hour` or
 * `day` bucket. Returns an ISO-8601 string with `Z` suffix.
 */
export function bucketStartFor(timestamp: string | Date, granularity: RollupGranularity): string {
  const date = timestamp instanceof Date ? new Date(timestamp.getTime()) : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid ledger timestamp for activity rollup: ${String(timestamp)}`);
  }
  if (granularity === 'day') {
    date.setUTCHours(0, 0, 0, 0);
  } else {
    date.setUTCMinutes(0, 0, 0);
  }
  return date.toISOString();
}

/**
 * Exclusive upper bound (`bucket_start + 1 hour | 1 day`) in UTC ISO-8601.
 */
export function bucketEndFor(bucketStart: string, granularity: RollupGranularity): string {
  const date = new Date(bucketStart);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid bucket start timestamp: ${bucketStart}`);
  }
  if (granularity === 'day') {
    date.setUTCDate(date.getUTCDate() + 1);
  } else {
    date.setUTCHours(date.getUTCHours() + 1);
  }
  return date.toISOString();
}

const UPSERT_SINGLE_BUCKET_SQL = `
  WITH tx_agg AS (
    SELECT
      COUNT(*)::integer AS transaction_count,
      COUNT(DISTINCT source_account)::integer AS active_accounts
    FROM transactions
    WHERE network = $1
      AND created_at >= $3::timestamptz
      AND created_at < $4::timestamptz
  ),
  op_agg AS (
    SELECT
      COUNT(*)::integer AS operation_count,
      COALESCE(SUM(
        CASE
          WHEN type IN ('payment', 'path_payment_strict_receive', 'path_payment_strict_send')
               AND (details->>'amount') ~ '^[0-9]+(\\.[0-9]+)?$'
          THEN (details->>'amount')::numeric
          ELSE 0
        END
      ), 0)::numeric AS total_volume
    FROM operations
    WHERE network = $1
      AND created_at >= $3::timestamptz
      AND created_at < $4::timestamptz
  )
  INSERT INTO activity_rollups (
    network,
    granularity,
    bucket_start,
    transaction_count,
    operation_count,
    active_accounts,
    total_volume,
    updated_at
  )
  SELECT
    $1,
    $2,
    $3::timestamptz,
    tx_agg.transaction_count,
    op_agg.operation_count,
    tx_agg.active_accounts,
    op_agg.total_volume,
    NOW()
  FROM tx_agg, op_agg
  ON CONFLICT (network, granularity, bucket_start) DO UPDATE SET
    transaction_count = EXCLUDED.transaction_count,
    operation_count   = EXCLUDED.operation_count,
    active_accounts   = EXCLUDED.active_accounts,
    total_volume      = EXCLUDED.total_volume,
    updated_at        = NOW()
`;

/**
 * Recompute and upsert both the `hour` and `day` buckets containing `closedAt`
 * inside the caller's database transaction. Idempotent across ledger reindexes.
 */
export async function refreshActivityRollupsForTimestamp(
  client: Pick<PoolClient, 'query'>,
  network: string,
  closedAt: string | Date
): Promise<void> {
  for (const granularity of ROLLUP_GRANULARITIES) {
    const start = bucketStartFor(closedAt, granularity);
    const end = bucketEndFor(start, granularity);
    await client.query(UPSERT_SINGLE_BUCKET_SQL, [network, granularity, start, end]);
  }
}

export interface BackfillRollupsResult {
  network: string;
  hourBuckets: number;
  dayBuckets: number;
}

/**
 * Idempotently backfill `activity_rollups` from already-indexed `transactions`
 * and `operations` rows for `network`, optionally bounded by `[startTime, endTime)`.
 */
export async function backfillActivityRollups(
  pool: Pick<Pool, 'query'>,
  network: string,
  options: { startTime?: string; endTime?: string } = {}
): Promise<BackfillRollupsResult> {
  const counts: Record<RollupGranularity, number> = { hour: 0, day: 0 };

  for (const granularity of ROLLUP_GRANULARITIES) {
    const params: unknown[] = [network, granularity];
    const txTimeFilters: string[] = [];
    const opTimeFilters: string[] = [];

    if (options.startTime) {
      params.push(options.startTime);
      const idx = params.length;
      txTimeFilters.push(`created_at >= $${idx}::timestamptz`);
      opTimeFilters.push(`created_at >= $${idx}::timestamptz`);
    }
    if (options.endTime) {
      params.push(options.endTime);
      const idx = params.length;
      txTimeFilters.push(`created_at < $${idx}::timestamptz`);
      opTimeFilters.push(`created_at < $${idx}::timestamptz`);
    }

    const txWhere = ['network = $1', ...txTimeFilters].join(' AND ');
    const opWhere = ['network = $1', ...opTimeFilters].join(' AND ');

    const res = await pool.query(
      `WITH tx_buckets AS (
         SELECT
           date_trunc($2, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,
           COUNT(*)::integer AS transaction_count,
           COUNT(DISTINCT source_account)::integer AS active_accounts
         FROM transactions
         WHERE ${txWhere}
         GROUP BY 1
       ),
       op_buckets AS (
         SELECT
           date_trunc($2, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,
           COUNT(*)::integer AS operation_count,
           COALESCE(SUM(
             CASE
               WHEN type IN ('payment', 'path_payment_strict_receive', 'path_payment_strict_send')
                    AND (details->>'amount') ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN (details->>'amount')::numeric
               ELSE 0
             END
           ), 0)::numeric AS total_volume
         FROM operations
         WHERE ${opWhere}
         GROUP BY 1
       ),
       combined AS (
         SELECT
           COALESCE(tx.bucket_start, op.bucket_start) AS bucket_start,
           COALESCE(tx.transaction_count, 0) AS transaction_count,
           COALESCE(op.operation_count, 0) AS operation_count,
           COALESCE(tx.active_accounts, 0) AS active_accounts,
           COALESCE(op.total_volume, 0) AS total_volume
         FROM tx_buckets tx
         FULL OUTER JOIN op_buckets op ON tx.bucket_start = op.bucket_start
       )
       INSERT INTO activity_rollups (
         network, granularity, bucket_start,
         transaction_count, operation_count, active_accounts, total_volume, updated_at
       )
       SELECT
         $1, $2, bucket_start,
         transaction_count, operation_count, active_accounts, total_volume, NOW()
       FROM combined
       ON CONFLICT (network, granularity, bucket_start) DO UPDATE SET
         transaction_count = EXCLUDED.transaction_count,
         operation_count   = EXCLUDED.operation_count,
         active_accounts   = EXCLUDED.active_accounts,
         total_volume      = EXCLUDED.total_volume,
         updated_at        = NOW()`,
      params
    );

    counts[granularity] = res.rowCount ?? 0;
  }

  return {
    network,
    hourBuckets: counts.hour,
    dayBuckets: counts.day,
  };
}
