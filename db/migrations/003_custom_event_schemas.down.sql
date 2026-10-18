DROP TABLE IF EXISTS custom_events CASCADE;
DROP TABLE IF EXISTS contract_schemas CASCADE;

DELETE FROM schema_migrations WHERE version = '003_custom_event_schemas';
