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
