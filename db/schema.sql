-- Lumina PostgreSQL Schema
-- Run this to initialize the database: psql $DATABASE_URL -f db/schema.sql

-- ─── Migrations bookkeeping ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
    version             TEXT PRIMARY KEY,
    applied_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Ledgers ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ledgers (
    sequence            BIGINT NOT NULL,
    closed_at           TIMESTAMPTZ NOT NULL,
    transaction_count   INTEGER NOT NULL DEFAULT 0,
    operation_count     INTEGER NOT NULL DEFAULT 0,
    base_fee            BIGINT NOT NULL DEFAULT 100,
    base_reserve        BIGINT NOT NULL DEFAULT 5000000,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (sequence, network),
    -- Data-quality guards for values the indexer and query layer assume are
    -- well-formed. See db/migrations/008_data_constraints.sql.
    CONSTRAINT ledgers_sequence_check          CHECK (sequence > 0),
    CONSTRAINT ledgers_transaction_count_check CHECK (transaction_count >= 0),
    CONSTRAINT ledgers_operation_count_check   CHECK (operation_count >= 0)
);

CREATE INDEX idx_ledgers_closed_at ON ledgers (closed_at DESC);

-- ─── Transactions ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transactions (
    hash                TEXT NOT NULL,
    ledger              BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    source_account      TEXT NOT NULL,
    fee_charged         BIGINT NOT NULL,
    operation_count     SMALLINT NOT NULL,
    successful          BOOLEAN NOT NULL,
    memo_type           TEXT,
    memo                TEXT,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (hash, network),
    FOREIGN KEY (ledger, network) REFERENCES ledgers (sequence, network),
    CONSTRAINT transactions_hash_check              CHECK (hash <> ''),
    CONSTRAINT transactions_ledger_check            CHECK (ledger > 0),
    CONSTRAINT transactions_source_account_check    CHECK (source_account <> ''),
    CONSTRAINT transactions_operation_count_check   CHECK (operation_count >= 0)
);

CREATE INDEX idx_transactions_ledger     ON transactions (ledger DESC);
CREATE INDEX idx_transactions_source     ON transactions (source_account);
CREATE INDEX idx_transactions_created_at ON transactions (created_at DESC);

-- ─── Operations ───────────────────────────────────────────────────────────────
--
-- A plain table, not partitioned. It was range-partitioned by ledger for a
-- while (see db/migrations/006_partition_operations.sql), but a partitioned
-- table's primary key must include the partition key, and the multi-network
-- key (id, network) cannot also carry `ledger` — so the partitioning was
-- reverted and the primary key is (id, network).
--
-- A deployment that ran the *original* 006_partition_operations still has a
-- partitioned table keyed (id, ledger, network). indexer/src/db.ts inserts
-- without an ON CONFLICT inference clause precisely so one insert statement
-- works against both shapes.

CREATE TABLE IF NOT EXISTS operations (
    id                  TEXT NOT NULL,
    type                TEXT NOT NULL,
    transaction_hash    TEXT NOT NULL,
    ledger              BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    source_account      TEXT NOT NULL,
    -- JSONB column holds type-specific fields (from, to, amount, asset, etc.)
    details             JSONB NOT NULL DEFAULT '{}',
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (id, network),
    FOREIGN KEY (transaction_hash, network) REFERENCES transactions (hash, network),
    CONSTRAINT operations_id_check                CHECK (id <> ''),
    CONSTRAINT operations_type_check              CHECK (type <> ''),
    CONSTRAINT operations_transaction_hash_check  CHECK (transaction_hash <> ''),
    CONSTRAINT operations_ledger_check            CHECK (ledger > 0),
    CONSTRAINT operations_source_account_check    CHECK (source_account <> '')
);

CREATE INDEX idx_operations_transaction   ON operations (transaction_hash);
CREATE INDEX idx_operations_source        ON operations (source_account);
CREATE INDEX idx_operations_type          ON operations (type);
CREATE INDEX idx_operations_created_at    ON operations (created_at DESC);
-- GIN index for JSONB queries (e.g. filter by "to" address in payment details)
CREATE INDEX idx_operations_details       ON operations USING GIN (details);

-- Defined for parity with db/migrations/006_partition_operations.sql, which
-- also creates it — the parity check diffs the two dumps, so the definition has
-- to appear in both. `operations` is not partitioned (see the note above), so
-- the function is never invoked: creating a partition of a plain table is an
-- error, and the initial-partition call that used to run here would fail. The
-- indexer's ensurePartitions wrapper (indexer/src/db.ts) is unused for the same
-- reason.
CREATE OR REPLACE FUNCTION ensure_operations_partitions(partitions_ahead INTEGER DEFAULT 3)
RETURNS void AS $$
DECLARE
  partition_size CONSTANT BIGINT := 2000000;
  v_max_ledger BIGINT;
  v_upper BIGINT;
  v_target BIGINT;
  v_from BIGINT;
  v_to BIGINT;
  v_name TEXT;
BEGIN
  SELECT COALESCE(MAX(ledger), 0) INTO v_max_ledger FROM operations;

  SELECT MAX((regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''?(-?\d+)''?\)'))[1]::bigint)
    INTO v_upper
  FROM pg_inherits pi JOIN pg_class c ON c.oid = pi.inhrelid
  WHERE pi.inhparent = 'operations'::regclass;

  v_from := COALESCE(v_upper, 0);
  v_target := v_max_ledger + partitions_ahead * partition_size;

  WHILE v_from < v_target LOOP
    v_to := v_from + partition_size;
    v_name := format('operations_p%s', v_from);

    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF operations FOR VALUES FROM (%L) TO (%L)',
        v_name, v_from, v_to
      );
      RAISE NOTICE 'created partition % for ledger range [%, %)', v_name, v_from, v_to;
    END IF;

    v_from := v_to;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ─── Accounts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounts (
    address             TEXT NOT NULL,
    sequence            TEXT NOT NULL,
    subentry_count      INTEGER NOT NULL DEFAULT 0,
    last_modified_ledger BIGINT NOT NULL,
    num_sponsored       INTEGER NOT NULL DEFAULT 0,
    num_sponsoring      INTEGER NOT NULL DEFAULT 0,
    balances            JSONB NOT NULL DEFAULT '[]',
    flags               JSONB NOT NULL DEFAULT '{}',
    thresholds          JSONB NOT NULL DEFAULT '{}',
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (address, network),
    CONSTRAINT accounts_address_check         CHECK (address <> ''),
    CONSTRAINT accounts_sequence_check        CHECK (sequence <> ''),
    CONSTRAINT accounts_subentry_count_check  CHECK (subentry_count >= 0),
    CONSTRAINT accounts_last_modified_ledger_check CHECK (last_modified_ledger > 0),
    CONSTRAINT accounts_num_sponsored_check   CHECK (num_sponsored >= 0),
    CONSTRAINT accounts_num_sponsoring_check  CHECK (num_sponsoring >= 0)
);

-- Durable outbox for account state lookups. It is written with each ledger so
-- committed ledger data always has recoverable account refresh work.
CREATE TABLE IF NOT EXISTS account_refresh_queue (
    network                 TEXT NOT NULL,
    address                 TEXT NOT NULL,
    last_requested_ledger   BIGINT NOT NULL,
    queued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (network, address)
);
CREATE INDEX idx_account_refresh_queue_pending
    ON account_refresh_queue (network, queued_at);

-- Serves the `accounts` listing ordered by recent activity. `network` leads
-- because every query filters on it, and `address` is in the key rather than
-- left out because several accounts are typically modified in the same ledger —
-- without a deterministic tiebreaker a keyset walk repeats the same page.
CREATE INDEX idx_accounts_last_modified ON accounts (network, last_modified_ledger DESC, address);

-- ─── Contract Events (Soroban) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contract_events (
    id                  TEXT NOT NULL,
    type                TEXT NOT NULL DEFAULT 'contract',
    contract_id         TEXT NOT NULL,
    ledger              BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    paging_token        TEXT NOT NULL,
    topics              TEXT[] NOT NULL DEFAULT '{}',
    value               JSONB,
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (id, network),
    CONSTRAINT contract_events_id_check          CHECK (id <> ''),
    CONSTRAINT contract_events_contract_id_check  CHECK (contract_id <> ''),
    CONSTRAINT contract_events_ledger_check       CHECK (ledger > 0),
    CONSTRAINT contract_events_paging_token_check CHECK (paging_token <> '')
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
    contract_id     TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    definition      JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network         TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (contract_id, network)
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
    network         TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (event_id, event_name, network),
    CONSTRAINT custom_events_event_id_check      CHECK (event_id <> ''),
    CONSTRAINT custom_events_contract_id_check   CHECK (contract_id <> ''),
    CONSTRAINT custom_events_event_name_check    CHECK (event_name <> ''),
    CONSTRAINT custom_events_ledger_check        CHECK (ledger > 0)
);
CREATE INDEX IF NOT EXISTS idx_custom_events_contract_event
    ON custom_events (contract_id, event_name, ledger DESC);
CREATE INDEX IF NOT EXISTS idx_custom_events_ledger
    ON custom_events (ledger DESC);
-- Chain-time index, serving the retention prune (db/migrations/010_retention_prune_indexes.sql).
-- Every other prunable table has one; without it this prune is a sequential scan.
CREATE INDEX IF NOT EXISTS idx_custom_events_created_at
    ON custom_events (created_at DESC);
-- Containment queries on exact-match filters go through the payload directly.
CREATE INDEX IF NOT EXISTS idx_custom_events_fields
    ON custom_events USING GIN (fields);

-- ─── Contract storage entries (Soroban) ────────────────────────────────────
--
-- One row per contract storage entry the indexer has fetched, addressed by the
-- full LedgerKey XDR that `getLedgerEntries` was called with. `state` is the
-- archival distinction: Soroban archives a persistent entry once its TTL
-- expires (it becomes inaccessible, not deleted), so an archived entry keeps
-- its row with `state = 'archived'` rather than being removed — which is what
-- lets a client tell "archived" apart from "absent" (no row at all).
--
-- `key` is the base64 XDR LedgerKey, so it round-trips back into a
-- getLedgerEntries call and is what the `keyPrefix` filter matches against.
-- `value` is the decoded native value (JSONB); `value_xdr` is the raw
-- LedgerEntryData XDR. Both are null when the entry is not currently live.
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
-- Keyset pagination orders by (last_modified_ledger, key); this index serves
-- the contract-scoped, durability-filtered, cursor-paginated read.
CREATE INDEX IF NOT EXISTS idx_contract_storage_entries_lookup
    ON contract_storage_entries (contract_id, network, last_modified_ledger DESC, key DESC);

-- ─── Trustlines (Asset Analytics) ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trustlines (
    account             TEXT NOT NULL,
    asset_code          TEXT NOT NULL,
    asset_issuer        TEXT NOT NULL,
    trust_limit         TEXT NOT NULL DEFAULT '922337203685.4775807',
    balance             TEXT NOT NULL DEFAULT '0',
    authorized          BOOLEAN NOT NULL DEFAULT TRUE,
    last_modified_ledger BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (account, asset_code, asset_issuer, network),
    CONSTRAINT trustlines_account_check           CHECK (account <> ''),
    CONSTRAINT trustlines_asset_code_check        CHECK (asset_code <> ''),
    CONSTRAINT trustlines_asset_issuer_check      CHECK (asset_issuer <> ''),
    CONSTRAINT trustlines_last_modified_ledger_check CHECK (last_modified_ledger > 0)
);

CREATE INDEX IF NOT EXISTS idx_trustlines_asset
    ON trustlines (asset_code, asset_issuer, network);

CREATE INDEX IF NOT EXISTS idx_trustlines_asset_active
    ON trustlines (asset_code, asset_issuer, network)
    WHERE balance <> '0';

CREATE INDEX IF NOT EXISTS idx_trustlines_account
    ON trustlines (account, network);

CREATE INDEX IF NOT EXISTS idx_trustlines_ledger
    ON trustlines (last_modified_ledger DESC);

-- ─── Assets (Asset Analytics) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS assets (
    asset_code          TEXT NOT NULL,
    asset_issuer        TEXT NOT NULL,
    holder_count        INTEGER NOT NULL DEFAULT 0,
    first_seen_ledger   BIGINT NOT NULL,
    last_activity_ledger BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (asset_code, asset_issuer, network),
    CONSTRAINT assets_asset_code_check          CHECK (asset_code <> ''),
    CONSTRAINT assets_asset_issuer_check        CHECK (asset_issuer <> ''),
    CONSTRAINT assets_holder_count_check        CHECK (holder_count >= 0),
    CONSTRAINT assets_first_seen_ledger_check   CHECK (first_seen_ledger > 0),
    CONSTRAINT assets_last_activity_ledger_check CHECK (last_activity_ledger > 0)
);

CREATE INDEX IF NOT EXISTS idx_assets_holder_count
    ON assets (holder_count DESC, asset_code, asset_issuer);

CREATE INDEX IF NOT EXISTS idx_assets_activity
    ON assets (last_activity_ledger DESC);

CREATE INDEX IF NOT EXISTS idx_assets_network
    ON assets (network);

-- ─── Asset Volume Buckets (Asset Analytics) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS asset_volume_buckets (
    asset_code          TEXT NOT NULL,
    asset_issuer        TEXT NOT NULL,
    bucket_time         TIMESTAMPTZ NOT NULL,
    volume              NUMERIC(20, 7) NOT NULL DEFAULT 0,
    operation_count     INTEGER NOT NULL DEFAULT 0,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    PRIMARY KEY (asset_code, asset_issuer, bucket_time, network),
    CONSTRAINT asset_volume_buckets_asset_code_check    CHECK (asset_code <> ''),
    CONSTRAINT asset_volume_buckets_asset_issuer_check  CHECK (asset_issuer <> ''),
    CONSTRAINT asset_volume_buckets_volume_check        CHECK (volume >= 0),
    CONSTRAINT asset_volume_buckets_operation_count_check CHECK (operation_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_asset_volume_buckets_asset_time
    ON asset_volume_buckets (asset_code, asset_issuer, network, bucket_time DESC);

CREATE INDEX IF NOT EXISTS idx_asset_volume_buckets_time
    ON asset_volume_buckets (bucket_time DESC);

CREATE OR REPLACE FUNCTION bucket_hour(ts TIMESTAMPTZ)
RETURNS TIMESTAMPTZ AS $$
    SELECT date_trunc('hour', ts);
$$ LANGUAGE SQL IMMUTABLE;

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
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    export_enabled      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at ON api_keys (revoked_at);

-- ─── Ledger Retry Queue ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ledger_retry_queue (
    ledger              BIGINT NOT NULL,
    network             TEXT NOT NULL DEFAULT 'mainnet',
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error          TEXT,
    first_failed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempted_at   TIMESTAMPTZ,
    permanently_failed  BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (ledger, network)
);

CREATE INDEX IF NOT EXISTS idx_retry_queue_next_attempt ON ledger_retry_queue (next_attempt_at)
    WHERE NOT permanently_failed;

-- Lower insert-triggered vacuum/analyze thresholds for the append-heavy tables.
ALTER TABLE transactions SET (
    autovacuum_vacuum_insert_threshold = 5000,
    autovacuum_vacuum_insert_scale_factor = 0.05,
    autovacuum_analyze_threshold = 5000,
    autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE operations SET (
    autovacuum_vacuum_insert_threshold = 5000,
    autovacuum_vacuum_insert_scale_factor = 0.05,
    autovacuum_analyze_threshold = 5000,
    autovacuum_analyze_scale_factor = 0.02
);
