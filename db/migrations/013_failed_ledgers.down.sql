-- Rollback migration 013: Record failed ledgers

DROP INDEX IF EXISTS idx_failed_ledgers_sequence;
DROP TABLE IF EXISTS failed_ledgers;

DELETE FROM schema_migrations WHERE version = '013_failed_ledgers';
