# Database Migration Rollback Guide

This guide documents the rollback mechanism for database migrations in Lumina, how down migrations are applied, and which migrations are irreversible.

---

## 1. Architecture & Down Migrations

Each reversible migration file `db/migrations/<version>.sql` has a companion down migration `db/migrations/<version>.down.sql`.

- **Up migrations**: Named `<version>.sql` (matching `/^\d+_[a-z0-9_-]+\.sql$/i`).
- **Down migrations**: Named `<version>.down.sql` (matching `/^\d+_[a-z0-9_-]+\.down\.sql$/i`).
- **Isolation**: The regex for up migrations ignores `.down.sql` files because of the secondary extension dot (`.`), preventing forward migration runners from applying down scripts accidentally.

### Applying Rollbacks Programmatically

In `graphql-server/src/migrations.ts`:

- `loadDownMigrations(directory?)`: Discovers and loads all `.down.sql` scripts into a `Map<string, Migration>`.
- `rollbackMigration(pool, targetVersion, directory?)`: Executes the down script for `targetVersion` inside an advisory lock (`pg_advisory_lock(74192061)`) and transaction block, removing the record from `schema_migrations`.
- `rollbackLastMigration(pool, directory?)`: Finds the most recently applied migration in `schema_migrations` and executes its rollback.

---

## 2. Irreversible Migrations

The following migrations are strictly **irreversible** in place and will be rejected by `rollbackMigration()`:

### 1. `001_init.sql`
- **Why Irreversible**: Creates the base schema (`ledgers`, `transactions`, `operations`, `accounts`, `contract_events`). Rolling it back requires dropping all core application tables, resulting in total data loss.
- **Recovery Strategy**: To reset from `001_init`, drop and recreate the PostgreSQL database instance or restore from a base snapshot backup.

### 2. `006_partition_operations.sql`
- **Why Irreversible**: Converted `operations` into a partitioned table by ledger sequence. Partitioning rewrote physical table storage. In PostgreSQL, converting partitioned tables back into an unpartitioned table with historical data requires moving data across temporary tables and rebuilding all constraints. This migration was subsequently superseded by `007_networks`.

### 3. `007_networks.sql`
- **Why Irreversible**: Overhauled primary keys, foreign keys, and unique indexes across every table to be composite over `(..., network)`. Backfilled existing data with `network = 'mainnet'`. Reverting this would drop multi-network chain isolation, destroy foreign keys pointing to parent ledgers/transactions, and drop any non-mainnet data that landed after multi-network support was introduced.

---

## 3. Reversible Migrations Catalog

| Migration | Down Script | Actions Performed on Rollback |
|---|---|---|
| `002_account_event_columns` | `002_account_event_columns.down.sql` | Drops `accounts.num_sponsored`, `accounts.num_sponsoring`, `contract_events.type`. |
| `003_custom_event_schemas` | `003_custom_event_schemas.down.sql` | Drops `custom_events` and `contract_schemas` tables. |
| `004_search_indexes` | `004_search_indexes.down.sql` | Drops trigram memo GIN index and asset filter expression indexes. |
| `005_api_keys` | `005_api_keys.down.sql` | Drops `api_keys` table. |
| `006_autovacuum` | `006_autovacuum.down.sql` | Resets autovacuum scale factors on `transactions` and `operations`. |
| `006_export_permissions` | `006_export_permissions.down.sql` | Drops `export_enabled` column from `api_keys`. |
| `007_drop_redundant_api_key_index` | `007_drop_redundant_api_key_index.down.sql` | Recreates `idx_api_keys_key_hash`. |
| `008_account_refresh_queue` | `008_account_refresh_queue.down.sql` | Drops `account_refresh_queue` table. |
| `008_accounts_listing_index` | `008_accounts_listing_index.down.sql` | Drops `idx_accounts_last_modified`. |
| `008_data_constraints` | `008_data_constraints.down.sql` | Drops all data-quality `CHECK` constraints on ledgers, transactions, operations, accounts, and events. |
| `008_retry_queue` | `008_retry_queue.down.sql` | Drops `ledger_retry_queue` table. |
| `009_contract_storage_entries` | `009_contract_storage_entries.down.sql` | Drops `contract_storage_entries` table. |
| `010_contract_storage_history` | `010_contract_storage_history.down.sql` | Drops `contract_storage_history` table. |
| `010_retention_prune_indexes` | `010_retention_prune_indexes.down.sql` | Drops `idx_custom_events_created_at`. |
| `010_transaction_filters` | `010_transaction_filters.down.sql` | Drops transaction pagination filter indexes. |
| `010_trustlines` | `010_trustlines.down.sql` | Drops `trustlines` table. |
| `011_assets` | `011_assets.down.sql` | Drops `assets` table. |
| `012_asset_volume_buckets` | `012_asset_volume_buckets.down.sql` | Drops `asset_volume_buckets` table and `bucket_hour()` function. |

---

## 4. Testing Rollback Against Populated Databases

When developing or modifying a migration:

1. **Populate & Migrate Up**:
   Run all up migrations and insert test fixtures covering all affected tables and columns.
2. **Execute Down Migration**:
   Run the corresponding `.down.sql` script (or `rollbackLastMigration(pool)`).
3. **Verify Integrity**:
   - Assert that existing core tables and unrelated data remain intact.
   - Assert that dropped columns, indexes, or tables are cleanly removed without leaving orphaned constraints or locks.
   - Assert that `schema_migrations` has the rolled-back version removed.
4. **Re-apply Up Migration**:
   Re-running `runMigrations()` must cleanly succeed from the rolled-back state.
