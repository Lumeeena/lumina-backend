-- Migration 015: ledger_retry_queue index review
-- Run with: psql $DATABASE_URL -f db/migrations/015_retry_queue_network_index.sql
--
-- Measurements behind every statement here are in
-- docs/LEDGER_RETRY_QUEUE_REVIEW.md.
--
-- ## Why replace idx_retry_queue_next_attempt
--
-- The retry worker's only read is, per network:
--
--   SELECT ledger FROM ledger_retry_queue
--   WHERE network = $1 AND NOT permanently_failed AND next_attempt_at <= NOW()
--   ORDER BY next_attempt_at ASC LIMIT $2
--
-- idx_retry_queue_next_attempt does not carry `network`, so in a
-- multi-network deployment one network's backlog is in the way of every other
-- network's poll. With 50k due mainnet rows a testnet poll that had nothing to
-- do fell back to the primary key and read 578 buffers; with `network` leading
-- it reads 2. Same predicate, same one index entry per write, so the swap
-- costs nothing on the write path.
--
-- ## Why delete rows for ledgers that are already indexed
--
-- Until indexLedger started clearing the queue (clearLedgerFailures), a row
-- outlived its ledger whenever the forward loop, backfill or gap repair
-- indexed it before the retry worker did, which is the usual case. Rows that
-- had reached permanently_failed were never deleted by anything. This removes
-- the ones that piled up before the fix; nothing creates new ones.
--
-- ## Note on migration time
--
-- Not CONCURRENTLY: the table is a work queue measured in rows, not millions,
-- and a plain build inside the runner's transaction is atomic with the drop.

\echo 'Running migration 015: ledger_retry_queue network index...'

DELETE FROM ledger_retry_queue q
USING ledgers l
WHERE l.sequence = q.ledger AND l.network = q.network;

CREATE INDEX IF NOT EXISTS idx_retry_queue_network_next_attempt
    ON ledger_retry_queue (network, next_attempt_at)
    WHERE NOT permanently_failed;

DROP INDEX IF EXISTS idx_retry_queue_next_attempt;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('015_retry_queue_network_index', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 015 complete.'
