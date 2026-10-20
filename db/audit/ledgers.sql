-- Ledgers index and growth audit. Read-only; safe to run on a deployment:
--
--   psql "$DATABASE_URL" -f db/audit/ledgers.sql
--
-- idx_scan and the n_tup_* counters are cumulative since the last statistics
-- reset (pg_stat_reset() or a crash), so record stats_reset with the output and
-- run it after a representative stretch of indexing *and* API traffic. See
-- docs/LEDGERS_INDEX_REVIEW.md for how the numbers are read.
--
-- Two readings are easy to get wrong:
--
--   * idx_ledgers_closed_at having zero scans is expected when retention is
--     off (the default). It serves the retention prune, not an API query.
--   * ledgers is insert-only, so n_tup_upd should be zero. A non-zero value
--     means something is rewriting ledger rows, which the index review did not
--     measure.

-- name: statistics window
SELECT current_database() AS database,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset,
       pg_size_pretty(pg_database_size(current_database())) AS database_size;

-- name: index usage
SELECT s.indexrelname AS index_name,
       s.idx_scan,
       s.idx_tup_read,
       s.idx_tup_fetch,
       pg_relation_size(s.indexrelid) AS bytes,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       pg_get_indexdef(s.indexrelid) AS definition
FROM pg_stat_user_indexes s
WHERE s.relname = 'ledgers'
ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC;

-- name: table activity
-- ledgers is append-only: inserts happen once per closed ledger, and the only
-- deletes are the retention prune. A sequential scan is not automatically a
-- problem here — an exact COUNT(*) and the old MAX(indexed_at) tip query both
-- used one — but it is the number to read next to the index scans.
SELECT seq_scan, seq_tup_read, idx_scan,
       n_tup_ins, n_tup_upd, n_tup_hot_upd, n_tup_del,
       n_live_tup, n_dead_tup,
       pg_relation_size(relid) AS heap_bytes,
       pg_indexes_size(relid) AS index_bytes,
       pg_total_relation_size(relid) AS total_bytes
FROM pg_stat_user_tables
WHERE relname = 'ledgers';

-- name: index columns
-- The primary key is (sequence, network); idx_ledgers_closed_at is the only
-- secondary index. Any additional index on this table should name the query
-- that reads it before it is added.
SELECT i.indexrelid::regclass AS index_name,
       i.indisprimary AS is_pk,
       i.indisunique AS is_unique,
       array_agg(a.attname ORDER BY k.ord) AS columns,
       pg_get_expr(i.indpred, i.indrelid) AS predicate
FROM pg_index i
CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
WHERE i.indrelid = 'ledgers'::regclass
GROUP BY i.indexrelid, i.indisprimary, i.indisunique, i.indpred, i.indrelid
ORDER BY i.indisprimary DESC, 1;

-- name: growth by network
-- The chain closes a ledger about every five seconds, so the expected rate is
-- 17,280 rows per network per day. chain_days is measured from closed_at, not
-- from when the indexer wrote the rows, and rows_per_day is the observed rate
-- over that span. A much lower rate means the index does not cover that whole
-- span (or retention has already removed old rows).
WITH per_network AS (
    SELECT network,
           count(*) AS rows,
           min(sequence) AS first_sequence,
           max(sequence) AS latest_sequence,
           min(closed_at) AS oldest_closed_at,
           max(closed_at) AS latest_closed_at,
           max(closed_at) - min(closed_at) AS chain_span
    FROM ledgers
    GROUP BY network
)
SELECT network,
       rows,
       first_sequence,
       latest_sequence,
       oldest_closed_at,
       latest_closed_at,
       round(EXTRACT(EPOCH FROM chain_span) / 86400, 2) AS chain_days,
       round(rows / NULLIF(EXTRACT(EPOCH FROM chain_span) / 86400, 0), 1) AS rows_per_day,
       round(rows / NULLIF(EXTRACT(EPOCH FROM chain_span) / 86400, 0) * 365) AS rows_per_year
FROM per_network
ORDER BY network;

-- name: bytes per row
-- The heap and index bytes are measured, not estimated. Multiply total_bytes_per_row
-- by the rows_per_year above to get the annual footprint of one network before
-- vacuum or page-rounding overhead. ledgers has no TOAST table.
SELECT count(*) AS rows,
       round(pg_relation_size('ledgers') / NULLIF(count(*), 0)::numeric) AS heap_bytes_per_row,
       round(pg_indexes_size('ledgers') / NULLIF(count(*), 0)::numeric) AS index_bytes_per_row,
       round(pg_total_relation_size('ledgers') / NULLIF(count(*), 0)::numeric) AS total_bytes_per_row
FROM ledgers;

-- name: retention candidates
-- Counts rows that each window would have expired, relative to the newest
-- closed_at in that network rather than wall-clock now. This is the size of the
-- first backlog a newly enabled retention policy has to work through. A window
-- longer than the indexed span shows zero, which is correct: the prune only
-- starts deleting once the index outlives it.
WITH bounds AS (
    SELECT network, max(closed_at) AS tip FROM ledgers GROUP BY network
)
SELECT l.network,
       b.tip,
       count(*) FILTER (WHERE l.closed_at < b.tip - interval '30 days') AS older_30d,
       count(*) FILTER (WHERE l.closed_at < b.tip - interval '90 days') AS older_90d,
       count(*) FILTER (WHERE l.closed_at < b.tip - interval '365 days') AS older_365d,
       count(*) AS rows
FROM ledgers l
JOIN bounds b USING (network)
GROUP BY l.network, b.tip
ORDER BY l.network;
