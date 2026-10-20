-- ─────────────────────────────────────────────────────────────────────────────
-- The backup role: enough to dump every table, and nothing else.
--
-- `pg_dump` needs to read every table, which neither service role can do —
-- `lumina_graphql` has SELECT on the tables it serves, `lumina_indexer` on the
-- tables it writes. Granting either of them more would widen a service's
-- blast radius to serve a scheduled job. So the backup job gets its own login,
-- with the read-only role PostgreSQL provides for exactly this:
--
--   lumina_backup   LOGIN, member of pg_read_all_data; no writes, no DDL
--
-- `pg_read_all_data` (PostgreSQL 14+) grants SELECT on every current and future
-- table, view and sequence, so a migration that adds a table does not silently
-- produce a backup that omits it. It is the one place where "read everything"
-- is the right grant rather than a red flag: the job's whole purpose is to copy
-- the database out.
--
-- Run once per environment as a superuser, after db/roles.sql:
--
--   psql "$ADMIN_DATABASE_URL" -v backup_password="$LUMINA_BACKUP_PASSWORD" \
--     -f db/backup/backup_role.sql
--
-- Then point the job at it: BACKUP_DATABASE_URL (with the password from
-- BACKUP_DATABASE_PASSWORD_FILE) in docs/BACKUPS.md.
--
-- Idempotent: safe to re-run. It fails loudly if the password is not supplied
-- rather than creating a role that cannot log in.
--
-- See docs/BACKUPS.md and docs/DATABASE_ROLES.md.
-- ─────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

\if :{?backup_password}
\else
\echo 'ERROR: db/backup/backup_role.sql needs -v backup_password=... (see docs/BACKUPS.md)'
DO $$ BEGIN RAISE EXCEPTION 'db/backup/backup_role.sql: psql variable backup_password is not set'; END $$;
\endif

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lumina_backup') THEN
    CREATE ROLE lumina_backup LOGIN;
  END IF;

  -- Guard rail: a backup role that could write is a role that could damage the
  -- thing it exists to protect.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lumina_backup' AND (rolsuper OR rolcreatedb OR rolcreaterole)) THEN
    RAISE EXCEPTION 'lumina_backup must not be a superuser or able to create databases or roles';
  END IF;
  IF pg_has_role('lumina_backup', 'lumina_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'lumina_backup must not be a member of lumina_owner';
  END IF;
END
$$;

-- NOINHERIT like the service roles: the only privileges that matter are the
-- ones granted directly below and in section 2.
ALTER ROLE lumina_backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'backup_password';

-- The database and schema the dump reads through. db/roles.sql revoked PUBLIC's
-- CONNECT, so this role needs an explicit grant.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO lumina_backup', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO lumina_backup;

-- A member of pg_read_all_data (INHERIT set for this membership alone, since
-- the attribute above is NOINHERIT) reads every table without holding object
-- ownership or any write privilege.
GRANT pg_read_all_data TO lumina_backup WITH INHERIT TRUE;

COMMIT;

-- ─── Verify ──────────────────────────────────────────────────────────────────
--
-- As an operator, confirm the shape rather than trusting the run:
--
--   psql "$ADMIN_DATABASE_URL" -c "\du lumina_backup"
--   -- expect: no Superuser, no Create DB, no Create role; member of pg_read_all_data
--
-- With the role's own credentials, all of these must fail:
--
--   psql "$BACKUP_DATABASE_URL" -c "CREATE TABLE should_fail(i int);"
--   psql "$BACKUP_DATABASE_URL" -c "INSERT INTO ledgers VALUES (…);"
--
-- And this must succeed:
--
--   psql "$BACKUP_DATABASE_URL" -c "SELECT count(*) FROM ledgers;"
