DROP TABLE IF EXISTS processed_operation_handlers;
DELETE FROM schema_migrations WHERE version = '024_operation_effect_idempotency';
