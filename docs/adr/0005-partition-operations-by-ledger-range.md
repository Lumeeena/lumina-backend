# 0005. `operations` is partitioned by ledger range

- **Status:** accepted
- **Date:** 2026-09-27
- **Sources:** the header comment of `db/migrations/006_partition_operations.sql`
  (the fuller statement), the note at `db/schema.sql` above the `operations`
  table, and `indexer/src/db.ts` next to `ensurePartitions`. The commit that
  introduced it (`9224b61`) has an empty message — the reasoning lives in the
  migration file, not in git history.

## Context

`operations` takes one insert per operation per ledger, forever, and is the
largest table in the schema. Unpartitioned, two costs grow with total table
size: index maintenance and autovacuum, and the cost of ever removing old data,
which means a `DELETE` over millions of rows rather than dropping a partition.

## Options considered

**The naive migration** — create a new partitioned table and `INSERT … SELECT`
the old data into it. Rejected in the migration header: it copies and re-indexes
every row in the table, which on a populated deployment is a multi-hour lock.

**Leaving it unpartitioned.** Rejected for the reasons above; the table's growth
is unbounded by construction.

## Decision

Partition by ledger range, 2,000,000 ledgers wide — roughly 115 days at
Stellar's ~5s ledger close time: large enough not to create thousands of child
tables over the years, small enough that dropping one partition is a meaningful
amount of data.

The migration takes the structure-only path:

1. the existing `operations` table is renamed and given a `CHECK` constraint
   proving every existing row has `ledger < v_upper`;
2. a new empty partitioned table is created in its place;
3. the renamed table is `ATTACH`ed as its first partition.

Postgres only has to prove the `CHECK` constraint implies the partition's
bounds, so the attach is O(1) regardless of table size, and everything already
indexed keeps its existing indexes — only the future is partitioned.

`ensure_operations_partitions()` creates partitions ahead of the current max
ledger and is idempotent, so the indexer can call it periodically and new
partitions always exist before the chain reaches them.

## Consequences

**The primary key changes shape.** Postgres requires a partitioned table's unique
constraints — the primary key included — to include the partition key. `id`
alone can no longer be the key; it becomes composite with `ledger`, and the
indexer's `ON CONFLICT` target changes to match. That is not a behaviour change,
since a given operation id is only ever written with one ledger value.

**Partition boundaries are read back from the catalog, not computed.** The
just-attached legacy partition's upper bound is an arbitrary number — whatever
the max ledger happened to be at migration time — so computing the next boundary
from a multiple of the partition size would either overlap it or leave a gap
right after it.

**Retention is deliberately not automated.** Dropping old partitions is an
operational decision about what to keep and for how long, so the migration
documents the procedure instead: `DETACH` before `DROP`, because detaching
briefly makes the partition invisible to new queries and avoids a window where
an in-flight query holding a lock on it blocks the drop.

**This decision currently conflicts with ADR 0004 in the migration chain, and
the test that should have caught it is #128.** `006_partition_operations.sql`
assumes the pre-network schema (its foreign key references `transactions(hash)`,
which has not been unique on its own since 007), while `007_networks.sql` sets
`operations`' primary key to `(id, network)` on a table this migration
partitioned by `ledger`, which Postgres forbids. `db/schema.sql` reflects
neither consistently. Reconciling them is a schema decision that has not been
made yet; `graphql-server/src/migrations.integration.test.ts` is the test that
fails until it is.
