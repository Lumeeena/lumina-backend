# PostgreSQL Operations

## Scheduled object-storage exports

Setting `S3_EXPORT_BUCKET` enables exports from the GraphQL service. It writes
newline-delimited JSON to `S3_EXPORT_PREFIX` (default `lumina/exports`) every
`S3_EXPORT_INTERVAL_MS` (default 86,400,000 ms) and removes matching Lumina
export objects older than `S3_EXPORT_RETENTION_DAYS` (default 30). A first
export starts when the service starts. For S3-compatible storage, configure
`S3_ENDPOINT`, `S3_REGION`, and `S3_FORCE_PATH_STYLE`; credentials use the AWS
SDK default credential chain. Grant the service `s3:PutObject`, `s3:ListBucket`,
and `s3:DeleteObject` only for the configured bucket/prefix. Uploads request
SSE-S3 encryption. API key data is deliberately excluded.

Watch `lumina_scheduled_exports_total{outcome="failure"}` for failed runs and
`lumina_scheduled_export_duration_seconds` for duration. An absent bucket
disables the scheduler.

## Insert-heavy table maintenance

`transactions` and `operations` are append-heavy and rarely updated. Their
table-specific `autovacuum_vacuum_insert_scale_factor=0.05` runs insert-triggered
vacuum earlier than PostgreSQL's default, while a 2% analyze scale factor keeps
planner statistics fresher as each table grows. Fixed thresholds of 5,000 avoid
excessive work on small tables. Settings are present in `db/schema.sql` for new
databases and `db/migrations/006_autovacuum.sql` for existing ones.
Apply the migration to an existing database with
`psql "$DATABASE_URL" -f db/migrations/006_autovacuum.sql`.

Capture observations before and after the change over comparable workload
windows; do not infer bloat from row counts alone:

```sql
SELECT relname, n_live_tup, n_dead_tup, n_tup_ins, n_tup_upd, n_tup_del,
       last_autovacuum, autovacuum_count, last_autoanalyze, autoanalyze_count
FROM pg_stat_user_tables
WHERE relname IN ('transactions', 'operations');

SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_catalog.pg_statio_user_tables
WHERE relname IN ('transactions', 'operations');
```

Reset neither statistics nor workload conditions between comparisons. This
checkout has no production database connection, so it does not claim a live
before/after bloat measurement.

## Soroban ledger entry batches

`getLedgerEntries` is called with at most 200 keys per request, the maximum
documented by [Stellar's RPC method reference](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getLedgerEntries).
Each call contributes to `lumina_soroban_requests_total` labelled by method and
outcome.
