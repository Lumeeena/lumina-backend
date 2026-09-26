-- ─────────────────────────────────────────────────────────────────────────────
-- Least-privilege database roles.
--
-- Both services used to connect with the role that owns the schema, so a SQL
-- injection bug anywhere (or a compromised service container) could DROP TABLE
-- and take the database with it. The database is now split in three:
--
--   lumina_owner    owns every object; runs migrations; has no login of its own
--   lumina_graphql  reads only (SELECT + LISTEN) — the GraphQL server connects here
--   lumina_indexer  writes only the tables it indexes; cannot run DDL
--
-- Run once per environment as a superuser (creating roles and handing over
-- ownership needs superuser rights), and again after any migration that adds a
-- table — later runs work for the login that was granted lumina_owner:
--
--   psql "$ADMIN_DATABASE_URL" \
--     -v graphql_password="$LUMINA_GRAPHQL_PASSWORD" \
--     -v indexer_password="$LUMINA_INDEXER_PASSWORD" \
--     -f db/roles.sql
--
-- The file is idempotent. It fails loudly if a password is not supplied rather
-- than creating a role that cannot log in.
--
-- Every grant is listed explicitly, and new tables get SELECT and nothing else
-- (see ALTER DEFAULT PRIVILEGES at the end): adding an indexed table means
-- adding it to the allowlist below and re-running this file.
--
-- See docs/DATABASE_ROLES.md. After running this, run db/verify_roles.sql.
-- ─────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

-- Passwords are supplied by the operator; they are never stored in this file.
\if :{?graphql_password}
\else
\echo 'ERROR: db/roles.sql needs -v graphql_password=... (see docs/DATABASE_ROLES.md)'
DO $$ BEGIN RAISE EXCEPTION 'db/roles.sql: psql variable graphql_password is not set'; END $$;
\endif
\if :{?indexer_password}
\else
\echo 'ERROR: db/roles.sql needs -v indexer_password=... (see docs/DATABASE_ROLES.md)'
DO $$ BEGIN RAISE EXCEPTION 'db/roles.sql: psql variable indexer_password is not set'; END $$;
\endif

BEGIN;

-- ─── 1. Roles ────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lumina_owner') THEN
    -- A group role: the login that runs migrations is granted this, so object
    -- ownership never belongs to a role a service can log in as.
    CREATE ROLE lumina_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lumina_graphql') THEN
    CREATE ROLE lumina_graphql LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lumina_indexer') THEN
    CREATE ROLE lumina_indexer LOGIN;
  END IF;

  -- Guard rails: if a re-run would hand a service role the privileges this
  -- whole file exists to remove, stop instead of granting around them.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('lumina_graphql', 'lumina_indexer') AND rolsuper) THEN
    RAISE EXCEPTION 'a service role is a superuser';
  END IF;
  IF pg_has_role('lumina_graphql', 'lumina_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'lumina_graphql must not be a member of lumina_owner';
  END IF;
  IF pg_has_role('lumina_indexer', 'lumina_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'lumina_indexer must not be a member of lumina_owner';
  END IF;
END
$$;

-- NOINHERIT because the service roles are meant to have exactly the direct
-- grants below and nothing that arrives through a group membership.
ALTER ROLE lumina_graphql WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'graphql_password';
ALTER ROLE lumina_indexer WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'indexer_password';

-- ─── 2. Database and schema ──────────────────────────────────────────────────

DO $$
BEGIN
  -- PUBLIC holds CONNECT and TEMP on every database by default. Revoke both:
  -- the services do not need TEMP, and nobody should reach this database
  -- without an explicit grant.
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO lumina_owner, lumina_graphql, lumina_indexer',
    current_database()
  );
END
$$;

-- On PostgreSQL < 15, PUBLIC can CREATE in `public`. Keep USAGE for the two
-- service roles (they need it to resolve names) and nothing else.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO lumina_graphql, lumina_indexer;
REVOKE CREATE ON SCHEMA public FROM lumina_graphql, lumina_indexer;
GRANT ALL ON SCHEMA public TO lumina_owner;
ALTER SCHEMA public OWNER TO lumina_owner;

-- ─── 3. Ownership ────────────────────────────────────────────────────────────

-- Existing installs created their objects as the deployment's login role.
-- Move them under lumina_owner so that DDL always requires membership in it.
DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT c.relkind, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
      AND pg_get_userbyid(c.relowner) <> 'lumina_owner'
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO lumina_owner',
      CASE obj.relkind
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        ELSE 'TABLE'
      END,
      obj.relname
    );
  END LOOP;
END
$$;

-- ─── 4. lumina_graphql — read-only ───────────────────────────────────────────

-- Revoke before granting so a re-run also cleans up privileges granted by hand.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM lumina_graphql;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM lumina_graphql;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO lumina_graphql;

-- The GraphQL server also holds a dedicated LISTEN connection on the
-- `lumina_indexed` channel (graphql-server/src/pubsub.ts). LISTEN requires no
-- table privileges at all — CONNECT is enough — so nothing extra is granted
-- here to enable it.

-- ─── 5. lumina_indexer — scoped writes ───────────────────────────────────────

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM lumina_indexer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM lumina_indexer;
-- SERIAL columns on indexed tables call nextval().
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lumina_indexer;

-- Derived from the statements in indexer/src/db.ts — keep both in sync.
DO $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT * FROM (VALUES
      -- ON CONFLICT (sequence) DO NOTHING
      ('ledgers',          'SELECT'),
      ('ledgers',          'INSERT'),
      -- ON CONFLICT (hash) DO NOTHING
      ('transactions',     'SELECT'),
      ('transactions',     'INSERT'),
      -- ON CONFLICT (id) DO NOTHING
      ('operations',       'SELECT'),
      ('operations',       'INSERT'),
      -- ON CONFLICT (id) DO NOTHING
      ('contract_events',  'SELECT'),
      ('contract_events',  'INSERT'),
      -- ON CONFLICT (address) DO UPDATE
      ('accounts',         'SELECT'),
      ('accounts',         'INSERT'),
      ('accounts',         'UPDATE'),
      -- ON CONFLICT (event_id, event_name) DO UPDATE
      ('custom_events',    'SELECT'),
      ('custom_events',    'INSERT'),
      ('custom_events',    'UPDATE'),
      -- upsert, plus DELETE when a contract is removed from the registry
      ('contract_schemas', 'SELECT'),
      ('contract_schemas', 'INSERT'),
      ('contract_schemas', 'UPDATE'),
      ('contract_schemas', 'DELETE')
    ) AS grants(tbl, priv)
  LOOP
    -- Tolerate schema versions where a table does not exist yet.
    IF to_regclass(format('public.%I', g.tbl)) IS NOT NULL THEN
      EXECUTE format('GRANT %s ON TABLE public.%I TO lumina_indexer', g.priv, g.tbl);
    END IF;
  END LOOP;
END
$$;

-- ─── 6. Future objects ───────────────────────────────────────────────────────

-- Default-deny: tables created later by the owning role are readable by both
-- services and writable by neither until the allowlist above is extended.
ALTER DEFAULT PRIVILEGES FOR ROLE lumina_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO lumina_graphql;
ALTER DEFAULT PRIVILEGES FOR ROLE lumina_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO lumina_indexer;

COMMIT;

-- ─── 7. Verify ───────────────────────────────────────────────────────────────

-- db/verify_roles.sql asserts every claim this file makes:
--   psql "$ADMIN_DATABASE_URL" -f db/verify_roles.sql
