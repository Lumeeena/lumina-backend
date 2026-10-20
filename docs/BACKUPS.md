# Database backups

Re-indexing from the chain tip does not recover history, so the database is the
only copy of everything the indexer has collected. This document describes how
that copy is taken, where it goes, how it is pruned, and — the part that makes
it a backup rather than a hope — how it is proven restorable.

The mechanism lives in `db/backup/lumina-backup.sh`, one script with two
subcommands:

```
lumina-backup.sh backup   dump, checksum, upload, prune, report
lumina-backup.sh verify   download the newest backup, restore it into a
                          throwaway cluster, compare it with what was dumped
```

It runs as a container image (`docker/Dockerfile.backup`), scheduled on
Kubernetes as the two CronJobs in `deploy/kubernetes/base/backup/` and locally
by hand or by cron.

## The backup

### Consistent, not nearly-consistent

`backup` holds one `REPEATABLE READ` transaction open, exports its snapshot, and
points `pg_dump` at that snapshot with `--snapshot`. The manifest's per-table row
counts are taken **inside the same transaction**, so they describe exactly the
rows in the dump even while the indexer keeps writing. That is what lets `verify`
demand equality rather than "roughly the same" — and equality is the only
comparison that catches a table that loaded empty or a dump that stopped part
way through a large table.

```
session 1 (open)                          session 2
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_export_snapshot();  ────────▶   pg_dump --snapshot=<id> …
SELECT … count(*) …                       (reads the same snapshot)
COMMIT;  ◀──────────────────────────────  (dump finished)
```

`pg_dump` does not block the indexer's reads or writes, so a backup needs no
maintenance window.

### What a backup consists of

Three objects per run, all prefixed `lumina_<UTC timestamp>`:

| Object            | Contents                                                          |
| ----------------- | ----------------------------------------------------------------- |
| `<name>.dump`     | `pg_dump --format=custom`, compressed (default `zstd:3`)           |
| `<name>.dump.sha256` | the archive's SHA-256, checked before every restore             |
| `<name>.manifest.json` | server and `pg_dump` versions, size, checksum, `dump_seconds`, per-network ledger rows and max sequence, and every table's exact row count from the dump's snapshot |

The manifest is written and uploaded **last**: its presence is what marks a
backup complete, so a run that dies mid-upload leaves no manifest and `verify`
never picks it.

### Configuration

Every variable, all read from the environment (or a file — see
`docs/SECRETS.md`):

| Variable                        | Default           | Meaning                                                        |
| ------------------------------- | ----------------- | -------------------------------------------------------------- |
| `BACKUP_DATABASE_URL`           | — (required)      | `postgresql://` URL of the database to dump                     |
| `BACKUP_DATABASE_URL_FILE`      | —                 | …or a file holding it                                           |
| `BACKUP_DATABASE_PASSWORD_FILE` | —                 | a file holding only the password                                |
| `BACKUP_DESTINATION`            | — (required)      | a local path or any rclone remote (`s3:bucket/prefix`, `gcs:…`) |
| `BACKUP_PREFIX`                 | `lumina`          | object name prefix                                              |
| `BACKUP_COMPRESSION`            | `zstd:3`          | `pg_dump --compress` value                                      |
| `BACKUP_RETENTION_DAYS`         | `14`              | prune backups older than this                                   |
| `BACKUP_RETENTION_MIN_COUNT`    | `3`               | never keep fewer than this many                                 |
| `BACKUP_COUNT_ROWS`             | `true`            | exact row counts in the manifest                                |
| `BACKUP_VERIFY_MAX_AGE_HOURS`   | `48`              | `verify` fails if the newest backup is older                    |
| `BACKUP_RESTORE_JOBS`           | CPUs              | `pg_restore --jobs` for `verify`                                |
| `BACKUP_WORK_DIR`               | `$TMPDIR` or `/tmp` | scratch space                                                 |
| `PUSHGATEWAY_URL`               | —                 | push metrics here, e.g. `http://pushgateway:9091`               |
| `BACKUP_METRICS_FILE`           | —                 | …and/or write a node_exporter textfile                          |
| `BACKUP_INSTANCE`               | `lumina`          | grouping label for metrics                                      |

`BACKUP_DESTINATION` with `rclone` means the same code path serves a mounted
volume and every object store rclone supports. The Kubernetes base points it at
an S3 bucket reached with the pod's own cloud identity (`env_auth`, so IRSA /
Pod Identity work with no keys) and turns on server-side encryption. For GCS,
Azure or an S3-compatible store, change the `RCLONE_CONFIG_S3_*` remote.

### Retention

`prune` deletes backups older than `BACKUP_RETENTION_DAYS`, but never the newest
`BACKUP_RETENTION_MIN_COUNT` complete ones: if backups stop being taken, the
last good ones must not age out from under the operator. The manifest is deleted
first, so a half-pruned backup is incomplete rather than complete-looking with a
missing dump.

### The role

`pg_dump` has to read every table, which neither service role can do. The job
gets its own login — `lumina_backup`, a member of `pg_read_all_data` — created
by `db/backup/backup_role.sql`. It can read everything and write nothing. See
that file and `docs/DATABASE_ROLES.md`.

## Verifying a backup

A dump nobody has restored is a hypothesis. `verify` is what turns it into a
fact, and it is run on a schedule (weekly in the Kubernetes base), not by hand.

```
download newest manifest, dump and checksum
fail if the newest backup is older than BACKUP_VERIFY_MAX_AGE_HOURS
sha256sum -c the archive
initdb a private, throwaway cluster (unix socket only, fsync off)
createdb, pg_restore --jobs --exit-on-error
compare every table's row count against the manifest
compare per-network ledger tips (rows, max sequence)
report ledger gaps (reported, not failed on — a correct backup reproduces a gap)
report metrics
```

The scratch cluster is started inside the job's own container from the server
binaries the backup image already carries — no second database is needed to
restore into. `--exit-on-error` matters: a restore that carries on past errors
and reports success is precisely the failure being tested for.

## Metrics and alerting

Both subcommands report their outcome as Prometheus gauges, to a Pushgateway
and/or a node_exporter textfile:

| Metric                                          | Meaning                                             |
| ----------------------------------------------- | --------------------------------------------------- |
| `lumina_backup_last_run_timestamp_seconds`      | when either operation last ran                      |
| `lumina_backup_last_run_success`                | 1 / 0 for the last run of that operation            |
| `lumina_backup_last_success_timestamp_seconds`  | when a backup last **succeeded**                    |
| `lumina_backup_duration_seconds`                | wall-clock of the last run                          |
| `lumina_backup_size_bytes`                      | archive size of the last backup                     |
| `lumina_backup_verify_restore_seconds`          | how long the last verification's restore took       |
| `lumina_backup_verify_ledger_gaps`              | gaps found in the last restored copy                |
| `lumina_backup_verified_backup_timestamp_seconds` | creation time of the last verified backup          |

On failure the last-success gauge is deliberately left out. A Pushgateway POST
replaces only the metric names it is sent, and the textfile path carries the old
line forward, so a failed run cannot erase the evidence of the last good one —
which is the number the alerts are written against.

Alerts live in `docker/observability/alerts.yml` under the `lumina-backups`
group: no successful backup within the window, a failed verify, and a newest
backup older than the verify age limit.

## Restoring

Restoring is an operator procedure with its own runbook and measured timings:
see `docs/DISASTER_RECOVERY.md`. The short version:

```sh
# On any host with the backup image and read access to the destination:
BACKUP_DATABASE_URL=postgresql://lumina_backup@db:5432/lumina \
BACKUP_DESTINATION=s3:lumina-backups/postgres \
  docker run --rm -e BACKUP_DATABASE_URL -e BACKUP_DESTINATION \
    ghcr.io/<org>/lumina-backup verify
```

## What this does not do

- **No point-in-time recovery.** This is a logical dump taken daily; up to a
  day's writes are lost in a disaster, and there is no replay to a moment
  between dumps. The measured recovery point is recorded in
  `docs/DISASTER_RECOVERY.md`. PITR (WAL archiving, `pgBackRest`) is the next
  step if the RPO needs to be tighter than the backup interval.
- **No incremental or differential backups.** Each run is a full dump.
- **No encryption at the tool level.** It relies on the destination's
  server-side encryption. A destination that does not provide it needs
  `rclone crypt` (or equivalent) in front.
