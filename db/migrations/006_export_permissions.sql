-- Migration 006: explicit permission for bulk data exports
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS export_enabled BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('006_export_permissions', NOW())
ON CONFLICT (version) DO NOTHING;
