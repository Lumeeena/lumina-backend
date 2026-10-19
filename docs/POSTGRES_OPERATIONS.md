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

## Calibrating alert thresholds

Alert thresholds should be compared with a representative operating window
before they are changed. For a continuously scraped deployment, inspect the
observed distributions of the corresponding signals (with network labels kept
separate) before adjusting `docker/observability/alerts.yml`. Examples for a
30-day window:

```promql
quantile_over_time(0.95, lumina_indexing_lag_ledgers{network="mainnet"}[30d])
max_over_time(lumina_indexing_lag_ledgers{network="mainnet"}[30d])
quantile_over_time(0.95, (time() - lumina_last_successful_index_timestamp_seconds{network="mainnet"})[30d:1m])
max_over_time((time() - lumina_last_successful_index_timestamp_seconds{network="mainnet"})[30d:1m])
sum(increase(lumina_horizon_requests_total{status="429"}[30d]))
sum(increase(lumina_indexing_errors_total[30d]))
```

The range-query subqueries sample freshness once per minute; choose a step and
window that cover normal deploys, traffic cycles, and known transient
dependencies. Compare warning thresholds with the normal tail and critical
thresholds with service impact, while accounting for each rule's `for` duration.
Keep the chosen window, percentiles/maxima, and reasoning with the rule change.
The values currently in the rules have not been calibrated against production
history in this checkout; no production time series was available for this
review.

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
