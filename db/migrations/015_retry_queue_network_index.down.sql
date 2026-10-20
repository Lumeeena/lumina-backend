-- The deleted rows were for ledgers already indexed, so there is nothing to
-- restore: only the index is reverted.
CREATE INDEX IF NOT EXISTS idx_retry_queue_next_attempt ON ledger_retry_queue (next_attempt_at)
    WHERE NOT permanently_failed;

DROP INDEX IF EXISTS idx_retry_queue_network_next_attempt;

DELETE FROM schema_migrations WHERE version = '015_retry_queue_network_index';
