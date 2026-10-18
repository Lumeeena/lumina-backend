DROP INDEX IF EXISTS idx_accounts_last_modified;

DELETE FROM schema_migrations WHERE version = '008_accounts_listing_index';
