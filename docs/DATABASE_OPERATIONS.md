# Database operations

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

## Bulk export

Apply migrations before using `GET /export`. It streams newline-delimited JSON
records from the indexed data tables (API keys and secrets are excluded). The
request requires `Authorization: Bearer <key>` for an active key with explicit
export permission. Grant or revoke it with `npm run manage-keys --
grant-export <id|hash>` and `revoke-export <id|hash>`. Export traffic has its
own per-key window limit (`EXPORT_RATE_LIMIT_PER_MINUTE`, default 2) and
per-process concurrency limit (`MAX_CONCURRENT_EXPORTS`, default 2).

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
