DROP INDEX IF EXISTS idx_transactions_memo_trgm;
DROP INDEX IF EXISTS idx_operations_asset_code;
DROP INDEX IF EXISTS idx_operations_asset_issuer;
DROP INDEX IF EXISTS idx_operations_asset_type;

DELETE FROM schema_migrations WHERE version = '004_search_indexes';
