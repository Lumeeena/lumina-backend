# Database operations

## Read replica

The GraphQL server can serve queries from a read-only replica by setting
`READ_DATABASE_URL`. When it is unset — or equal to `DATABASE_URL` — the server
behaves exactly as before and opens only the primary pool.

What runs where:

| Traffic | Connection |
|---|---|
| GraphQL queries (`transactions`, `accounts`, `operations`, `search`, `events`, …) | `READ_DATABASE_URL` when set, else `DATABASE_URL` |
| Subscriptions (`newTransaction`, `accountActivity`) | `DATABASE_URL` (primary) |
| API-key auth lookups, `/health`, `/metrics`, `/export` | `DATABASE_URL` (primary) |
| Migrations and `LISTEN` | `DATABASE_URL` (primary) |

Subscriptions are pinned to the primary deliberately: `LISTEN` does not work
usefully through a replica, and a subscriber replays the exact ledger the
primary just announced. Reading that replay from a lagging replica could return
no rows yet, and the notification would be dropped.

### Replication lag

A replica is eventually consistent. With `READ_DATABASE_URL` set, a query may
miss a ledger that was indexed moments ago, so the API can appear a few seconds
behind the head of the chain — the delay is the replica's `replay_lag`, not an
indexer stall. Do not point `READ_DATABASE_URL` at the primary's host expecting
a no-op; either leave it unset or use a real replica. Operations that must
observe the newest write (debugging a just-indexed ledger, comparing the two
databases) should query the primary directly.

Monitor lag on the replica
(`SELECT now() - pg_last_xact_replay_timestamp();`) and alert before it grows
past the freshness the API promises. If the replica falls too far behind,
unset `READ_DATABASE_URL` and restart the service to fall back to the primary.

## Index usage review

Do not drop an index solely because `idx_scan` is zero in one snapshot. PostgreSQL
statistics reset on restart/reset and need a representative workload window.
Capture `pg_stat_user_indexes` after that window and compare index size, query
plans, uniqueness/constraint use, partial predicates, and write overhead. The
read-only report in `db/audit-index-usage.sql` lists usage and definitions and
flags exact duplicate key/predicate definitions for manual review. Preserve
indexes supporting constraints and re-check `EXPLAIN (ANALYZE, BUFFERS)` for
important queries before scheduling any removal.

### Static findings (no production statistics)

Reviewed from `db/schema.sql`, migrations 001-006 and the query code in
`graphql-server/src` and `indexer/src`:

- **Dropped (migration 007):** `idx_api_keys_key_hash` duplicates the index
  behind `key_hash TEXT NOT NULL UNIQUE`. Redundant by construction.
- **Kept, but flagged for the production report:** `idx_api_keys_revoked_at`
  (no query filters on `revoked_at` alone; the table is tiny),
  `idx_operations_details` and `idx_events_topics` GIN indexes (no
  `@>`/`?` predicate found in the code that would use them; GIN is the most
  expensive to maintain on the write path), and the standalone
  `created_at DESC` indexes on `transactions`, `operations` and
  `contract_events` (only `operations.created_at` is filtered on, by the asset
  volume query). These are unused only on the evidence of static reading, so
  they are not removed until the report below confirms `idx_scan = 0` over a
  representative window.

No production database credentials are available in this checkout, so no
index has been removed based on unobserved production usage. Run the report
against a representative deployment and attach its output before deciding on
any unused-index removal.

## Asynchronous account refreshes

Ledger, transaction, and operation rows are committed together with durable
account-refresh intents in `account_refresh_queue`. Horizon account lookups run
after that commit, so slow account responses do not delay ledger indexing. The
worker upserts account state and removes the exact queue request in one database
transaction; transient failures stay queued and are retried. On restart, the
worker scans the queue for pending requests. This is at-least-once work: a crash
after the Horizon response but before the account transaction commits may cause
the lookup to run again, but cannot lose the refresh. After applying migration
008, rerun `db/roles.sql` to grant the indexer its scoped queue privileges.

## Bulk export

There are two export formats, and they cover different tables. Both are
documented in full — every column, its unit (stroops vs. decimal), and a worked
example — in **[docs/EXPORT_FORMATS.md](EXPORT_FORMATS.md)**.

### CSV, per table, on demand

`GET /export/:table` streams one table as CSV with a header row, for
`ledgers`, `transactions` or `operations`. It accepts `min_ledger`,
`max_ledger`, `min_date` and `max_date` to bound the range:

```bash
curl -H "X-Api-Key: $KEY" \
  "http://localhost:4000/export/transactions?min_ledger=52000000&max_ledger=52001000"
```

A full export is therefore one request per table.

### NDJSON, all tables, on a schedule

Setting `S3_EXPORT_BUCKET` makes the GraphQL service write one
newline-delimited JSON file per interval containing all indexed data tables
(see [POSTGRES_OPERATIONS.md](POSTGRES_OPERATIONS.md)). API keys are excluded.
Each line is `{"table":"…","record":{…}}`.

### Export permission

`api_keys.export_enabled` and the `grant-export` / `revoke-export` commands
(`npm run manage-keys -- grant-export <id|hash>`) are backed by
`hasExportPermission`, which checks for an active key with export permission
explicitly granted.

**Note:** `GET /export/:table` is currently registered ahead of the shared
API-key middleware in `graphql-server/src/index.ts`, so Express serves it before
the auth layer runs and the route is reachable without a key. The
`hasExportPermission` gate is not enforced on it. Treat this as a known gap to
close rather than a documented guarantee — the route should be moved behind the
middleware, or given its own explicit check.

## Timestamp convention

All persisted instants use PostgreSQL `TIMESTAMPTZ`; application values must be
timezone-aware instants (Horizon ISO-8601 values with an offset or `Z`). Never
construct a timestamp from a timezone-free local date string. The PostgreSQL
driver returns `TIMESTAMPTZ` as JavaScript `Date`, and the API serializes it with
`toISOString()` as UTC RFC 3339 (`Z`). Database session timezone does not change
the represented instant.

## Migrations

Use `npm run migrate -- status` to inspect migration history and
`npm run migrate -- up` to apply pending migrations in filename order. Set
`RUN_MIGRATIONS_ON_STARTUP=true` on the GraphQL service to apply migrations
before it listens. A PostgreSQL advisory lock serializes concurrent runners;
the runner rejects unknown, missing, or out-of-order history. Migration SQL
must record its own filename stem in `schema_migrations` (as existing migration
files do).

## Migration testing against a populated database

Everywhere else migrations are applied to empty databases — CI's schema jobs and
`db/check-schema-parity.sh` both do. On an empty database every migration is fast
and every constraint is trivially satisfied, so the two failures that actually
break a deployment are invisible:

- a rule the existing rows violate — a `NOT NULL` with no default, a unique
  constraint the data does not satisfy, or a primary key that a partitioned
  table is not allowed to have;
- a step that rewrites or re-indexes every row, whose duration is a function of
  table size and therefore cannot be learned from an empty table at all.

`graphql-server/src/migrations.integration.test.ts` covers both. It creates a
scratch database, applies the chain through the production runner one migration
at a time, seeds volume data at the point where a real deployment would already
have it (after `005_api_keys`, the last migration that only adds tables, columns
and indexes), then applies the rest — timing each one and asserting after every
step that every seeded table still holds the same rows and the same content
checksum.

```bash
MIGRATION_TEST_BASE_URL=postgresql://lumina:lumina_test@localhost:5432/postgres \
  npm run test:migrations --prefix graphql-server
```

`MIGRATION_TEST_BASE_URL` is a maintenance connection used only to create and
drop the scratch database, the same convention as `check-schema-parity.sh`'s
`PARITY_BASE_URL`. The test is skipped when it is unset. No production data is
involved: every row comes from md5 of a row index via
`db/migration-test-seed.sql`, which is why two runs can be compared by checksum
at all. On success the scratch database is dropped; on failure it is left in
place and the connection string is printed.

The row counts are the ones the run actually used, printed with the durations,
because a duration without a row count says nothing. They default to 30,000
ledgers, 60,000 transactions, 180,000 operations, 20,000 accounts and 50,000
events — large enough that a rewrite or an index rebuild is measurable, small
enough to run on demand. They are the `migration_seed_scale` row at the top of
the seed file; raise them to model a larger deployment, and read the durations
against the counts printed beside them.

The test is deliberately not part of `npm test`, which needs no database, and it
is not wired into a CI job yet: it cannot pass until the defects below are
fixed, and a permanently red job teaches people to ignore red jobs. Adding a
job that runs it next to `db-schema-parity` is the intended follow-up.

### Durations recorded so far

At the default scale — 180,000 operations, 30,000 ledgers, 60,000 transactions,
20,000 accounts, 50,000 contract events, 50,000 custom events — the two
migrations that apply cleanly to populated tables are catalog-only and fast:

| step | duration |
|---|---|
| `006_autovacuum` (storage parameters on 60,000 transactions + 180,000 operations) | 6ms |
| `006_export_permissions` (adds a column with a default) | 5ms |
| seeding the database in the first place | ~26s |

Neither of those rewrites rows, which is why they are milliseconds; they are
recorded because "fast" is only meaningful next to a row count. The durations
that matter — `006_partition_operations` and `007_networks`, which rebuild
primary keys over every row — cannot be recorded until the defects below are
fixed, because they do not run at all. That is the gap the test exists to close.

### What the test reports today

The chain cannot build a populated database. Five separate defects, each
reproducible on its own; the test stops at the first and names it.

| # | Where | Symptom |
|---|---|---|
| 1 | `graphql-server/src/migrations.ts:12` | `loadMigrations` expands `\ir ../schema.sql` with `String.replace`, whose replacement text treats `$$` as an escaped `$`. The PL/pgSQL delimiters added by 006 collapse, and 001 fails: `syntax error at or near "$"`. |
| 2 | `db/schema.sql:122` | The file defines `operations` without `PARTITION BY` but still calls `ensure_operations_partitions(3)`: `"operations" is not partitioned`. This is why the `Verify DB Schema Parity` job is red. |
| 3 | `graphql-server/src/migrations.ts:59` | 004 is sent to the server as one multi-statement query, which node-postgres wraps in an implicit transaction: `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. |
| 4 | `db/migrations/006_partition_operations.sql:109` | Its foreign key references `transactions(hash)`, but since 007 the unique constraint is `(hash, network)`: `there is no unique constraint matching given keys for referenced table "transactions"`. |
| 5 | `db/migrations/007_networks.sql:74` | `ADD PRIMARY KEY (id, network)` on a table that 006 partitioned by `ledger`: `unique constraint on partitioned table must include all partitioning columns`. |

Defects 1 and 3 break only the Node runner, which is the path production
actually uses (`npm run migrate up`, `RUN_MIGRATIONS_ON_STARTUP`). Defects 2, 4
and 5 break the chain however it is applied. They share one cause: the
partitioning work (#170) and the multi-network work (#176) were merged without
being reconciled — `006_partition_operations.sql` assumes the pre-network
schema, `007_networks.sql` assumes the pre-partitioning one, and `db/schema.sql`
is a hybrid that satisfies neither. Its own comment at `db/schema.sql:51-54`
still documents the range partitioning and the partition-key rule that defect 5
violates.
