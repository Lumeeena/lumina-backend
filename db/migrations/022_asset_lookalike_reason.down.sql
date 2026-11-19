ALTER TABLE assets DROP COLUMN IF EXISTS lookalike_reason;
DELETE FROM schema_migrations WHERE version = '022_asset_lookalike_reason';
