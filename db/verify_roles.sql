-- ─────────────────────────────────────────────────────────────────────────────
-- Assert that db/roles.sql is in effect.
--
--   psql "$DATABASE_URL" -f db/verify_roles.sql
--
-- Exits non-zero on the first violated claim (ON_ERROR_STOP + RAISE EXCEPTION),
-- so it is safe to run from CI or from a release checklist. It only reads the
-- catalogs, so any role that can connect may run it — it does not have to be
-- the superuser that provisioned the roles.
--
-- Every assertion here maps to one line of docs/DATABASE_ROLES.md.
-- ─────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

DO $$
DECLARE
  t text;
  -- Tables the indexer touches at all, and the extra privileges the statements
  -- in indexer/src/db.ts require on top of SELECT.
  indexed_tables text[] := ARRAY[
    'ledgers', 'transactions', 'operations',
    'accounts', 'contract_events', 'contract_schemas', 'custom_events'
  ];
  update_tables  text[] := ARRAY['accounts', 'contract_schemas', 'custom_events'];
BEGIN
  -- ── The GraphQL server cannot write ───────────────────────────────────────
  IF NOT has_database_privilege('lumina_graphql', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'lumina_graphql cannot connect to the database';
  END IF;
  IF has_database_privilege('lumina_graphql', current_database(), 'TEMP') THEN
    RAISE EXCEPTION 'lumina_graphql can create temporary tables';
  END IF;
  IF has_database_privilege('lumina_graphql', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'lumina_graphql can create schemas';
  END IF;
  IF has_schema_privilege('lumina_graphql', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'lumina_graphql can create objects in public';
  END IF;
  IF pg_has_role('lumina_graphql', 'lumina_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'lumina_graphql is a member of lumina_owner, so it can run DDL';
  END IF;

  FOREACH t IN ARRAY indexed_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'verify_roles: table % not present, skipping', t;
      CONTINUE;
    END IF;
    IF NOT has_table_privilege('lumina_graphql', format('public.%I', t), 'SELECT') THEN
      RAISE EXCEPTION 'lumina_graphql lost SELECT on %', t;
    END IF;
    IF has_table_privilege('lumina_graphql', format('public.%I', t), 'INSERT')
       OR has_table_privilege('lumina_graphql', format('public.%I', t), 'UPDATE')
       OR has_table_privilege('lumina_graphql', format('public.%I', t), 'DELETE')
       OR has_table_privilege('lumina_graphql', format('public.%I', t), 'TRUNCATE') THEN
      RAISE EXCEPTION 'lumina_graphql can write to %', t;
    END IF;
  END LOOP;

  -- ── The indexer cannot drop tables ────────────────────────────────────────
  IF pg_has_role('lumina_indexer', 'lumina_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'lumina_indexer is a member of lumina_owner, so it can run DDL';
  END IF;
  IF has_schema_privilege('lumina_indexer', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'lumina_indexer can create objects in public';
  END IF;
  IF has_database_privilege('lumina_indexer', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'lumina_indexer can create schemas';
  END IF;

  -- DROP TABLE needs ownership. Every object must belong to lumina_owner, and
  -- the indexer must not be a member of it (checked above).
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND pg_get_userbyid(c.relowner) <> 'lumina_owner'
  ) THEN
    RAISE EXCEPTION 'a table in public is not owned by lumina_owner';
  END IF;

  -- ── The indexer still works: DML exactly where it is needed ───────────────
  FOREACH t IN ARRAY indexed_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT has_table_privilege('lumina_indexer', format('public.%I', t), 'SELECT')
       OR NOT has_table_privilege('lumina_indexer', format('public.%I', t), 'INSERT') THEN
      RAISE EXCEPTION 'lumina_indexer lost SELECT/INSERT on %', t;
    END IF;
    IF has_table_privilege('lumina_indexer', format('public.%I', t), 'TRUNCATE') THEN
      RAISE EXCEPTION 'lumina_indexer can TRUNCATE %', t;
    END IF;
    IF has_table_privilege('lumina_indexer', format('public.%I', t), 'UPDATE')
       <> (t = ANY (update_tables)) THEN
      RAISE EXCEPTION 'lumina_indexer UPDATE on % does not match the allowlist', t;
    END IF;
    IF has_table_privilege('lumina_indexer', format('public.%I', t), 'DELETE')
       <> (t = 'contract_schemas') THEN
      RAISE EXCEPTION 'lumina_indexer DELETE on % does not match the allowlist', t;
    END IF;
  END LOOP;

  -- api_keys is written by the manage-keys CLI, which runs as the owning role.
  IF to_regclass('public.api_keys') IS NOT NULL THEN
    IF has_table_privilege('lumina_indexer', 'public.api_keys', 'INSERT')
       OR has_table_privilege('lumina_indexer', 'public.api_keys', 'UPDATE')
       OR has_table_privilege('lumina_indexer', 'public.api_keys', 'DELETE') THEN
      RAISE EXCEPTION 'lumina_indexer can write to api_keys';
    END IF;
  END IF;

  RAISE NOTICE 'verify_roles: least-privilege roles verified (% indexed tables checked)', array_length(indexed_tables, 1);
END
$$;
