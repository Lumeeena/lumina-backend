-- Migration 007: drop an index that duplicates a UNIQUE constraint (issue #109)
--
-- api_keys.key_hash is declared `TEXT NOT NULL UNIQUE`, so PostgreSQL already
-- maintains a unique btree on (key_hash) (api_keys_key_hash_key). Migration 005
-- added idx_api_keys_key_hash on the same column, which the planner can never
-- prefer over the unique index and which costs a second index write on every
-- key insert/update. This is provable from the schema alone; it needs no
-- usage statistics. The constraint's own index is untouched.
--
-- Other indexes are deliberately NOT dropped here: that requires
-- pg_stat_user_indexes data from a real deployment (see docs/DATABASE_OPERATIONS.md).

DROP INDEX IF EXISTS idx_api_keys_key_hash;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('007_drop_redundant_api_key_index', NOW())
ON CONFLICT (version) DO NOTHING;
