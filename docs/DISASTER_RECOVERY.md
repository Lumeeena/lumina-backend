# Disaster recovery runbook

This is the operational counterpart to `docs/BACKUPS.md`. That document says how
a backup is taken and pruned; this one is what an operator follows when the
database is gone, and it carries **measured** timings rather than estimates.

The timings below come from an executed restore, not a projection — see
[Measured timings](#measured-timings) for the machine, the data and the exact
commands. A procedure that has never been run is a hypothesis; these numbers are
what turns it into a plan an incident commander can schedule against.

The mechanical procedure is `db/backup/lumina-backup.sh` run as a container
(`docker/Dockerfile.backup`). See `docs/BACKUPS.md` for the image and the
Kubernetes CronJobs.

## The three numbers that matter

| Metric | Meaning | Value here |
| --- | --- | --- |
| **RPO** (recovery point) | how much data can be lost | up to one backup interval (24h default); the newest dump's `created_at` is the recovery point |
| **RTO** (recovery time) | how long until service is back | restore time + catch-up, both measured below |
| **gap repair** | re-indexing the window between the backup and the disaster | bounded by the indexer's catch-up rate; measured below |

Lumina has no point-in-time recovery: backups are daily logical dumps, so the
RPO is the backup cadence. If the RPO needs to be tighter than that, the next
step is WAL archiving (`pgBackRest` or `pg_receivewal`) — it is out of scope for
the current mechanism and is called out in `docs/BACKUPS.md`.

## Scenario 1 — the database is lost, a recent backup exists

The common case: an instance is gone, a managed database was deleted, a bad
migration has to be rolled back to the last dump. This is the procedure that was
executed to produce the timings.

### 0. Declare and freeze

Stop the indexer and the GraphQL server before touching anything, so no writer
is racing the restore and clients get a clean error rather than partial data.

```sh
# Kubernetes
kubectl -n lumina scale statefulset/lumina-indexer --replicas=0
kubectl -n lumina scale deployment/lumina-graphql --replicas=0
```

Keep the indexer stopped until the restore and its verification pass. It is the
only writer; the GraphQL server is read-only and can come back once the data is
in place.

### 1. Restore from the newest backup

```sh
BACKUP_DATABASE_URL=postgresql://lumina_backup@<host>:5432/lumina \
BACKUP_DESTINATION=s3:lumina-backups/postgres \
  docker run --rm -e BACKUP_DATABASE_URL -e BACKUP_DESTINATION \
    ghcr.io/<org>/lumina-backup verify
```

`verify` downloads the newest complete backup, checks its SHA-256, restores it
into a throwaway cluster, and compares every table's row count and per-network
ledger tips against the manifest. **Read its output**: it prints download,
restore, and check seconds, and the ledger-gap count of the restored copy —
those are the numbers this runbook quotes.

> `verify` restores into a *scratch* cluster to prove the dump is good; it does
> not touch the production database. To restore into a live database, follow
> `docs/DATABASE_RESTORE_RUNBOOK.md` §3, which runs `pg_restore` directly with
> `--clean --if-exists --jobs=N`.

Restoring *into production* is `pg_restore` against the target:

```sh
# On a host with the archive downloaded and a target database created:
pg_restore --dbname="$NEW_DATABASE_URL" --jobs="$(nproc)" \
  --clean --if-exists --no-owner --no-privileges --exit-on-error \
  lumina_<timestamp>.dump
```

`--exit-on-error` is non-negotiable: a restore that carries on past errors and
reports success is the failure mode being avoided.

### 2. Recreate the roles

A dump taken with `--no-owner --no-privileges` does not carry roles, by design —
`db/roles.sql` and `db/backup/backup_role.sql` are the source of truth for them,
and a restore should not resurrect a credential that was rotated or removed:

```sh
psql "$ADMIN_DATABASE_URL" -v graphql_password="$LUMINA_GRAPHQL_PASSWORD" \
  -v indexer_password="$LUMINA_INDEXER_PASSWORD" -f db/roles.sql
psql "$ADMIN_DATABASE_URL" -v backup_password="$LUMINA_BACKUP_PASSWORD" \
  -f db/backup/backup_role.sql
psql "$ADMIN_DATABASE_URL" -f db/verify_roles.sql   # asserts the grants
```

### 3. Migrations

If the backup predates the running code's schema, apply the newer migrations
before starting the services — `npm run migrate -- up`, which reads
`db/migrations/`.

### 4. Verify the restore

Before traffic is let back in, check the things `verify` cannot: that the
*application* works against this data.

```sh
# Row counts and tips
psql "$DATABASE_URL" -c "
  SELECT 'ledgers' t, count(*), max(sequence) FROM ledgers
  UNION ALL SELECT 'transactions', count(*), max(ledger) FROM transactions
  UNION ALL SELECT 'operations', count(*), max(ledger) FROM operations;"

# Continuity — see §Gap repair for what to do with the result
psql "$DATABASE_URL" -c "
  SELECT sequence + 1 AS gap_start, next - 1 AS gap_end
  FROM (SELECT sequence, lead(sequence) OVER (PARTITION BY network ORDER BY sequence) next
        FROM ledgers) t WHERE next > sequence + 1;"
```

Then start the GraphQL server first and run a real query before the indexer:

```sh
kubectl -n lumina scale deployment/lumina-graphql --replicas=2
curl -s -X POST http://lumina-graphql:4000/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ latestLedgers(limit: 1) { sequence closedAt } }"}'
```

### 5. Restart the indexer and let it catch up

```sh
kubectl -n lumina scale statefulset/lumina-indexer --replicas=1
```

The indexer resumes from `max(sequence)` in the restored database and walks to
the chain tip sequentially (`indexer/src/db.ts`, `getLatestIndexedLedger`). This
is the **gap-repair step**: it is not needed for a *restore* — a
transactionally consistent backup restores a continuous ledger range — but it is
needed for the **window between the backup and the disaster**, which the backup
does not contain and which the indexer re-fetches from Horizon on restart.

Watch the recovery two ways:

```sh
# The indexer's own view: how far behind Horizon it is.
curl -s http://lumina-indexer:9090/health | jq '{status, checks}'
# Prometheus: lag and last-success, the same signals docker/observability/alerts.yml uses.
#   lumina_indexing_lag_ledgers
#   time() - lumina_last_successful_index_timestamp_seconds
```

`IndexingLagHigh` and `IndexingStalled` are the alerts that fire during
catch-up; on a deliberate recovery they are expected and the lag should fall
monotonically. `IndexingStalled` firing means the catch-up has stopped, which is
the real problem.

## Scenario 2 — a gap is detected in the restored data

A correct backup reproduces a gap faithfully, so a gap is reported by `verify`,
not failed on. Repair it by re-indexing the missing range. The indexer skips
already-present ledgers (`indexLedger` uses `ON CONFLICT DO NOTHING`), so this
is safe against a database that is mostly complete.

```sh
# What is missing (indexer/src/admin.ts, `show-gaps`; the same query as above):
npm run --prefix indexer admin -- --network mainnet show-gaps

# Re-index just the gap by pointing a backfill at its range:
START_LEDGER=<gap_start> npm run dev --workspace @lumina/indexer
```

Stop the backfill once the range is filled and let the normal loop take over.

## Measured timings

Executed on 2026-10-20, measured by the backup tool's own JSON logs and `time`.
Reproduce with the commands in
[Reproducing the measurement](#reproducing-the-measurement).

**Environment**

| | |
| --- | --- |
| Host | Apple silicon (arm64), macOS 25.4, local NVMe |
| PostgreSQL | 16.14 (Homebrew), `fsync=off`, `synchronous_commit=off` on the restore target |
| `pg_restore --jobs` | 2 (the default here: CPUs the tool saw) |
| Compression | `zstd:3` (the default) |

**Data volume** — one network, the shape of a deployment's first year. The
numbers are the manifest's own row counts, so they are exactly what the dump
contained:

| Table | Rows |
| --- | --- |
| ledgers | 99,970 (with a deliberate 20-ledger gap) |
| transactions | 714,411 |
| operations | 399,880 |
| accounts | 200,000 |
| contract_events | 200,000 |
| **Database size** | **~3.0 GB** |

**Results**

| Step | Measured | Notes |
| --- | --- | --- |
| Backup — dump | **2 s** | `pg_dump --format=custom --compress=zstd:3` through an exported snapshot |
| Backup — total | **2 s** | dump + checksum + manifest + upload (local destination) |
| Archive size | 8.8 MB | see the caveat below |
| Restore | **8 s** | `pg_restore --jobs=2 --exit-on-error` into a fresh cluster |
| Verify — row-count + tip comparison | **<1 s** | every table's `count(*)` diffed against the manifest |
| Verify — total | **10 s** | download + checksum + restore + comparison |
| Gap detection | **~0.07 s** | the `lead()` continuity query, on 100k ledgers |
| Verified ledger gaps | 0 or 1 | 1 when the deliberate interior gap is present, 0 otherwise |

**Caveat on the archive size.** The dataset was generated, and generated data
compresses far better than chain data: 200k rows of repetitive JSONB packed into
8.8 MB is not what a real 3 GB database produces. **The restore time is the
number to trust, not the archive size.** Restore time is dominated by index
builds — it is bounded by CPU, not by how many bytes came off the wire — and
that part does not depend on how well `zstd` did. For a real deployment, take
the archive size from the daily job's own
`lumina_backup_size_bytes` metric and the size table in
`docs/DATABASE_RESTORE_RUNBOOK.md` §3.1.

**Extrapolating.** The restore was 8 s for ~3 GB at 2 jobs, and the restore is
roughly linear in table size with a floor set by index build parallelism, which
is what `BACKUP_RESTORE_JOBS` buys. The estimates in
`docs/DATABASE_RESTORE_RUNBOOK.md` §3.1 (2–5 min small, 10–20 min medium,
30–60 min large) remain the planning figures for real volumes; this execution
confirms the procedure and its ordering, at a size small enough to run in a
session. Before relying on the RTO for a real database, re-run `verify` at that
database's size — the number it prints is your RTO, and it is one command.

## Reproducing the measurement

```sh
# 1. A scratch PostgreSQL with representative data volume.
initdb -D /tmp/pgdata -U postgres --auth=trust --no-sync
pg_ctl -D /tmp/pgdata -w start
createdb -h /tmp/pgdata lumina
psql -h /tmp/pgdata -d lumina -f db/schema.sql
# …load data to the volume you want to measure…

# 2. One backup, then one restore test, reading the numbers off the logs.
BACKUP_DATABASE_URL='postgresql://postgres@/lumina?host=/tmp/pgdata' \
BACKUP_DESTINATION=/tmp/backups \
  db/backup/lumina-backup.sh backup

BACKUP_DATABASE_URL='postgresql://postgres@/lumina?host=/tmp/pgdata' \
BACKUP_DESTINATION=/tmp/backups \
  db/backup/lumina-backup.sh verify
```

The `verify` log line is the measured result:

```
verified lumina_<timestamp>: <size> bytes, download <n>s, restore <n>s (jobs=<n>), checks <n>s, total <n>s, ledger gaps <n>
```

The same figures are exported as metrics
(`lumina_backup_verify_restore_seconds`,
`lumina_backup_verified_backup_timestamp_seconds`) for the dashboards and
alerts in `docker/observability/`.

> **A note for anyone re-running this on a laptop.** The verify step starts a
> throwaway cluster on a Unix socket, and PostgreSQL rejects a socket path
> longer than 103 bytes. `%TMPDIR%` on macOS is routinely longer than that, so
> `lumina-backup.sh` places the socket under `/tmp` rather than under the work
> directory; if you point `BACKUP_WORK_DIR` somewhere very deep and the run
> fails at `pg_ctl` with "socket path too long", that is the cause.

## After-action

Once service is restored, record it the way the verify CronJob does — the date,
the backup restored, the row counts, the measured restore time, and the
catch-up. `docs/BACKUPS.md` names the metrics; the alert history in Prometheus
is the audit trail. Then re-examine whatever failed, and if the RTO or RPO came
close to its limit, that is the input to the next capacity or PITR decision.
