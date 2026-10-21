DROP INDEX IF EXISTS idx_ledgers_network_sequence;

DELETE FROM schema_migrations WHERE version = '021_ledger_audit_window_index';