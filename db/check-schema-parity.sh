#!/usr/bin/env bash
# Compares the consolidated schema (db/schema.sql) against the full
# migration chain (db/migrations/*.sql) and fails with a readable diff
# on any divergence.
#
# Usage: db/check-schema-parity.sh
# Env:   PARITY_BASE_URL — superuser-ish connection for CREATE DATABASE
#        (default: postgresql://lumina:lumina_test@localhost:5432/postgres)
set -euo pipefail

BASE_URL="${PARITY_BASE_URL:-postgresql://lumina:lumina_test@localhost:5432/postgres}"
SCHEMA_DB="parity_schema"
MIGRATED_DB="parity_migrated"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Normalizes a pg_dump --schema-only file so formatting noise never
# triggers a false positive: header comments, blank lines, SET
# directives, and the per-dump \restrict/\unrestrict tokens.
normalize() {
  grep -v \
    -e '^--' \
    -e '^$' \
    -e '^[[:space:]]*$' \
    -e '^SET ' \
    -e '^SELECT pg_catalog.set_config' \
    -e '^\\restrict' \
    -e '^\\unrestrict' \
    "$1"
}

psql -v ON_ERROR_STOP=1 -d "$BASE_URL" -qc "DROP DATABASE IF EXISTS $SCHEMA_DB;"
psql -v ON_ERROR_STOP=1 -d "$BASE_URL" -qc "DROP DATABASE IF EXISTS $MIGRATED_DB;"
psql -v ON_ERROR_STOP=1 -d "$BASE_URL" -qc "CREATE DATABASE $SCHEMA_DB;"
psql -v ON_ERROR_STOP=1 -d "$BASE_URL" -qc "CREATE DATABASE $MIGRATED_DB;"

SCHEMA_URL="${BASE_URL%/postgres}/$SCHEMA_DB"
MIGRATED_URL="${BASE_URL%/postgres}/$MIGRATED_DB"

psql -v ON_ERROR_STOP=1 -d "$SCHEMA_URL" -f db/schema.sql > /dev/null

for migration in db/migrations/*.sql; do
  echo "Applying $migration..."
  psql -v ON_ERROR_STOP=1 -d "$MIGRATED_URL" -f "$migration" > /dev/null
done

DUMP_FLAGS="--schema-only --no-owner --no-privileges --exclude-table=schema_migrations"
# shellcheck disable=SC2086
pg_dump -d "$SCHEMA_URL" $DUMP_FLAGS > "$TMPDIR/schema.sql"
# shellcheck disable=SC2086
pg_dump -d "$MIGRATED_URL" $DUMP_FLAGS > "$TMPDIR/migrated.sql"

normalize "$TMPDIR/schema.sql" > "$TMPDIR/schema.norm"
normalize "$TMPDIR/migrated.sql" > "$TMPDIR/migrated.norm"

if diff -u "$TMPDIR/schema.norm" "$TMPDIR/migrated.norm" > "$TMPDIR/parity.diff"; then
  echo "Schema parity check passed: db/schema.sql matches db/migrations/*.sql."
else
  echo "Schema drift detected: db/schema.sql differs from db/migrations/*.sql." >&2
  echo "Apply the missing change to the other side, then re-run this check." >&2
  cat "$TMPDIR/parity.diff" >&2
  exit 1
fi
