CREATE INDEX IF NOT EXISTS idx_transactions_network_ledger_hash
    ON transactions (network, ledger DESC, hash DESC);

DROP INDEX IF EXISTS idx_transactions_network_ledger_hash_covering;

ALTER TABLE transactions SET (
    autovacuum_vacuum_insert_threshold = 5000,
    autovacuum_vacuum_insert_scale_factor = 0.05
);

DELETE FROM schema_migrations WHERE version = '015_transactions_listing_covering_index';
