DROP INDEX IF EXISTS idx_custom_events_created_at;

DELETE FROM schema_migrations WHERE version = '010_retention_prune_indexes';
