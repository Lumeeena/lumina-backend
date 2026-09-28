-- Migration 010: index custom_events by chain time, for retention pruning
-- Run with: psql $DATABASE_URL -f db/migrations/010_retention_prune_indexes.sql
--
-- ## Why
--
-- The retention prune (indexer/src/retention.ts) deletes a bounded batch of
-- rows older than a cutoff:
--
--   DELETE FROM custom_events WHERE ctid IN (
--     SELECT ctid FROM custom_events WHERE created_at < $1 LIMIT $2
--   )
--
-- Every other prunable table already has an index on its chain-time column
-- (idx_transactions_created_at, idx_operations_created_at,
-- idx_events_created_at, idx_ledgers_closed_at). `custom_events` was the only
-- one without one, so its prune would have been a sequential scan on a table
-- that grows by one row per decoded event, forever. That is the difference
-- between pruning being a cheap index lookup and pruning being the most
-- expensive thing the indexer does.
--
-- The index is DESC because that is the order both the prune and the
-- "newest first" reads want, so it serves both.
--
-- ## Idempotency
--
-- db/schema.sql carries this index, so on a freshly built database the
-- IF NOT EXISTS guard skips it. Same convention as 008_data_constraints.

\echo 'Running migration 010: custom_events chain-time index for retention pruning...'

CREATE INDEX IF NOT EXISTS idx_custom_events_created_at
    ON custom_events (created_at DESC);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('010_retention_prune_indexes', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 010 complete.'
