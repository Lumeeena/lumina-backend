DROP TABLE IF EXISTS account_refresh_queue CASCADE;

DELETE FROM schema_migrations WHERE version = '008_account_refresh_queue';
