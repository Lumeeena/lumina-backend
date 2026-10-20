-- Preserve the Soroban RPC transaction hash on contract events. The hash is
-- nullable because RPC can return an event after the corresponding Horizon
-- transaction has aged out, or while the local transaction row is unavailable.
ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS transaction_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_events_transaction
  ON contract_events (transaction_hash, network);

INSERT INTO schema_migrations (version)
VALUES ('016_event_transaction_context')
ON CONFLICT (version) DO NOTHING;
