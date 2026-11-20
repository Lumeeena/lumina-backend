-- These rows were written by the old indexer as if they were parsed interfaces.
-- They are known placeholders, not recoverable contract metadata.
DELETE FROM contract_interfaces
WHERE functions = '[{"name":"placeholder","inputs":[],"outputs":[]}]'::jsonb;

INSERT INTO schema_migrations (version)
VALUES ('023_remove_placeholder_contract_interfaces')
ON CONFLICT (version) DO NOTHING;
