-- Operations index and growth audit. Read-only; safe to run on a deployment:
--
--   psql "$DATABASE_URL" -f db/audit/operations.sql
--
-- idx_scan, seq_scan and the n_tup_* counters are cumulative since the last
-- statistics reset (pg_stat_reset() or a crash), so record stats_reset with the
-- output and run it after a representative stretch of indexing *and* API
-- traffic — at least a day, so the daily jobs (retention, exports) are in it.
-- See docs/OPERATIONS_INDEX_REVIEW.md for how the numbers were read.
-- Each statement is preceded by "-- name:" so db/audit/operations.ts can label it.

-- name: index usage
-- An index with idx_scan = 0 after a representative window is paid for on
-- every insert and read by nothing. bytes_per_row is what each index costs per
-- operation stored.
SELECT s.indexrelname AS index_name,
       s.idx_scan,
       s.idx_tup_read,
       pg_relation_size(s.indexrelid) AS bytes,
       round(pg_relation_size(s.indexrelid) / NULLIF(t.n_live_tup, 0)::numeric, 1) AS bytes_per_row,
       pg_get_indexdef(s.indexrelid) AS definition
FROM pg_stat_user_indexes s
JOIN pg_stat_user_tables t ON t.relid = s.relid
WHERE s.relname = 'operations'
ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC;

-- name: table activity
-- seq_tup_read / seq_scan is the average number of rows a sequential scan
-- read: anything close to n_live_tup is a scan of the whole table, which on
-- operations is never what a request wants.
SELECT seq_scan, seq_tup_read,
       round(seq_tup_read / NULLIF(seq_scan, 0)::numeric) AS rows_per_seq_scan,
       idx_scan,
       n_tup_ins, n_tup_upd, n_tup_del,
       n_live_tup, n_dead_tup,
       last_autovacuum, last_autoanalyze,
       pg_relation_size(relid) AS heap_bytes,
       pg_total_relation_size(relid) - pg_relation_size(relid) - pg_indexes_size(relid) AS toast_bytes,
       pg_indexes_size(relid) AS index_bytes,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset
FROM pg_stat_user_tables
WHERE relname = 'operations';

-- name: index columns
-- One row per index with its key columns or expressions and predicate, so a
-- prefix shared by two indexes — the one-column index made redundant by a
-- composite that starts with the same column — is visible side by side.
SELECT i.indexrelid::regclass AS index_name,
       i.indisprimary AS is_pk,
       am.amname AS method,
       pg_get_indexdef(i.indexrelid, 1, true) AS first_key,
       i.indnatts AS key_count,
       pg_get_expr(i.indpred, i.indrelid) AS predicate
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_am am ON am.oid = c.relam
WHERE i.indrelid = 'operations'::regclass
ORDER BY first_key, key_count;

-- name: statements on operations
-- What actually reads the table, if pg_stat_statements is installed. It is
-- optional, and without it this one statement fails with "relation does not
-- exist" and the rest still run. Mean rows and shared blocks per call point at
-- the statement doing a scan it should not.
SELECT calls,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round(rows / NULLIF(calls, 0)::numeric, 1) AS rows_per_call,
       round((shared_blks_hit + shared_blks_read) / NULLIF(calls, 0)::numeric) AS blocks_per_call,
       left(regexp_replace(query, '\s+', ' ', 'g'), 160) AS query
FROM pg_stat_statements
WHERE query ILIKE '%from operations%'
ORDER BY (shared_blks_hit + shared_blks_read) DESC
LIMIT 25;

-- name: growth by day
-- Rows per day of chain time, per network, for the last two weeks indexed.
-- Nothing deletes from operations unless RETENTION_OPERATIONS_DAYS is set, so
-- without it this rate is the table's growth, forever.
SELECT network,
       date_trunc('day', created_at) AS day,
       count(*) AS rows,
       count(DISTINCT ledger) AS ledgers,
       round(count(*) / NULLIF(count(DISTINCT ledger), 0)::numeric, 1) AS rows_per_ledger
FROM operations
WHERE created_at >= (SELECT max(created_at) FROM operations) - INTERVAL '14 days'
GROUP BY network, day
ORDER BY network, day;

-- name: bytes per row
-- What one stored operation costs, split the way the table is: the heap row,
-- the TOASTed part of `details`, and the indexes.
SELECT count(*) AS rows,
       round(pg_relation_size('operations') / NULLIF(count(*), 0)::numeric) AS heap_bytes_per_row,
       round((pg_total_relation_size('operations') - pg_relation_size('operations') - pg_indexes_size('operations'))
             / NULLIF(count(*), 0)::numeric) AS toast_bytes_per_row,
       round(pg_indexes_size('operations') / NULLIF(count(*), 0)::numeric) AS index_bytes_per_row,
       round(avg(pg_column_size(details))) AS avg_details_bytes
FROM operations;

-- name: retention
-- The oldest row per network. With a retention window configured this should
-- sit about that many days behind the newest; without one it is the first
-- ledger ever indexed.
SELECT network,
       min(created_at) AS oldest,
       max(created_at) AS newest,
       max(created_at) - min(created_at) AS span,
       count(*) AS rows
FROM operations
GROUP BY network
ORDER BY network;
