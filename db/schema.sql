-- Lumina PostgreSQL Schema
-- Run this to initialize the database: psql $DATABASE_URL -f db/schema.sql

-- ─── Migrations bookkeeping ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
    version             TEXT PRIMARY KEY,
    applied_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Ledgers ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ledgers (
    sequence            BIGINT PRIMARY KEY,
    closed_at           TIMESTAMPTZ NOT NULL,
    transaction_count   INTEGER NOT NULL DEFAULT 0,
    operation_count     INTEGER NOT NULL DEFAULT 0,
    base_fee            BIGINT NOT NULL DEFAULT 100,
    base_reserve        BIGINT NOT NULL DEFAULT 5000000,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledgers_closed_at ON ledgers (closed_at DESC);

-- ─── Transactions ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transactions (
    hash                TEXT PRIMARY KEY,
    ledger              BIGINT NOT NULL REFERENCES ledgers(sequence),
    created_at          TIMESTAMPTZ NOT NULL,
    source_account      TEXT NOT NULL,
    fee_charged         BIGINT NOT NULL,
    operation_count     SMALLINT NOT NULL,
    successful          BOOLEAN NOT NULL,
    memo_type           TEXT,
    memo                TEXT,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transactions_ledger     ON transactions (ledger DESC);
CREATE INDEX idx_transactions_source     ON transactions (source_account);
CREATE INDEX idx_transactions_created_at ON transactions (created_at DESC);

-- ─── Operations ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS operations (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL,
    transaction_hash    TEXT NOT NULL REFERENCES transactions(hash),
    ledger              BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    source_account      TEXT NOT NULL,
    -- JSONB column holds type-specific fields (from, to, amount, asset, etc.)
    details             JSONB NOT NULL DEFAULT '{}',
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_operations_transaction   ON operations (transaction_hash);
CREATE INDEX idx_operations_source        ON operations (source_account);
CREATE INDEX idx_operations_type          ON operations (type);
CREATE INDEX idx_operations_created_at    ON operations (created_at DESC);
-- GIN index for JSONB queries (e.g. filter by "to" address in payment details)
CREATE INDEX idx_operations_details       ON operations USING GIN (details);

-- ─── Accounts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounts (
    address             TEXT PRIMARY KEY,
    sequence            TEXT NOT NULL,
    subentry_count      INTEGER NOT NULL DEFAULT 0,
    last_modified_ledger BIGINT NOT NULL,
    num_sponsored       INTEGER NOT NULL DEFAULT 0,
    num_sponsoring      INTEGER NOT NULL DEFAULT 0,
    balances            JSONB NOT NULL DEFAULT '[]',
    flags               JSONB NOT NULL DEFAULT '{}',
    thresholds          JSONB NOT NULL DEFAULT '{}',
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Contract Events (Soroban) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contract_events (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL DEFAULT 'contract',
    contract_id         TEXT NOT NULL,
    ledger              BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    paging_token        TEXT NOT NULL,
    topics              TEXT[] NOT NULL DEFAULT '{}',
    value               JSONB,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_contract_id  ON contract_events (contract_id);
CREATE INDEX idx_events_ledger       ON contract_events (ledger DESC);
CREATE INDEX idx_events_created_at   ON contract_events (created_at DESC);
CREATE INDEX idx_events_topics       ON contract_events USING GIN (topics);

-- ─── Custom per-contract event schemas ───────────────────────────────────
-- One row per contract that has registered a schema. The definition is stored
-- as JSONB rather than shredded into tables because it is read whole, once per
-- indexer start, and never queried by its parts.
CREATE TABLE IF NOT EXISTS contract_schemas (
    contract_id     TEXT PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 1,
    definition      JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Decoded events live in one shared table keyed by JSONB payload, rather than a
-- generated table per contract/event.
--
-- The alternative — CREATE TABLE custom_<contract>_<event> with real columns —
-- buys native column types and loses more than it gains: DDL on the indexing
-- hot path, table sprawl that grows with registrations, an ALTER TABLE
-- migration story every time a project revises a schema, and identifiers
-- derived from third-party input reaching SQL as identifiers rather than as
-- bind parameters.
--
-- Here a schema revision is a metadata update, one project's schema cannot
-- collide with another's table, and field names never leave the JSONB layer.
-- The cost is that ordered comparison needs a cast, which the query layer does
-- using the type the schema declares.
CREATE TABLE IF NOT EXISTS custom_events (
    event_id        TEXT NOT NULL,
    contract_id     TEXT NOT NULL,
    event_name      TEXT NOT NULL,
    ledger          BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    schema_version  INTEGER NOT NULL,
    fields          JSONB NOT NULL DEFAULT '{}',
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, event_name)
);
CREATE INDEX IF NOT EXISTS idx_custom_events_contract_event
    ON custom_events (contract_id, event_name, ledger DESC);
CREATE INDEX IF NOT EXISTS idx_custom_events_ledger
    ON custom_events (ledger DESC);
-- Containment queries on exact-match filters go through the payload directly.
CREATE INDEX IF NOT EXISTS idx_custom_events_fields
    ON custom_events USING GIN (fields);

-- ─── Search and asset-filter indexes ──────────────────────────────────────
--
-- Trigram rather than tsvector for memos: Stellar memos are order references
-- and short codes rather than prose, and stemming an identifier is actively
-- wrong. One GIN trigram index serves both similarity ranking and ILIKE.
--
-- The index definitions here omit CONCURRENTLY, which migration 004 uses —
-- this file builds an empty database where the lock does not matter, and
-- CONCURRENTLY cannot run inside the transaction psql wraps a script in.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_transactions_memo_trgm
    ON transactions USING GIN (memo gin_trgm_ops)
    WHERE memo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_asset_code
    ON operations ((details->>'asset_code'))
    WHERE details->>'asset_code' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_asset_issuer
    ON operations ((details->>'asset_issuer'))
    WHERE details->>'asset_issuer' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_asset_type
    ON operations ((details->>'asset_type'))
    WHERE details->>'asset_type' IS NOT NULL;

-- ─── API Keys ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
    id                  SERIAL PRIMARY KEY,
    key_hash            TEXT NOT NULL UNIQUE,
    key_prefix          TEXT NOT NULL,
    label               TEXT NOT NULL,
    rate_limit          INTEGER NOT NULL DEFAULT 60, -- requests per minute
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at          TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at ON api_keys (revoked_at);
