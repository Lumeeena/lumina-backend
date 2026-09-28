-- Migration 009: contract storage entries table
-- Run with: psql $DATABASE_URL -f db/migrations/009_contract_storage_entries.sql
--
-- ## Why
--
-- Backs the `contractStorageEntries` GraphQL query (indexed Soroban contract
-- storage) and the archived-entry distinction. Soroban archives a persistent
-- entry once its TTL expires — it becomes inaccessible, not deleted — so an
-- archived entry keeps its row with `state = 'archived'` rather than being
-- removed. That is what lets a client tell "archived" (a row) apart from
-- "absent" (no row at all).
--
-- `key` is the base64 XDR LedgerKey the entry was fetched with, so it
-- round-trips back into a getLedgerEntries call and is what the `keyPrefix`
-- filter matches against. `value` is the decoded native value (JSONB);
-- `value_xdr` is the raw LedgerEntryData XDR.
--
-- ## Idempotency
--
-- Migration 001 builds from db/schema.sql, which already creates this table,
-- so on a freshly built database each statement below is skipped.

\echo 'Running migration 009: contract storage entries table...'

CREATE TABLE IF NOT EXISTS contract_storage_entries (
    contract_id          TEXT NOT NULL,
    key                  TEXT NOT NULL,
    durability           TEXT NOT NULL,
    state                TEXT NOT NULL DEFAULT 'active',
    value                JSONB,
    value_xdr            TEXT,
    live_until_ledger    BIGINT,
    last_modified_ledger BIGINT NOT NULL,
    indexed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network              TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (contract_id, key, network),
    CONSTRAINT contract_storage_entries_durability_check CHECK (durability IN ('persistent', 'temporary')),
    CONSTRAINT contract_storage_entries_state_check      CHECK (state IN ('active', 'archived')),
    CONSTRAINT contract_storage_entries_ledger_check     CHECK (last_modified_ledger > 0)
);

CREATE INDEX IF NOT EXISTS idx_contract_storage_entries_lookup
    ON contract_storage_entries (contract_id, network, last_modified_ledger DESC, key DESC);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('009_contract_storage_entries', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 009 complete.'
