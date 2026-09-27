-- Migration 006: Partition `operations` by ledger range
-- Run with: psql $DATABASE_URL -f db/migrations/006_partition_operations.sql
--
-- ## Why
--
-- `operations` gets one insert per operation per ledger forever and is
-- already the largest table. Unpartitioned, index maintenance and autovacuum
-- cost grows with total table size, and dropping old data means a DELETE over
-- millions of rows instead of dropping a partition.
--
-- ## Why ATTACH instead of a rewrite
--
-- The naive migration (CREATE new partitioned table, INSERT SELECT the old
-- data into it) copies and re-indexes every row in the table, which on a
-- populated deployment is a multi-hour lock. Instead:
--
--   1. The existing `operations` table is renamed and given a CHECK
--      constraint proving every existing row has `ledger < v_upper`.
--   2. A new empty partitioned table is created in its place.
--   3. The renamed table is ATTACHed as that table's first partition.
--
-- Postgres only needs to prove the CHECK constraint implies the partition's
-- bounds to attach it — it does not rescan or rewrite the data, so this step
-- is fast regardless of table size. Everything already indexed keeps its
-- existing indexes; only the future is partitioned.
--
-- ## Why the primary key changes
--
-- Postgres requires a partitioned table's unique constraints (including the
-- primary key) to include the partition key. `operations.id` alone can no
-- longer be the primary key once partitioning by `ledger`; it becomes a
-- composite (id, ledger). The indexer's `ON CONFLICT (id) DO NOTHING` insert
-- becomes `ON CONFLICT (id, ledger) DO NOTHING` to match (see db.ts) — this
-- is not a behavior change, since a given operation id is only ever written
-- with one ledger value.
--
-- ## Partition sizing and automatic creation
--
-- Partitions are 2,000,000 ledgers wide (~115 days at Stellar's ~5s ledger
-- close time) — large enough that this doesn't create thousands of child
-- tables over the years, small enough that dropping one old partition is a
-- meaningful amount of data. `ensure_operations_partitions()` creates
-- partitions ahead of the current max ledger and is safe to call repeatedly
-- (it no-ops if the partition already exists); the indexer calls it
-- periodically so new partitions always exist before the chain reaches them
-- (see index.ts).
--
-- ## This migration only does structure, not retention
--
-- Dropping old partitions is a deliberate operational decision (what to keep,
-- for how long) and is intentionally NOT automated here — see the "Dropping
-- old partitions" note at the bottom of this file for the command.

\echo 'Running migration 006: partition operations by ledger range (structure change only, no data is copied)...'

BEGIN;

-- 1. Move the existing table out of the way. No data is copied by this
--    statement — it is a catalog rename.
ALTER TABLE operations RENAME TO operations_legacy;

-- Every index on the legacy table needs to move out of the way too, or the
-- new parent's CREATE INDEX statements below collide on name. Guarded with
-- IF EXISTS since 004_search_indexes.sql's asset indexes are only present on
-- deployments that already ran that migration.
ALTER INDEX operations_pkey                RENAME TO operations_legacy_pkey;
ALTER INDEX idx_operations_transaction     RENAME TO idx_operations_legacy_transaction;
ALTER INDEX idx_operations_source          RENAME TO idx_operations_legacy_source;
ALTER INDEX idx_operations_type            RENAME TO idx_operations_legacy_type;
ALTER INDEX idx_operations_created_at      RENAME TO idx_operations_legacy_created_at;
ALTER INDEX idx_operations_details         RENAME TO idx_operations_legacy_details;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_operations_asset_code') THEN
    ALTER INDEX idx_operations_asset_code   RENAME TO idx_operations_legacy_asset_code;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_operations_asset_issuer') THEN
    ALTER INDEX idx_operations_asset_issuer RENAME TO idx_operations_legacy_asset_issuer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_operations_asset_type') THEN
    ALTER INDEX idx_operations_asset_type   RENAME TO idx_operations_legacy_asset_type;
  END IF;
END $$;

-- 2. Prove the legacy table's ledger range with a CHECK constraint, so the
--    later ATTACH can validate it without scanning the table.
DO $$
DECLARE
  v_upper BIGINT;
BEGIN
  SELECT COALESCE(MAX(ledger), 0) + 1 INTO v_upper FROM operations_legacy;
  EXECUTE format(
    'ALTER TABLE operations_legacy ADD CONSTRAINT operations_legacy_ledger_check CHECK (ledger < %L)',
    v_upper
  );
END $$;

-- 3. Widen the primary key to include the partition key (required by
--    Postgres for any unique constraint on a partitioned table).
ALTER TABLE operations_legacy DROP CONSTRAINT operations_legacy_pkey;
ALTER TABLE operations_legacy ADD CONSTRAINT operations_legacy_pkey PRIMARY KEY (id, ledger);

-- 4. Create the new partitioned parent. Same columns and indexes as before —
--    indexes created here on the parent propagate to every partition,
--    current and future, automatically.
CREATE TABLE operations (
    id                  TEXT NOT NULL,
    type                TEXT NOT NULL,
    transaction_hash    TEXT NOT NULL REFERENCES transactions(hash),
    ledger              BIGINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL,
    source_account      TEXT NOT NULL,
    details             JSONB NOT NULL DEFAULT '{}',
    indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, ledger)
) PARTITION BY RANGE (ledger);

CREATE INDEX idx_operations_transaction ON operations (transaction_hash);
CREATE INDEX idx_operations_source      ON operations (source_account);
CREATE INDEX idx_operations_type        ON operations (type);
CREATE INDEX idx_operations_created_at  ON operations (created_at DESC);
CREATE INDEX idx_operations_details     ON operations USING GIN (details);

CREATE INDEX idx_operations_asset_code
    ON operations ((details->>'asset_code'))
    WHERE details->>'asset_code' IS NOT NULL;
CREATE INDEX idx_operations_asset_issuer
    ON operations ((details->>'asset_issuer'))
    WHERE details->>'asset_issuer' IS NOT NULL;
CREATE INDEX idx_operations_asset_type
    ON operations ((details->>'asset_type'))
    WHERE details->>'asset_type' IS NOT NULL;

-- 5. Attach the legacy table as the first partition. Its CHECK constraint
--    already proves ledger < v_upper, so Postgres validates this in O(1)
--    instead of scanning every row.
DO $$
DECLARE
  v_upper BIGINT;
BEGIN
  SELECT COALESCE(MAX(ledger), 0) + 1 INTO v_upper FROM operations_legacy;
  EXECUTE format(
    'ALTER TABLE operations ATTACH PARTITION operations_legacy FOR VALUES FROM (MINVALUE) TO (%L)',
    v_upper
  );
END $$;

-- 6. Partition creation helper. `partition_size` intentionally matches the
--    constant in indexer/src/db.ts (PARTITION_SIZE) — if you change one,
--    change the other.
--
--    Always continues from whatever the current highest partition's upper
--    bound actually is (read back from the catalog), rather than computing
--    boundaries from ledger numbers directly. That matters here because the
--    just-attached legacy partition's upper bound is an arbitrary number
--    (whatever the max ledger happened to be at migration time), not a clean
--    multiple of partition_size — computing new boundaries independently
--    would either overlap it or leave a gap right after it.
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

  -- Highest upper bound among existing partitions, however irregular (a
  -- fresh-grid boundary, or the legacy table's actual max ledger + 1).
  SELECT MAX((regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''?(-?\d+)''?\)'))[1]::bigint)
    INTO v_upper
  FROM pg_inherits pi JOIN pg_class c ON c.oid = pi.inhrelid
  WHERE pi.inhparent = 'operations'::regclass;

  v_from := COALESCE(v_upper, 0);
  v_target := v_max_ledger + partitions_ahead * partition_size;

  -- Idempotent: once enough partitions exist to reach v_target, this loop
  -- runs zero times. As v_max_ledger grows on later calls, v_target grows
  -- with it and only the newly-needed partitions get created.
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

-- Create the first batch of forward partitions right away so writes never
-- fall through to "no partition for this ledger" immediately after migrating.
SELECT ensure_operations_partitions(5);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('006_partition_operations', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;

\echo 'Migration 006 complete.'

-- ## Dropping old partitions (not automated by this migration)
--
-- List partitions and their bounds:
--   SELECT inhrelid::regclass AS partition, pg_get_expr(relpartbound, oid) AS range
--   FROM pg_inherits JOIN pg_class ON pg_class.oid = pg_inherits.inhrelid
--   WHERE inhparent = 'operations'::regclass ORDER BY partition;
--
-- Drop one, once you've decided you no longer need that ledger range:
--   ALTER TABLE operations DETACH PARTITION operations_p12;
--   DROP TABLE operations_p12;
--
-- DETACH before DROP (rather than dropping directly) briefly makes the
-- partition invisible to new queries before the drop, avoiding a window
-- where an in-flight query holding a lock on it blocks the DROP.
