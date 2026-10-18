CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);

DELETE FROM schema_migrations WHERE version = '007_drop_redundant_api_key_index';
