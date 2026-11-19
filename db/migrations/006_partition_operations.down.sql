-- IRREVERSIBLE: do not remove this history row or attempt an in-place rollback.
-- The original migration partitioned and rewrote `operations`. Migration 007
-- later made keys composite across networks, which is incompatible with that
-- partitioning. Safely converting a populated legacy partitioned table back
-- requires an operator-planned copy and exclusive lock; this down file exists
-- to make that limitation explicit, not to imply it is reversible.
DO $$
BEGIN
  RAISE EXCEPTION '006_partition_operations is irreversible; follow docs/MIGRATION_ROLLBACK.md';
END $$;
