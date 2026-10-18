ALTER TABLE api_keys DROP COLUMN IF EXISTS export_enabled;

DELETE FROM schema_migrations WHERE version = '006_export_permissions';
