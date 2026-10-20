#!/usr/bin/env bash
# Scheduled PostgreSQL backups for Lumina, and the restore test that proves them.
#
#   lumina-backup.sh backup   dump, checksum, upload, prune, report
#   lumina-backup.sh verify   download the newest backup, restore it into a
#                             throwaway cluster, compare it with what was dumped
#
# Re-indexing from the chain tip does not recover history, so the database is
# the only copy of everything the indexer has collected. A dump nobody has
# restored is a hope, not a backup: `verify` restores into a scratch Postgres
# started inside this container and checks every table's row count against the
# manifest written at dump time, from the same snapshot the dump was taken in.
#
# Both subcommands report their outcome as Prometheus metrics (Pushgateway or a
# node_exporter textfile). A failed run never overwrites the last-success time,
# so "how long since a good backup" stays answerable from the metrics alone.
#
# Configuration — environment variables, all documented in docs/BACKUPS.md:
#
#   BACKUP_DATABASE_URL            postgresql:// URL of the database to dump
#   BACKUP_DATABASE_URL_FILE       ...or a file holding it
#   BACKUP_DATABASE_PASSWORD_FILE  a file holding only the password
#   BACKUP_DESTINATION             where backups go: a local path or any rclone
#                                  remote (s3:bucket/prefix, gcs:bucket/prefix…)
#   BACKUP_PREFIX                  object name prefix (default: lumina)
#   BACKUP_COMPRESSION             pg_dump --compress value (default: zstd:3)
#   BACKUP_RETENTION_DAYS          prune backups older than this (default: 14)
#   BACKUP_RETENTION_MIN_COUNT     never keep fewer than this many (default: 3)
#   BACKUP_COUNT_ROWS              exact row counts in the manifest (default: true)
#   BACKUP_VERIFY_MAX_AGE_HOURS    verify fails if the newest backup is older
#                                  (default: 48)
#   BACKUP_RESTORE_JOBS            pg_restore --jobs for verify (default: CPUs)
#   BACKUP_WORK_DIR                scratch space (default: $TMPDIR or /tmp)
#   PUSHGATEWAY_URL                push metrics here, e.g. http://pushgateway:9091
#   BACKUP_METRICS_FILE            ...and/or write them to this textfile
#   BACKUP_INSTANCE                grouping label for metrics (default: lumina)
set -Eeuo pipefail

PREFIX="${BACKUP_PREFIX:-lumina}"
COMPRESSION="${BACKUP_COMPRESSION:-zstd:3}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
RETENTION_MIN_COUNT="${BACKUP_RETENTION_MIN_COUNT:-3}"
COUNT_ROWS="${BACKUP_COUNT_ROWS:-true}"
VERIFY_MAX_AGE_HOURS="${BACKUP_VERIFY_MAX_AGE_HOURS:-48}"
INSTANCE="${BACKUP_INSTANCE:-lumina}"
WORK_ROOT="${BACKUP_WORK_DIR:-${TMPDIR:-/tmp}}"

log() {
  # One JSON object per line, like the services' own pino output, so the same
  # log pipeline can parse it.
  local level="$1"; shift
  printf '{"time":"%s","level":"%s","component":"lumina-backup","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$(printf '%s' "$*" | sed 's/\\/\\\\/g; s/"/\\"/g')" >&2
}

die() { log error "$*"; exit 1; }

require() {
  local name="$1"
  [ -n "${!name:-}" ] || die "$name must be set"
}

# Same contract as @lumina/shared's readSecret: NAME or NAME_FILE, never both,
# trailing newlines stripped. Prints the value.
read_secret() {
  local name="$1" file_var="${1}_FILE"
  local direct="${!name:-}" path="${!file_var:-}"
  if [ -n "$direct" ] && [ -n "$path" ]; then
    die "$name and $file_var are both set; set only one"
  fi
  if [ -n "$path" ]; then
    [ -r "$path" ] || die "$file_var points at $path, which cannot be read"
    local value
    value="$(cat "$path")"   # $(...) strips trailing newlines
    [ -n "$value" ] || die "$file_var points at $path, which is empty"
    printf '%s' "$value"
  else
    printf '%s' "$direct"
  fi
}

# Resolves the connection URL and, when a password file is configured, hands
# the password to libpq through a private pgpass file rather than the URL or
# PGPASSWORD — either of which would put it back in the process environment
# or argument list this tool exists to keep it out of.
setup_database_connection() {
  DB_URL="$(read_secret BACKUP_DATABASE_URL)"
  [ -n "$DB_URL" ] || die "BACKUP_DATABASE_URL or BACKUP_DATABASE_URL_FILE must be set"
  if [ -n "${BACKUP_DATABASE_PASSWORD_FILE:-}" ]; then
    [ -r "$BACKUP_DATABASE_PASSWORD_FILE" ] \
      || die "BACKUP_DATABASE_PASSWORD_FILE points at $BACKUP_DATABASE_PASSWORD_FILE, which cannot be read"
    local password
    password="$(cat "$BACKUP_DATABASE_PASSWORD_FILE")"
    [ -n "$password" ] || die "BACKUP_DATABASE_PASSWORD_FILE is empty"
    # pgpass escapes `\` and `:` with a backslash.
    password="${password//\\/\\\\}"
    password="${password//:/\\:}"
    export PGPASSFILE="$WORK_DIR/.pgpass"
    ( umask 077; printf '*:*:*:*:%s\n' "$password" > "$PGPASSFILE" )
  fi
}

# rclone treats a bare path as the local filesystem, so one code path serves a
# mounted volume and every object store rclone supports.
dest() { printf '%s/%s' "${BACKUP_DESTINATION%/}" "$1"; }

# ─── Metrics ────────────────────────────────────────────────────────────────

# Reports one run as gauges: `report_metrics <operation> <0|1> [name value]...`.
#
# On failure the last-success gauge is left out. A Pushgateway POST replaces
# only the metric names it is sent, and the textfile path carries the old line
# forward, so a failed run cannot erase the evidence of the last good one —
# which is the number the alerts are written against.
report_metrics() {
  local operation="$1" success="$2"; shift 2
  local now; now="$(date +%s)"
  local started="${RUN_STARTED:-$now}"
  local -a pairs=(
    lumina_backup_last_run_timestamp_seconds "$now"
    lumina_backup_last_run_success "$success"
    lumina_backup_duration_seconds "$(( now - started ))"
  )
  [ "$success" = 1 ] && pairs+=(lumina_backup_last_success_timestamp_seconds "$now")
  pairs+=("$@")
  REPORTED=1

  if [ -n "${PUSHGATEWAY_URL:-}" ]; then
    local body="" i
    for (( i = 0; i < ${#pairs[@]}; i += 2 )); do
      body+="# TYPE ${pairs[i]} gauge"$'\n'"${pairs[i]} ${pairs[i+1]}"$'\n'
    done
    printf '%s' "$body" | curl -fsS --max-time 10 --data-binary @- \
        "${PUSHGATEWAY_URL%/}/metrics/job/lumina_backup/instance/${INSTANCE}/operation/${operation}" \
      || log warn "could not push metrics to $PUSHGATEWAY_URL"
  fi

  if [ -n "${BACKUP_METRICS_FILE:-}" ]; then
    # node_exporter textfile collector. One file holds both operations, so the
    # other operation's lines are kept and each line carries its own labels.
    local labels="{instance=\"${INSTANCE}\",operation=\"${operation}\"}"
    local tmp="${BACKUP_METRICS_FILE}.tmp.$$"
    {
      if [ -f "$BACKUP_METRICS_FILE" ]; then
        grep -v "operation=\"${operation}\"" "$BACKUP_METRICS_FILE" || true
        [ "$success" = 1 ] || grep -F "lumina_backup_last_success_timestamp_seconds${labels}" "$BACKUP_METRICS_FILE" || true
      fi
      for (( i = 0; i < ${#pairs[@]}; i += 2 )); do
        printf '%s%s %s\n' "${pairs[i]}" "$labels" "${pairs[i+1]}"
      done
    } | sort > "$tmp" && mv "$tmp" "$BACKUP_METRICS_FILE"
  fi
}

# ─── Shared SQL ─────────────────────────────────────────────────────────────

# One row per user table — "<schema>.<table>|<rows>" — sorted, so a dump and a
# restore can be compared with a plain diff. Partitions are counted through
# their parent rather than twice.
ROW_COUNTS_QUERY="SELECT coalesce(string_agg(format(
    'SELECT %L || ''|'' || count(*) FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname),
    ' UNION ALL ' ORDER BY n.nspname, c.relname), 'SELECT NULL WHERE false')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'"

LEDGER_TIPS_SQL="SELECT network || '|' || count(*) || '|' || coalesce(max(sequence), 0)
  FROM ledgers GROUP BY network ORDER BY network;"

LEDGER_GAPS_SQL="SELECT count(*) FROM (
  SELECT sequence, lead(sequence) OVER (PARTITION BY network ORDER BY sequence) AS next
  FROM ledgers) t WHERE next > sequence + 1;"

# ─── backup ─────────────────────────────────────────────────────────────────

# Runs SQL in the snapshot-holding session and stores its output in the
# variable named by $1. The sentinel marks the end of the output, since the
# session stays open. Assigns rather than prints: a command substitution is a
# subshell, and bash does not hand a coprocess's descriptors to subshells.
session_query() {
  local -n _result="$1"
  printf '%s\n\\echo __LUMINA_END__\n' "$2" >&"${PSQL[1]}"
  _result=""
  local line
  while IFS= read -r line <&"${PSQL[0]}"; do
    if [ "$line" = "__LUMINA_END__" ]; then
      _result="${_result%$'\n'}"
      return 0
    fi
    _result+="$line"$'\n'
  done
  die "snapshot session ended unexpectedly: ${_result}"
}

cmd_backup() {
  require BACKUP_DESTINATION
  WORK_DIR="$(mktemp -d "$WORK_ROOT/lumina-backup.XXXXXX")"
  setup_database_connection

  local started="$RUN_STARTED"
  local stamp; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local name="${PREFIX}_${stamp}"
  local dump="$WORK_DIR/$name.dump"
  log info "starting backup $name"

  # Hold one REPEATABLE READ transaction open and export its snapshot: pg_dump
  # reads through that snapshot, and the manifest's row counts are taken in the
  # same transaction. So the counts describe exactly the rows in the dump, even
  # while the indexer keeps writing, and verify can demand equality rather than
  # "roughly the same".
  coproc PSQL { psql -X -q -A -t -v ON_ERROR_STOP=1 --dbname="$DB_URL" 2>&1; }
  # shellcheck disable=SC2034 # `ignored` is assigned by name in session_query
  local snapshot server_version tips counts="" ignored
  session_query snapshot 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();'
  [[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || die "could not export a snapshot: $snapshot"
  session_query server_version 'SHOW server_version;'
  session_query tips "$LEDGER_TIPS_SQL"
  if [ "$COUNT_ROWS" = true ]; then
    session_query counts "$ROW_COUNTS_QUERY"$'\n\\gexec'
    counts="$(sort <<< "$counts")"
  fi

  pg_dump --dbname="$DB_URL" --snapshot="$snapshot" \
    --format=custom --compress="$COMPRESSION" \
    --no-owner --no-privileges --file="$dump"
  session_query ignored 'COMMIT;'
  printf '\\q\n' >&"${PSQL[1]}"
  wait "$PSQL_PID" 2>/dev/null || true

  pg_restore --list "$dump" >/dev/null || die "pg_restore cannot read the archive just written"
  local sha; sha="$(sha256sum "$dump" | cut -d' ' -f1)"
  printf '%s  %s\n' "$sha" "$name.dump" > "$dump.sha256"
  local size; size="$(stat -c %s "$dump" 2>/dev/null || stat -f %z "$dump")"
  local dump_seconds=$(( $(date +%s) - started ))

  # The manifest is written last and uploaded last: its presence is what marks
  # a backup as complete, so a run that dies mid-upload leaves no manifest and
  # verify never picks it.
  {
    printf '{\n'
    printf '  "name": "%s",\n' "$name"
    printf '  "created_at": "%s",\n' "$(date -u -d "@$started" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$started" +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "server_version": "%s",\n' "$server_version"
    printf '  "pg_dump_version": "%s",\n' "$(pg_dump --version | awk '{print $NF}')"
    printf '  "format": "custom",\n'
    printf '  "compression": "%s",\n' "$COMPRESSION"
    printf '  "size_bytes": %s,\n' "$size"
    printf '  "sha256": "%s",\n' "$sha"
    printf '  "dump_seconds": %s,\n' "$dump_seconds"
    printf '  "ledgers": {'
    local first=1 network count max
    while IFS='|' read -r network count max; do
      [ -n "$network" ] || continue
      [ $first = 1 ] || printf ','
      printf '\n    "%s": {"rows": %s, "max_sequence": %s}' "$network" "$count" "$max"
      first=0
    done <<< "$tips"
    printf '\n  },\n'
    printf '  "row_counts": {'
    first=1
    local table rows
    while IFS='|' read -r table rows; do
      [ -n "$table" ] || continue
      [ $first = 1 ] || printf ','
      printf '\n    "%s": %s' "$table" "$rows"
      first=0
    done <<< "$counts"
    printf '\n  }\n}\n'
  } > "$WORK_DIR/$name.manifest.json"

  rclone copyto "$dump" "$(dest "$name.dump")"
  rclone copyto "$dump.sha256" "$(dest "$name.dump.sha256")"
  rclone copyto "$WORK_DIR/$name.manifest.json" "$(dest "$name.manifest.json")"

  prune

  local duration=$(( $(date +%s) - started ))
  report_metrics backup 1 lumina_backup_size_bytes "$size"
  log info "backup $name complete: $size bytes in ${duration}s (dump ${dump_seconds}s)"
}

# Deletes backups older than the retention window, but never the newest
# BACKUP_RETENTION_MIN_COUNT complete ones: if backups stop being taken, the
# last good ones must not age out from under the operator.
prune() {
  local cutoff now
  now="$(date -u +%s)"
  cutoff=$(( now - RETENTION_DAYS * 86400 ))
  local manifests
  manifests="$(rclone lsf --files-only --include "${PREFIX}_*.manifest.json" "${BACKUP_DESTINATION%/}/")"
  manifests="$(sort -r <<< "$manifests")"
  local index=0 manifest name stamp epoch
  while IFS= read -r manifest; do
    [ -n "$manifest" ] || continue
    index=$(( index + 1 ))
    [ "$index" -gt "$RETENTION_MIN_COUNT" ] || continue
    name="${manifest%.manifest.json}"
    stamp="${name#"${PREFIX}"_}"
    epoch="$(date -u -d "$(printf '%s-%s-%s %s:%s:%s' "${stamp:0:4}" "${stamp:4:2}" "${stamp:6:2}" "${stamp:9:2}" "${stamp:11:2}" "${stamp:13:2}")" +%s 2>/dev/null)" || continue
    if [ "$epoch" -lt "$cutoff" ]; then
      log info "pruning $name (older than ${RETENTION_DAYS} days)"
      # Manifest first, so a half-pruned backup is incomplete rather than
      # complete-looking with a missing dump.
      rclone deletefile "$(dest "$name.manifest.json")"
      rclone deletefile "$(dest "$name.dump.sha256")" || true
      rclone deletefile "$(dest "$name.dump")" || true
    fi
  done <<< "$manifests"
}

# ─── verify ─────────────────────────────────────────────────────────────────

json_field() {
  # The manifest is our own flat output, so a targeted sed is enough and keeps
  # jq out of the image.
  sed -n "s/^  \"$2\": \"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}$/\1/p" "$1" | head -1
}

manifest_section() {
  # Prints "<key>|<value>" for each entry of a manifest section.
  sed -n "/^  \"$2\": {/,/^  }/p" "$1" | sed -n 's/^    "\([^"]*\)": \(.*\)$/\1|\2/p' | sed 's/,$//'
}

stop_scratch_cluster() {
  if [ -n "${SCRATCH_PGDATA:-}" ] && [ -f "$SCRATCH_PGDATA/postmaster.pid" ]; then
    pg_ctl -D "$SCRATCH_PGDATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  # The socket dir may live outside WORK_DIR (see cmd_verify); clean it up here
  # so a pass or a failure leaves nothing behind.
  [ -n "${SOCKET_DIR:-}" ] && rm -rf "$SOCKET_DIR"
}

cmd_verify() {
  require BACKUP_DESTINATION
  WORK_DIR="$(mktemp -d "$WORK_ROOT/lumina-verify.XXXXXX")"

  local name="${BACKUP_VERIFY_NAME:-}"
  if [ -z "$name" ]; then
    name="$(rclone lsf --files-only --include "${PREFIX}_*.manifest.json" "${BACKUP_DESTINATION%/}/" || true)"
    name="$(sort <<< "$name" | tail -1)"
    name="${name%.manifest.json}"
  fi
  [ -n "$name" ] || die "no complete backup found at $BACKUP_DESTINATION"
  log info "verifying backup $name"

  rclone copyto "$(dest "$name.manifest.json")" "$WORK_DIR/$name.manifest.json"
  rclone copyto "$(dest "$name.dump.sha256")" "$WORK_DIR/$name.dump.sha256"
  local download_started; download_started="$(date +%s)"
  rclone copyto "$(dest "$name.dump")" "$WORK_DIR/$name.dump"
  local download_seconds=$(( $(date +%s) - download_started ))
  local manifest="$WORK_DIR/$name.manifest.json"

  local created; created="$(json_field "$manifest" created_at)"
  local created_epoch
  created_epoch="$(date -u -d "$(printf '%s' "$created" | sed 's/T/ /; s/Z$//')" +%s 2>/dev/null || date -u -j -f %Y-%m-%dT%H:%M:%SZ "$created" +%s)"
  local age_hours=$(( ($(date +%s) - created_epoch) / 3600 ))
  if [ "$age_hours" -gt "$VERIFY_MAX_AGE_HOURS" ]; then
    die "newest backup $name is ${age_hours}h old (limit ${VERIFY_MAX_AGE_HOURS}h): backups have stopped"
  fi

  (cd "$WORK_DIR" && sha256sum -c "$name.dump.sha256" >/dev/null) \
    || die "checksum mismatch for $name.dump"

  # A private, throwaway cluster: unix socket only, no network listener, and
  # durability switched off because it is deleted at the end either way.
  SCRATCH_PGDATA="$WORK_DIR/pgdata"
  # Postgres refuses a Unix socket path longer than 103 bytes, and $TMPDIR on
  # macOS plus a mktemp -d name is routinely longer than that, which would fail
  # the whole verification on a host where the container's short /work never
  # would. mktemp -d gives a path short enough under /tmp, falling back to the
  # work dir only if /tmp is not writable.
  local socket_dir
  socket_dir="$(mktemp -d "${TMPDIR:-/tmp}/lumina-sock.XXXXXX" 2>/dev/null)" \
    || socket_dir="$WORK_DIR/socket"
  mkdir -p "$socket_dir"
  SOCKET_DIR="$socket_dir"
  initdb -D "$SCRATCH_PGDATA" -U postgres --auth=trust --no-sync >/dev/null
  pg_ctl -D "$SCRATCH_PGDATA" -w -l "$WORK_DIR/postgres.log" \
    -o "-c listen_addresses='' -c unix_socket_directories='$socket_dir' -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_wal_size=4GB -c maintenance_work_mem=256MB" \
    start >/dev/null
  local target="postgresql:///lumina_verify?host=$socket_dir&user=postgres"
  createdb -h "$socket_dir" -U postgres lumina_verify

  local jobs="${BACKUP_RESTORE_JOBS:-$(nproc 2>/dev/null || echo 2)}"
  local restore_started; restore_started="$(date +%s)"
  pg_restore --dbname="$target" --jobs="$jobs" --no-owner --no-privileges --exit-on-error "$WORK_DIR/$name.dump" \
    || die "pg_restore failed for $name"
  local restore_seconds=$(( $(date +%s) - restore_started ))

  # The comparison that makes this a verification rather than a smoke test:
  # every table's row count in the restore must equal the count taken inside
  # the dump's own snapshot.
  local checks_started; checks_started="$(date +%s)"
  local expected_counts actual_counts
  expected_counts="$(manifest_section "$manifest" row_counts | sort)"
  if [ -n "$expected_counts" ]; then
    actual_counts="$(psql -X -q -A -t -v ON_ERROR_STOP=1 --dbname="$target" -c "$ROW_COUNTS_QUERY" \
      | psql -X -q -A -t -v ON_ERROR_STOP=1 --dbname="$target" | sort)"
    if [ "$expected_counts" != "$actual_counts" ]; then
      diff <(printf '%s\n' "$expected_counts") <(printf '%s\n' "$actual_counts") >&2 || true
      die "row counts in the restored database do not match the manifest"
    fi
  else
    log warn "manifest has no row counts (BACKUP_COUNT_ROWS=false); checking ledger tips only"
  fi

  local expected_tips actual_tips
  expected_tips="$(manifest_section "$manifest" ledgers | sed -E 's/^([^|]*)\|\{"rows": ([0-9]+), "max_sequence": ([0-9]+)\}$/\1|\2|\3/' | sort)"
  actual_tips="$(psql -X -q -A -t -v ON_ERROR_STOP=1 --dbname="$target" -c "$LEDGER_TIPS_SQL" | sort)"
  [ "$expected_tips" = "$actual_tips" ] \
    || die "ledger tips differ: expected [$expected_tips] got [$actual_tips]"

  # Gaps are reported, not failed on: a gap in the source is faithfully
  # reproduced by a correct backup. It is still worth knowing before a restore
  # is relied on, and docs/DISASTER_RECOVERY.md covers repairing one.
  local gaps; gaps="$(psql -X -q -A -t -v ON_ERROR_STOP=1 --dbname="$target" -c "$LEDGER_GAPS_SQL")"
  local checks_seconds=$(( $(date +%s) - checks_started ))
  local size; size="$(json_field "$manifest" size_bytes)"
  local duration=$(( $(date +%s) - RUN_STARTED ))

  report_metrics verify 1 \
    lumina_backup_verify_restore_seconds "$restore_seconds" \
    lumina_backup_verify_ledger_gaps "$gaps" \
    lumina_backup_verified_backup_timestamp_seconds "$created_epoch"
  log info "verified $name: ${size} bytes, download ${download_seconds}s, restore ${restore_seconds}s (jobs=$jobs), checks ${checks_seconds}s, total ${duration}s, ledger gaps ${gaps}"
}

# One exit path for both subcommands. Anything that ends the run early — a
# failed command under `set -e`, or `die` — lands here, so every failure is
# reported as a metric and never only as a log line nobody reads.
finish() {
  local status=$?
  set +e
  if [ "$status" -ne 0 ] && [ "$REPORTED" = 0 ] && [ -n "$OPERATION" ]; then
    log error "$OPERATION failed (exit $status)"
    report_metrics "$OPERATION" 0
  fi
  [ -n "${PSQL_PID:-}" ] && kill "$PSQL_PID" 2>/dev/null
  stop_scratch_cluster
  [ -n "${WORK_DIR:-}" ] && rm -rf "$WORK_DIR"
  exit "$status"
}

OPERATION=""
REPORTED=0
RUN_STARTED="$(date +%s)"
trap finish EXIT

case "${1:-}" in
  backup|verify)
    OPERATION="$1"
    "cmd_$1"
    ;;
  *)
    echo "usage: $0 backup|verify" >&2
    exit 64
    ;;
esac
