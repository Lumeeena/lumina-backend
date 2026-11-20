-- Rollback migration 015: Admin operations audit table

DROP INDEX IF EXISTS idx_admin_operations_network;
DROP TABLE IF EXISTS admin_operations;

DELETE FROM schema_migrations WHERE version = '015_admin_operations';
