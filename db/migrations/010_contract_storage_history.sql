-- Migration 010: contract storage history table
-- Run with: psql $DATABASE_URL -f db/migrations/010_contract_storage_history.sql
--
-- ## Why
--
-- Supports querying "what did this contract's state look like at ledger N?"
-- The contract_storage_entries table holds only current values; this table
-- provides a time-series of changes for each key.
--
-- ## Retention
--
-- History is unbounded by default but can be pruned based on a retention
-- policy. The indexer configuration includes STORAGE_HISTORY_RETENTION_LEDGERS
-- to define how many ledgers of history to keep. Entries older than this are
-- candidates for deletion.
--
-- ## Design
--
-- Append-only: each write to a storage key creates a new history row. The
-- current value in contract_storage_entries + the history rows together form
-- the complete timeline.

\echo 'Running migration 010: contract storage history table...'

CREATE TABLE IF NOT EXISTS contract_storage_history (
    contract_id          TEXT NOT NULL,
    key                  TEXT NOT NULL,
    durability           TEXT NOT NULL,
    value                JSONB,
    value_xdr            TEXT,
    live_until_ledger    BIGINT,
    last_modified_ledger BIGINT NOT NULL,
    indexed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network              TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (contract_id, key, last_modified_ledger, network),
    CONSTRAINT contract_storage_history_durability_check CHECK (durability IN ('persistent', 'temporary')),
    CONSTRAINT contract_storage_history_ledger_check     CHECK (last_modified_ledger > 0)
);

-- Index for time-range queries: "show me all changes to this contract between ledger A and B"
CREATE INDEX IF NOT EXISTS idx_contract_storage_history_time_range
    ON contract_storage_history (contract_id, network, last_modified_ledger DESC);

-- Index for key-specific history: "show me the history of this specific storage key"
CREATE INDEX IF NOT EXISTS idx_contract_storage_history_key_lookup
    ON contract_storage_history (contract_id, key, network, last_modified_ledger DESC);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('010_contract_storage_history', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 010 complete.'
