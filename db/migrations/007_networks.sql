-- Migration 007: every row belongs to a network
-- Run with: psql $DATABASE_URL -f db/migrations/007_networks.sql
--
-- ## What changes
--
-- A `network` column is added to every indexed table, and the keys that
-- assumed one chain become composite over it. Ledger sequences, operation ids,
-- contract ids and even account addresses repeat across Stellar networks —
-- mainnet ledger 42 and testnet ledger 42 are different rows, and the same
-- G... account exists on both — so a single-column key would either reject
-- the second network outright or, with ON CONFLICT DO UPDATE, silently
-- overwrite one network's row with the other's. That is the data mixing the
-- multi-network work exists to prevent, so the key has to carry the network
-- too, not just the column the queries filter on.
--
-- Foreign keys follow their parents: `transactions(ledger)` only means
-- anything when it points at the ledger *of the same network*, so both sides
-- of the FK are (…, network).
--
-- ## Existing rows
--
-- The column defaults to `mainnet`, which is what the flat-variable fallback
-- names its single network — so an existing mainnet deployment keeps serving
-- the same rows with no configuration change. A deployment indexing another
-- chain under a different name relabels its rows once, as described in
-- docs/MULTI_NETWORK.md:
--
--   UPDATE ledgers SET network = 'testnet' WHERE network = 'mainnet';
--   … one statement per table below …
--
-- Dropping and re-adding a primary key drops and re-creates its index, which
-- briefly makes the table's unique index unavailable. On a populated
-- deployment that is a short exclusive lock — the same shape of operation as
-- any index build — and should be run while the indexer is stopped.

\echo 'Running migration 007: network column and composite keys...'

-- ─── The column ──────────────────────────────────────────────────────────────
-- Appended, so existing columns and their order are untouched.

ALTER TABLE ledgers          ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'mainnet';
ALTER TABLE transactions     ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'mainnet';
ALTER TABLE operations       ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'mainnet';
ALTER TABLE accounts         ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'mainnet';
ALTER TABLE contract_events  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'mainnet';
ALTER TABLE contract_schemas ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'mainnet';
ALTER TABLE custom_events    ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'mainnet';

-- ─── Composite keys ─────────────────────────────────────────────────────────
-- Dependent foreign keys are dropped before the key they hang off, then
-- re-created in terms of (…, network).

-- Pre-007 a single-column FK is named after its column; Postgres names the
-- composite replacement after both. Both names are dropped so the migration
-- lands on the same constraint name whether the table was built by 001 or by
-- this file — which is what keeps db/schema.sql and the migration chain at
-- parity (db/check-schema-parity.sh).
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_ledger_fkey;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_ledger_network_fkey;

ALTER TABLE ledgers DROP CONSTRAINT IF EXISTS ledgers_pkey;
ALTER TABLE ledgers ADD PRIMARY KEY (sequence, network);

ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_transaction_hash_fkey;
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_transaction_hash_network_fkey;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_pkey;
ALTER TABLE transactions ADD PRIMARY KEY (hash, network);
ALTER TABLE transactions
    ADD CONSTRAINT transactions_ledger_network_fkey
    FOREIGN KEY (ledger, network) REFERENCES ledgers (sequence, network);

ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_pkey;
ALTER TABLE operations ADD PRIMARY KEY (id, network);
ALTER TABLE operations
    ADD CONSTRAINT operations_transaction_hash_network_fkey
    FOREIGN KEY (transaction_hash, network) REFERENCES transactions (hash, network);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_pkey;
ALTER TABLE accounts ADD PRIMARY KEY (address, network);

ALTER TABLE contract_events DROP CONSTRAINT IF EXISTS contract_events_pkey;
ALTER TABLE contract_events ADD PRIMARY KEY (id, network);

ALTER TABLE contract_schemas DROP CONSTRAINT IF EXISTS contract_schemas_pkey;
ALTER TABLE contract_schemas ADD PRIMARY KEY (contract_id, network);

ALTER TABLE custom_events DROP CONSTRAINT IF EXISTS custom_events_pkey;
ALTER TABLE custom_events ADD PRIMARY KEY (event_id, event_name, network);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('007_networks', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 007 complete.'
