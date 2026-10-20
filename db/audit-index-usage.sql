-- Run after a representative workload and preferably after a controlled
-- statistics reset/window. idx_scan is cumulative since the last reset.
SELECT schemaname, relname AS table_name, indexrelname AS index_name,
       idx_scan, idx_tup_read, idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
       pg_get_indexdef(indexrelid) AS definition
FROM pg_stat_user_indexes
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;

-- Candidate duplicate indexes (same table and indexed key expression).
-- Review included columns, predicates, uniqueness and workload before removal.
SELECT indrelid::regclass AS table_name, array_agg(indexrelid::regclass) AS indexes,
       array_agg(pg_get_indexdef(indexrelid)) AS definitions
FROM pg_index
GROUP BY indrelid, indkey, indexprs, indpred
HAVING count(*) > 1;

-- Transactions-specific review. Run after representative read and write
-- traffic; idx_scan is cumulative since stats_reset, not a rate.
SELECT d.stats_reset,
       s.indexrelname AS index_name,
       s.idx_scan,
       s.idx_tup_read,
       s.idx_tup_fetch,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
       i.indisunique AS is_unique,
       i.indisprimary AS is_primary,
       i.indisvalid AS is_valid,
       i.indisready AS is_ready,
       pg_get_indexdef(s.indexrelid) AS definition
FROM pg_stat_user_indexes s
JOIN pg_stat_database d ON d.datname = current_database()
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.relid = 'transactions'::regclass
ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC;

SELECT d.stats_reset,
       t.n_live_tup,
       t.n_dead_tup,
       t.n_tup_ins,
       t.n_tup_upd,
       t.n_tup_del,
       t.seq_scan,
       t.seq_tup_read,
       t.idx_scan,
       pg_size_pretty(pg_relation_size(t.relid)) AS heap_size,
       pg_size_pretty(pg_indexes_size(t.relid)) AS indexes_size,
       pg_size_pretty(pg_total_relation_size(t.relid)) AS total_size,
       t.last_autovacuum,
       t.last_autoanalyze
FROM pg_stat_user_tables t
JOIN pg_stat_database d ON d.datname = current_database()
WHERE t.relid = 'transactions'::regclass;
