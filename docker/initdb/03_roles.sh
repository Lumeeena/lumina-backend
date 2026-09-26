#!/bin/sh
# Applies ../db/roles.sql during Docker Compose first-time initialization.
#
# The postgres image runs docker-entrypoint-initdb.d/*.sql with psql and no
# variables, and db/roles.sql deliberately refuses to run without the two
# passwords — so this wrapper passes them. It is named 03_* so it runs after
# 01_schema.sql and 02_seed.sql: seeding happens while the bootstrap user still
# owns the tables, and ownership then moves to lumina_owner.
#
# These are development credentials, hard-coded so `docker compose up` needs no
# setup. Production passes real passwords on the command line instead; see
# docs/DATABASE_ROLES.md.
set -e

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v "graphql_password=${LUMINA_GRAPHQL_PASSWORD:-lumina_graphql_dev}" \
  -v "indexer_password=${LUMINA_INDEXER_PASSWORD:-lumina_indexer_dev}" \
  -f /opt/lumina/db/roles.sql

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -f /opt/lumina/db/verify_roles.sql
