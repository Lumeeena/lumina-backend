DROP INDEX IF EXISTS idx_transactions_network_ledger_hash;
DROP INDEX IF EXISTS idx_transactions_network_successful_page;
DROP INDEX IF EXISTS idx_transactions_network_source_page;
DROP INDEX IF EXISTS idx_transactions_network_created_at;

DELETE FROM schema_migrations WHERE version = '010_transaction_filters';
