DROP TABLE IF EXISTS contract_storage_history CASCADE;

DELETE FROM schema_migrations WHERE version = '010_contract_storage_history';
