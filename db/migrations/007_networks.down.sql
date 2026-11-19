-- Migration 007 Down: Invert network column and composite keys
-- Run with: psql $DATABASE_URL -f db/migrations/007_networks.down.sql
--
-- ## Rollback Considerations
--
-- As documented in docs/MIGRATION_ROLLBACK.md, migration 007 added multi-network
-- support by adding the `network` column and converting primary and foreign keys
-- across core tables into composite keys over (..., network).
--
-- Reverting this migration drops multi-network isolation and discards the network
-- discriminator. On databases with data from multiple networks sharing sequences,
-- hashes, or addresses, restoring single-column unique constraints will fail due
-- to duplicate keys. Revert is only safe on single-network datasets.

\echo 'Reverting migration 007: composite keys and network columns...'

-- ─── Revert composite keys (in reverse order of 007_networks.sql) ────────────

-- 1. custom_events
ALTER TABLE custom_events DROP CONSTRAINT IF EXISTS custom_events_pkey;
ALTER TABLE custom_events ADD PRIMARY KEY (event_id, event_name);

-- 2. contract_schemas
ALTER TABLE contract_schemas DROP CONSTRAINT IF EXISTS contract_schemas_pkey;
ALTER TABLE contract_schemas ADD PRIMARY KEY (contract_id);

-- 3. contract_events
ALTER TABLE contract_events DROP CONSTRAINT IF EXISTS contract_events_pkey;
ALTER TABLE contract_events ADD PRIMARY KEY (id);

-- 4. accounts
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_pkey;
ALTER TABLE accounts ADD PRIMARY KEY (address);

-- 5. operations (FK must be dropped before transactions PK change)
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_transaction_hash_network_fkey;
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_transaction_hash_fkey;
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_pkey;
ALTER TABLE operations ADD PRIMARY KEY (id);

-- 6. transactions (FK must be dropped before ledgers PK change)
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_ledger_network_fkey;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_ledger_fkey;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_pkey;
ALTER TABLE transactions ADD PRIMARY KEY (hash);
ALTER TABLE transactions
    ADD CONSTRAINT transactions_ledger_fkey
    FOREIGN KEY (ledger) REFERENCES ledgers (sequence);

-- Re-add operations foreign key pointing to transactions(hash)
ALTER TABLE operations
    ADD CONSTRAINT operations_transaction_hash_fkey
    FOREIGN KEY (transaction_hash) REFERENCES transactions (hash);

-- 7. ledgers
ALTER TABLE ledgers DROP CONSTRAINT IF EXISTS ledgers_pkey;
ALTER TABLE ledgers ADD PRIMARY KEY (sequence);

-- ─── Drop network columns (in reverse order) ─────────────────────────────────

ALTER TABLE custom_events    DROP COLUMN IF EXISTS network;
ALTER TABLE contract_schemas DROP COLUMN IF EXISTS network;
ALTER TABLE contract_events  DROP COLUMN IF EXISTS network;
ALTER TABLE accounts         DROP COLUMN IF EXISTS network;
ALTER TABLE operations       DROP COLUMN IF EXISTS network;
ALTER TABLE transactions     DROP COLUMN IF EXISTS network;
ALTER TABLE ledgers          DROP COLUMN IF EXISTS network;

DELETE FROM schema_migrations WHERE version = '007_networks';

\echo 'Migration 007 down complete.'
