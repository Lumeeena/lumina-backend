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
