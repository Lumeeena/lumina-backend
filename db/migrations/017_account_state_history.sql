-- Migration 017: account_state_history
-- Run with: psql $DATABASE_URL -f db/migrations/017_account_state_history.sql
--
-- Stores a copy of an account each time the indexer writes it, so
-- `account(address:, asOfLedger:)` can answer for a past ledger. Decision,
-- resolution and retention are in docs/ACCOUNT_STATE_HISTORY.md.
--
-- Additive: nothing reads or writes this table until the indexer and GraphQL
-- server that know about it are deployed. Existing accounts have no history
-- until their next refresh, so queries before deployment return null.

CREATE TABLE IF NOT EXISTS account_state_history (
    address              TEXT NOT NULL,
    network              TEXT NOT NULL DEFAULT 'mainnet',
    last_modified_ledger BIGINT NOT NULL,
    sequence             TEXT NOT NULL,
    subentry_count       INTEGER NOT NULL DEFAULT 0,
    num_sponsored        INTEGER NOT NULL DEFAULT 0,
    num_sponsoring       INTEGER NOT NULL DEFAULT 0,
    balances             JSONB NOT NULL DEFAULT '[]',
    flags                JSONB NOT NULL DEFAULT '{}',
    thresholds           JSONB NOT NULL DEFAULT '{}',
    -- Wall-clock time the copy was stored. Retention prunes on this column.
    recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (address, network, last_modified_ledger),
    CONSTRAINT account_state_history_address_check         CHECK (address <> ''),
    CONSTRAINT account_state_history_sequence_check        CHECK (sequence <> ''),
    CONSTRAINT account_state_history_last_modified_check   CHECK (last_modified_ledger > 0),
    CONSTRAINT account_state_history_subentry_count_check  CHECK (subentry_count >= 0),
    CONSTRAINT account_state_history_num_sponsored_check   CHECK (num_sponsored >= 0),
    CONSTRAINT account_state_history_num_sponsoring_check  CHECK (num_sponsoring >= 0)
);

-- Pruning deletes by age across every network, so it needs an index on the
-- time column alone. The lookup by (address, network, ledger) is served by the
-- primary key.
CREATE INDEX IF NOT EXISTS idx_account_state_history_recorded_at
    ON account_state_history (recorded_at);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('017_account_state_history', NOW())
ON CONFLICT (version) DO NOTHING;

\echo 'Migration 017 complete.'
