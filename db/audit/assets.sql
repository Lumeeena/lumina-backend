-- Assets index and growth audit. Read-only; safe to run on a deployment:
--
--   psql "$DATABASE_URL" -f db/audit/assets.sql
--
-- idx_scan and the n_tup_* counters are cumulative since the last statistics
-- reset (pg_stat_reset() or a crash), so record stats_reset with the output and
-- run it after a representative stretch of indexing *and* API traffic. See
-- docs/ASSETS_INDEX_REVIEW.md for how the numbers were read.
-- Each statement is preceded by "-- name:" so db/audit/assets.ts can label it.

-- name: index usage
SELECT s.indexrelname AS index_name,
       s.idx_scan,
       s.idx_tup_read,
       pg_relation_size(s.indexrelid) AS bytes,
       pg_get_indexdef(s.indexrelid) AS definition
FROM pg_stat_user_indexes s
WHERE s.relname = 'assets'
ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC;

-- name: table activity
-- hot_pct is the share of updates that touched no index. An update that changes
-- an indexed column (or a column in a partial index predicate) can never be HOT.
-- The indexer rewrites last_activity_ledger and updated_at on almost every
-- credit payment, and holder_count whenever a balance crosses zero.
SELECT seq_scan, seq_tup_read, idx_scan,
       n_tup_ins, n_tup_upd, n_tup_hot_upd, n_tup_del,
       round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct,
       n_live_tup, n_dead_tup,
       pg_relation_size(relid) AS heap_bytes,
       pg_indexes_size(relid) AS index_bytes,
       pg_total_relation_size(relid) - pg_relation_size(relid) - pg_indexes_size(relid) AS toast_bytes,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset
FROM pg_stat_user_tables
WHERE relname = 'assets';

-- name: index columns
-- writes_column marks an index that names a column the indexer updates in place
-- (holder_count, last_activity_ledger, updated_at). Such an index makes every
-- update that changes the column non-HOT and pays an index insert for it.
SELECT i.indexrelid::regclass AS index_name,
       i.indisprimary AS is_pk,
       array_agg(a.attname ORDER BY k.ord) AS columns,
       pg_get_expr(i.indpred, i.indrelid) AS predicate,
       bool_or(a.attname IN ('holder_count', 'last_activity_ledger', 'updated_at')) AS writes_column
FROM pg_index i
CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
WHERE i.indrelid = 'assets'::regclass
GROUP BY i.indexrelid, i.indisprimary, i.indpred, i.indrelid
ORDER BY i.indisprimary DESC, 1;

-- name: growth
-- One row per (code, issuer, network) the indexer has ever seen. Nothing deletes
-- from assets: a trustline removal only decrements holder_count. no_holders is
-- the share of rows that hold nothing and would be the only candidates for any
-- future pruning.
SELECT network,
       count(*) AS rows,
       count(DISTINCT asset_issuer) AS issuers,
       count(*) FILTER (WHERE holder_count = 0) AS no_holders,
       count(*) FILTER (WHERE holder_count >= 100) AS holders_100_plus,
       max(holder_count) AS max_holders,
       min(first_seen_ledger) AS first_seen,
       max(last_activity_ledger) AS last_activity,
       count(*) FILTER (WHERE issuer_metadata IS NOT NULL) AS with_metadata,
       count(*) FILTER (WHERE is_lookalike) AS lookalikes
FROM assets
GROUP BY network
ORDER BY network;

-- name: bytes per row
SELECT count(*) AS rows,
       round(pg_relation_size('assets') / NULLIF(count(*), 0)::numeric) AS heap_bytes_per_row,
       round(pg_indexes_size('assets') / NULLIF(count(*), 0)::numeric) AS index_bytes_per_row,
       round(avg(pg_column_size(issuer_metadata))) AS avg_metadata_bytes
FROM assets;
