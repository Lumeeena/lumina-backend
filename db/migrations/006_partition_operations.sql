-- Migration 006: Partition `operations` by ledger range
-- Run with: psql $DATABASE_URL -f db/migrations/006_partition_operations.sql
--
-- ## History
--
-- `operations` gets one insert per operation per ledger forever and is the
-- largest table, so it was range-partitioned by ledger to keep index
-- maintenance and autovacuum cost proportional to the recent data rather than
-- to everything ever written, and to make expiring old data a partition drop
-- instead of a DELETE over millions of rows.
--
-- ## This partitioning no longer exists
--
-- Migration 007 adds `network` to every table and makes the keys composite
-- over it: operation ids repeat across networks, so a single-column `id` would
-- either reject the second network or, with ON CONFLICT DO UPDATE, silently
-- overwrite one network's row with the other's. A partitioned table's unique
-- constraints must include the partition key, and `(id, network)` cannot also
-- carry `ledger` — so the multi-network work and the partitioning are mutually
-- exclusive, and the partitioning lost.
--
-- `operations` is a plain table again, with primary key `(id, network)`. That is
-- what db/schema.sql declares and what a fresh deployment is built from.
-- indexer/src/db.ts inserts without an ON CONFLICT inference clause, so the one
-- statement works against both this key and the (id, ledger, network) of a
-- deployment still carrying the partitioning.
--
-- ## Why this file does almost nothing now
--
-- db/check-schema-parity.sh builds one database from db/schema.sql and another
-- by replaying every file in this directory, then diffs the two dumps. Because
-- 001_init.sql inlines db/schema.sql, every migration after it is replayed on
-- top of the *current* schema — so a migration that redoes work db/schema.sql
-- already reflects either no-ops or, as here, conflicts with it. (Migration 008
-- documents the same convention for the constraints it adds.)
--
-- The partitioning DDL that used to live in this file is therefore gone. It
-- could only ever apply to a pre-007 database, and for a database in that state
-- the partitioning is not what we want anyway. A deployment that ran the
-- original version of this file still has a partitioned `operations`; that
-- divergence is real and is described in db/schema.sql and docs/RETENTION.md
-- rather than papered over by a data migration here, because merging a
-- partitioned table back into a plain one copies the whole table and holds an
-- exclusive lock for the duration — a decision for whoever owns that
-- deployment, not a side effect of a parity fix.
--
-- What remains is the helper function, defined here for the same reason it is
-- defined in db/schema.sql: the parity check compares the dumps, so both files
-- have to end up with the same function. The body below is character-for-character
-- the one in db/schema.sql — keep them that way, or the parity check will fail
-- on a whitespace change.

\echo 'Running migration 006: operations partitioning (no-op; partitioning was reverted by 007)...'

BEGIN;

-- Partition creation helper. `partition_size` intentionally matches the
-- constant in indexer/src/db.ts (PARTITION_SIZE) — if you change one,
-- change the other.
--
-- Always continues from whatever the current highest partition's upper
-- bound actually is (read back from the catalog), rather than computing
-- boundaries from ledger numbers directly. That matters here because a
-- just-attached legacy partition's upper bound is an arbitrary number
-- (whatever the max ledger happened to be at migration time), not a clean
-- multiple of partition_size — computing new boundaries independently
-- would either overlap it or leave a gap right after it.
--
-- Not invoked, because `operations` is no longer partitioned and creating a
-- partition of a plain table is an error. It is defined so the two files that
-- must agree do.
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

INSERT INTO schema_migrations (version, applied_at)
VALUES ('006_partition_operations', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;

\echo 'Migration 006 complete.'
