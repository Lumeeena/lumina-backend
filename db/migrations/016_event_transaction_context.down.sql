-- Rolls back migration 016_event_transaction_context.
--
-- Data loss: dropping contract_events.transaction_hash discards every stored
-- hash. Re-applying the up migration recreates the column empty (NULL), and
-- the hashes are only refilled for events the indexer ingests again. Events
-- whose RPC data has aged out cannot have their hash recovered.

DROP INDEX IF EXISTS idx_events_transaction;

ALTER TABLE contract_events DROP COLUMN IF EXISTS transaction_hash;

DELETE FROM schema_migrations WHERE version = '016_event_transaction_context';
