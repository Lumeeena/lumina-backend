DROP TABLE IF EXISTS asset_volume_buckets CASCADE;
DROP FUNCTION IF EXISTS bucket_hour(TIMESTAMPTZ);

DELETE FROM schema_migrations WHERE version = '012_asset_volume_buckets';
