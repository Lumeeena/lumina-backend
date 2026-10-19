-- Trustlines index and growth audit. Read-only; safe to run on a deployment:
--
--   psql "$DATABASE_URL" -f db/audit/trustlines.sql
--
-- idx_scan and the n_tup_* counters are cumulative since the last statistics
-- reset (pg_stat_reset() or a crash), so record stats_reset with the output and
-- run it after a representative stretch of indexing *and* API traffic. See
-- docs/TRUSTLINES_INDEX_REVIEW.md for how the numbers were read.
-- Each statement is preceded by "-- name:" so db/audit/trustlines.ts can label it.

-- name: index usage
SELECT s.indexrelname AS index_name,
       s.idx_scan,
       s.idx_tup_read,
       pg_relation_size(s.indexrelid) AS bytes,
       pg_get_indexdef(s.indexrelid) AS definition
FROM pg_stat_user_indexes s
WHERE s.relname = 'trustlines'
ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC;

-- name: table activity
-- hot_pct is the share of updates that touched no index. An update that changes
-- an indexed column (or a column in a partial index predicate) can never be HOT.
SELECT seq_scan, seq_tup_read, idx_scan,
       n_tup_ins, n_tup_upd, n_tup_hot_upd, n_tup_del,
       round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct,
       n_live_tup, n_dead_tup,
       pg_relation_size(relid) AS heap_bytes,
       pg_indexes_size(relid) AS index_bytes,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset
FROM pg_stat_user_tables
WHERE relname = 'trustlines';

-- name: index columns
-- For spotting structural redundancy: an index whose leading column is already
-- the leading column of the primary key serves no lookup the key cannot.
SELECT i.indexrelid::regclass AS index_name,
       i.indisprimary AS is_pk,
       array_agg(a.attname ORDER BY k.ord) AS columns,
       pg_get_expr(i.indpred, i.indrelid) AS predicate
FROM pg_index i
CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
WHERE i.indrelid = 'trustlines'::regclass
GROUP BY i.indexrelid, i.indisprimary, i.indpred, i.indrelid
ORDER BY i.indisprimary DESC, 1;

-- name: growth
-- One row per (account, asset, network) ever written and not since removed by a
-- change_trust with limit 0. zero_numeric counts rows a holder query would skip;
-- zero_not_literal counts the ones `balance <> '0'` does not, because numeric
-- arithmetic writes zero back as '0.0000000'.
SELECT network,
       count(*) AS rows,
       count(DISTINCT account) AS accounts,
       count(DISTINCT (asset_code, asset_issuer)) AS assets,
       count(*) FILTER (WHERE balance::numeric = 0) AS zero_numeric,
       count(*) FILTER (WHERE balance::numeric = 0 AND balance <> '0') AS zero_not_literal,
       count(*) FILTER (WHERE balance::numeric < 0) AS negative,
       min(last_modified_ledger) AS oldest_ledger,
       max(last_modified_ledger) AS newest_ledger
FROM trustlines
GROUP BY network
ORDER BY network;

-- name: bytes per row
SELECT count(*) AS rows,
       round(pg_relation_size('trustlines') / NULLIF(count(*), 0)::numeric) AS heap_bytes_per_row,
       round(pg_indexes_size('trustlines') / NULLIF(count(*), 0)::numeric) AS index_bytes_per_row
FROM trustlines;
