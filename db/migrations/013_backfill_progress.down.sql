-- Migration 013 Down: Backfill progress tracking
-- Run with: psql $DATABASE_URL -f db/migrations/013_backfill_progress.down.sql

\echo 'Reverting migration 013: backfill_progress...'

DROP INDEX IF EXISTS idx_backfill_progress_network;
DROP TABLE IF EXISTS backfill_progress CASCADE;

DELETE FROM schema_migrations WHERE version = '013_backfill_progress';

\echo 'Migration 013 (backfill_progress) down complete.'
