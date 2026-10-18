DROP TABLE IF EXISTS ledger_retry_queue CASCADE;

DELETE FROM schema_migrations WHERE version = '008_retry_queue';
