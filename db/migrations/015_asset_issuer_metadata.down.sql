DROP INDEX IF EXISTS idx_assets_lookalike;
DROP INDEX IF EXISTS idx_assets_issuer_home_domain;

ALTER TABLE assets
  DROP COLUMN IF EXISTS is_lookalike,
  DROP COLUMN IF EXISTS issuer_metadata,
  DROP COLUMN IF EXISTS issuer_home_domain;

DELETE FROM schema_migrations WHERE version = '015_asset_issuer_metadata';
