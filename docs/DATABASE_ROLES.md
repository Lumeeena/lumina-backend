# Database Roles

Both services used to connect with the role that owns the schema, which meant a
SQL injection bug anywhere — or a compromised service container — could
`DROP TABLE` and take the database with it. The database is now split into
three roles, and each service holds only what it actually uses.

| Role | Login | Used by | Can do |
|---|---|---|---|
| `lumina_owner` | no | migrations (granted to the operator's login) | own and alter every object |
| `lumina_graphql` | yes | GraphQL server | `SELECT` on every table, `LISTEN` |
| `lumina_indexer` | yes | Indexer | scoped `SELECT`/`INSERT`/`UPDATE`/`DELETE` (see matrix) |

Neither service role is a member of `lumina_owner`, so neither can run DDL:
`DROP TABLE` requires ownership, and `CREATE TABLE` requires `CREATE` on the
schema. Neither has it.

## Grants

### `lumina_graphql` — read-only

| Privilege | Scope | Why |
|---|---|---|
| `CONNECT` | database | to connect at all |
| `USAGE` | schema `public` | resolve table names |
| `SELECT` | all tables in `public` | every resolver is a read; `api_keys` is read by the key lookup |
| `LISTEN` | `lumina_indexed` | `graphql-server/src/pubsub.ts`; `LISTEN` needs no table privileges, so nothing extra is granted for it |
| `SELECT` on later tables | via `ALTER DEFAULT PRIVILEGES` | stays working across migrations |

No `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE` anywhere. No `CREATE` on the
schema or the database either, which also means no temporary tables:
`db/roles.sql` revokes `TEMP` from `PUBLIC`.

### `lumina_indexer` — scoped writes

Derived from the statements in `indexer/src/db.ts`; keep the two in sync.

| Table | SELECT | INSERT | UPDATE | DELETE | Statement |
|---|---|---|---|---|---|
| `ledgers` | yes | yes | — | — | `INSERT … ON CONFLICT (sequence) DO NOTHING` |
| `transactions` | yes | yes | — | — | `INSERT … ON CONFLICT (hash) DO NOTHING` |
| `operations` | yes | yes | — | — | `INSERT … ON CONFLICT (id) DO NOTHING` |
| `contract_events` | yes | yes | — | — | `INSERT … ON CONFLICT (id) DO NOTHING` |
| `accounts` | yes | yes | yes | — | `INSERT … ON CONFLICT (address) DO UPDATE` |
| `custom_events` | yes | yes | yes | — | `INSERT … ON CONFLICT (event_id, event_name) DO UPDATE` |
| `contract_schemas` | yes | yes | yes | yes | upsert, plus `DELETE` when a contract leaves the registry |
| `api_keys`, `schema_migrations` | — | — | — | — | never touched by the indexer |

`USAGE, SELECT` on sequences is granted as well, so `SERIAL` columns on indexed
tables keep working. No `TRUNCATE`, no `REFERENCES`, no `TRIGGER`, no `CREATE`.

## Provisioning

`db/roles.sql` creates the three roles and every grant above. It is idempotent,
and passwords never live in the file:

```bash
psql "$ADMIN_DATABASE_URL" \
  -v graphql_password="$LUMINA_GRAPHQL_PASSWORD" \
  -v indexer_password="$LUMINA_INDEXER_PASSWORD" \
  -f db/roles.sql
```

Run it as a superuser the first time: creating roles and reassigning object
ownership both require superuser rights. Re-runs (after a migration, say) work
for the login that was granted `lumina_owner`. It will:

1. create `lumina_owner` (no login), `lumina_graphql`, `lumina_indexer`;
2. `REVOKE ALL ON DATABASE … FROM PUBLIC`, then grant `CONNECT` back to the
   three roles — nothing else can reach the database;
3. revoke `PUBLIC`'s privileges on `public` (including `CREATE` on PostgreSQL
   before 15);
4. reassign existing tables, views, and sequences to `lumina_owner`;
5. apply the grants above, and default-deny on tables created later.

`lumina_owner` has no login of its own: hand it to the login that runs
migrations, and to nobody else.

```sql
GRANT lumina_owner TO <migration-login>;
```

### Re-run after migrations

A table created by `lumina_owner` afterwards is readable by both service roles
and writable by neither. A migration that adds a table the indexer writes must
add it to the allowlist in `db/roles.sql` and re-run that file. Defaulting to
deny is the point: the indexer fails loudly with `permission denied` instead of
quietly acquiring write access nobody reviewed.

## Verification

`db/verify_roles.sql` asserts every claim on this page with
`has_table_privilege`, `has_schema_privilege`, `has_database_privilege`, and
`pg_has_role`, and exits non-zero on the first violation. It needs nothing
beyond `CONNECT`, so it can run as either service role:

```bash
psql "$DATABASE_URL" -f db/verify_roles.sql
```

## Which role each entry point uses

| Entry point | Role | Why |
|---|---|---|
| `psql -f db/schema.sql`, `db/migrations/*.sql` | `lumina_owner` member | DDL |
| `npm run manage-keys -- …` | `lumina_owner` member | writes to `api_keys` |
| indexer integration tests (`TEST_DATABASE_URL`) | `lumina_owner` member | truncate/reseed tables |
| GraphQL server (`DATABASE_URL`) | `lumina_graphql` | reads only |
| Indexer (`DATABASE_URL`) | `lumina_indexer` | scoped writes |

`manage-keys` is an operator CLI, not part of the running server: the GraphQL
server itself never writes to `api_keys`, which is exactly why it can run
read-only.

## Docker Compose (development)

`docker/docker-compose.yml` applies `db/roles.sql` during first-time
initialization (`docker/initdb/03_roles.sh`, using throwaway development
passwords) and points each service at its role:

```
indexer:  postgresql://lumina_indexer:lumina_indexer_dev@postgres:5432/lumina
graphql:  postgresql://lumina_graphql:lumina_graphql_dev@postgres:5432/lumina
```

Set `LUMINA_GRAPHQL_PASSWORD` / `LUMINA_INDEXER_PASSWORD` before the first
`docker compose up` to use different development passwords. Init scripts only
run against an empty `postgres_data` volume — on an existing volume, run
`db/roles.sql` and `db/verify_roles.sql` by hand.

## Rotating passwords

Re-run `db/roles.sql` with the new `-v …_password` values (it is idempotent), or
`ALTER ROLE lumina_graphql WITH PASSWORD '…'` directly, then update the
service's `DATABASE_URL`.
