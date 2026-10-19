-- ledger_retry_queue audit: index usage, scan types, and growth.
--
--   psql "$DATABASE_URL" -f db/audit-ledger-retry-queue.sql
--
-- Read-only. Paste the output into docs/LEDGER_RETRY_QUEUE_REVIEW.md
-- ("Production measurements") with the deployment, date and stats window.
--
-- idx_scan and seq_scan are cumulative since the last statistics reset, so the
-- first query reports when that was: a counter of zero over an hour means
-- nothing, over a month it means the index is dead weight.
--
-- Read the counters with the retry worker in mind. It polls every 30 seconds
-- per network whether or not anything failed, but while the queue holds a
-- handful of rows the planner answers that poll with a sequential scan, so a
-- healthy deployment shows ~2,880 seq_scan a day per network and close to zero
-- idx_scan on idx_retry_queue_network_next_attempt. That is not a reason to
-- drop it: the index is what keeps the poll at a few buffers once a backlog
-- builds (docs/LEDGER_RETRY_QUEUE_REVIEW.md). A primary key with zero scans on
-- a deployment that has had failures usually means the indexer could not write
-- to the table at all (check db/verify_roles.sql), not that it is unused.

\set ON_ERROR_STOP on
\pset pager off

\echo '== Statistics window =='
SELECT stats_reset, now() - stats_reset AS window
FROM pg_stat_database WHERE datname = current_database();

\echo '== Index usage =='
SELECT indexrelname AS index_name, idx_scan, idx_tup_read, idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
       pg_get_indexdef(indexrelid) AS definition
FROM pg_stat_user_indexes
WHERE relname = 'ledger_retry_queue'
ORDER BY idx_scan;

\echo '== Table scans, write mix, dead tuples =='
-- seq_scan is expected and harmless while the table holds a handful of rows;
-- it matters only alongside a large n_live_tup.
SELECT seq_scan, seq_tup_read, idx_scan,
       n_tup_ins, n_tup_upd, n_tup_hot_upd, n_tup_del,
       n_live_tup, n_dead_tup, last_autovacuum, autovacuum_count,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE relname = 'ledger_retry_queue';

\echo '== Rows by network and state =='
SELECT network, permanently_failed, count(*) AS rows,
       max(attempt_count) AS max_attempts,
       min(first_failed_at) AS oldest_failure,
       max(last_attempted_at) AS latest_attempt
FROM ledger_retry_queue
GROUP BY network, permanently_failed
ORDER BY network, permanently_failed;

\echo '== Rows whose ledger is already indexed (should be 0 after migration 015) =='
SELECT q.network, q.permanently_failed, count(*) AS stale_rows
FROM ledger_retry_queue q
JOIN ledgers l ON l.sequence = q.ledger AND l.network = q.network
GROUP BY q.network, q.permanently_failed;

\echo '== Growth: rows by month of first failure =='
SELECT date_trunc('month', first_failed_at) AS month, network, count(*) AS rows
FROM ledger_retry_queue
GROUP BY 1, 2
ORDER BY 1, 2;

\echo '== Retry-worker poll plan, per network =='
-- EXPLAIN without ANALYZE: plans only, nothing runs. The statement is the
-- one in getPendingRetries (indexer/src/db.ts). Networks come from the queue
-- itself, not from ledgers, so the audit never scans a large table.
SELECT format(
  'EXPLAIN (COSTS OFF) SELECT ledger FROM ledger_retry_queue WHERE network = %L AND NOT permanently_failed AND next_attempt_at <= NOW() ORDER BY next_attempt_at ASC LIMIT 10',
  network)
FROM (SELECT DISTINCT network FROM ledger_retry_queue) n \gexec
