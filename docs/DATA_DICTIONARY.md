# Lumina Database Data Dictionary

This document is the authoritative data dictionary for the Lumina PostgreSQL database schema (`db/schema.sql`). It details every table, column, data type, nullability, default value, physical unit, origin (e.g. Horizon raw vs. internal), and semantic meaning.

> **Drift Prevention Notice**:
> This dictionary is protected against drift by an automated schema validation check (`db/check-data-dictionary.ts`). CI executes `npm run check:data-dictionary` to guarantee every table and column in `db/schema.sql` matches this specification.

---

## Units & Conventions

### Stroops vs. Lumens
- **Stroop**: The smallest atomic unit of XLM (1 Lumen = $10^7$ or 10,000,000 stroops; $1\text{ stroop} = 0.0000001\text{ XLM}$).
  - Standard base fees (`ledgers.base_fee`), base reserves (`ledgers.base_reserve`), and transaction fees (`transactions.fee_charged`) are stored as **integer stroops (`BIGINT`)**.
- **Lumens & Asset Units**:
  - In `operations.details`, `trustlines.balance`, and analytical tables (`liquidity_pools`, `claimable_balances`, `path_payments`, `asset_volume_buckets`), amounts are represented as decimal strings or `NUMERIC(20, 7)` with 7 fractional digits (e.g., `'10.5000000'`), reflecting Stellar's fixed 7-decimal currency convention.

### Addresses and Keys
- **Stellar Classic Addresses**: Base32 encoded ed25519 public keys starting with `G` (e.g. `G...`, 56 characters).
- **Soroban Contract Addresses**: Base32 encoded contract IDs starting with `C` (e.g. `C...`, 56 characters).
- **Hashes**: 64-character lowercase hex strings (e.g., SHA-256 transaction hashes, pool IDs).

### Timestamps
- All timestamps (`TIMESTAMPTZ`) are stored and returned in **UTC** (ISO 8601).

---

## Table of Contents
1. [schema_migrations](#1-schema_migrations)
2. [ledgers](#2-ledgers)
3. [transactions](#3-transactions)
4. [operations](#4-operations)
5. [accounts](#5-accounts)
6. [account_refresh_queue](#6-account_refresh_queue)
7. [contract_events](#7-contract_events)
8. [contract_schemas](#8-contract_schemas)
9. [custom_events](#9-custom_events)
10. [contract_storage_entries](#10-contract_storage_entries)
11. [trustlines](#11-trustlines)
12. [assets](#12-assets)
13. [asset_volume_buckets](#13-asset_volume_buckets)
14. [api_keys](#14-api_keys)
15. [ledger_retry_queue](#15-ledger_retry_queue)
16. [failed_ledgers](#16-failed_ledgers)
17. [liquidity_pools](#17-liquidity_pools)
18. [liquidity_pool_shares](#18-liquidity_pool_shares)
19. [claimable_balances](#19-claimable_balances)
20. [claimable_balance_claimants](#20-claimable_balance_claimants)
21. [path_payments](#21-path_payments)
22. [path_payment_hops](#22-path_payment_hops)
23. [account_signer_changes](#23-account_signer_changes)
24. [account_threshold_changes](#24-account_threshold_changes)
25. [account_state_history](#25-account_state_history)

---

### 1. `schema_migrations`
Bookkeeping table tracking executed database migration files.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `version` | `TEXT` | No (PK) | None | Migration name | Internal | Unique migration version identifier (e.g. `001_initial_schema.sql`). |
| `applied_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Wall-clock timestamp when the migration was applied. |

---

### 2. `ledgers`
Header record for every ingested Stellar ledger.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `sequence` | `BIGINT` | No (PK) | None | Ledger sequence counter | Horizon (`sequence`) | Monotonically increasing sequence number identifying the ledger. |
| `closed_at` | `TIMESTAMPTZ` | No | None | ISO 8601 UTC | Horizon (`closed_at`) | On-chain closing timestamp agreed upon by Stellar Consensus Protocol (SCP). |
| `transaction_count` | `INTEGER` | No | `0` | Integer count | Horizon (`transaction_count`) | Number of transactions successfully included in the ledger. |
| `operation_count` | `INTEGER` | No | `0` | Integer count | Horizon (`operation_count`) | Total number of individual operations across all transactions in the ledger. |
| `base_fee` | `BIGINT` | No | `100` | Stroops ($10^{-7}$ XLM) | Horizon (`base_fee_in_stroops`) | Minimum fee per operation required for ledger inclusion. |
| `base_reserve` | `BIGINT` | No | `5000000` | Stroops ($10^{-7}$ XLM) | Horizon (`base_reserve_in_stroops`)| Minimum account balance reserve required per entry (typically 0.5 XLM = 5,000,000 stroops). |
| `indexed_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Ingestion timestamp when the indexer wrote the ledger row. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier (e.g. `'mainnet'`, `'testnet'`). |

---

### 3. `transactions`
Executed transaction records.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `hash` | `TEXT` | No (PK) | None | 64-char Hex SHA-256 | Horizon (`hash`) | Canonical transaction hash identifier. |
| `ledger` | `BIGINT` | No (FK) | None | Ledger sequence | Horizon (`ledger`) | Sequence number of the ledger containing this transaction. |
| `created_at` | `TIMESTAMPTZ` | No | None | ISO 8601 UTC | Horizon (`created_at`) | Ledger close timestamp when transaction was executed. |
| `source_account` | `TEXT` | No | None | Stellar address (`G...`) | Horizon (`source_account`) | Account that submitted the transaction and paid the fee. |
| `fee_charged` | `BIGINT` | No | None | Stroops ($10^{-7}$ XLM) | Horizon (`fee_charged`) | Actual transaction fee deducted from `source_account`. |
| `operation_count` | `SMALLINT` | No | None | Integer count | Horizon (`operation_count`) | Number of operations bundled inside this transaction envelope. |
| `successful` | `BOOLEAN` | No | None | Boolean | Horizon (`successful`) | Whether the transaction executed successfully (`true`) or failed (`false`). |
| `memo_type` | `TEXT` | Yes | None | Text | Horizon (`memo_type`) | Type of memo (`'text'`, `'id'`, `'hash'`, `'return'`, `'none'`). |
| `memo` | `TEXT` | Yes | None | Raw text or base64 | Horizon (`memo`) | Optional memo payload attached to the transaction. |
| `indexed_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Ingestion timestamp when the transaction was written. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 4. `operations`
Individual operation units executed within transactions.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `id` | `TEXT` | No (PK) | None | 64-bit Integer string | Horizon (`id`) | Unique global operation identifier generated by Horizon. |
| `type` | `TEXT` | No | None | Operation type string | Horizon (`type`) | Standard operation type (e.g. `'payment'`, `'create_account'`, `'manage_buy_offer'`). |
| `transaction_hash` | `TEXT` | No (FK) | None | 64-char Hex SHA-256 | Horizon (`transaction_hash`) | Hash of the parent transaction containing this operation. |
| `ledger` | `BIGINT` | No | None | Ledger sequence | Horizon / Inferred | Sequence number of the containing ledger. |
| `created_at` | `TIMESTAMPTZ` | No | None | ISO 8601 UTC | Horizon (`created_at`) | Ledger close timestamp. |
| `source_account` | `TEXT` | No | None | Stellar address (`G...`) | Horizon (`source_account`) | Account executing the operation (defaults to transaction source if unspecified). |
| `details` | `JSONB` | No | `'{}'` | JSONB object | Horizon payload | Type-specific operation parameters (amounts in decimal Lumens/asset units). |
| `indexed_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Ingestion timestamp when the operation was written. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 5. `accounts`
Current on-chain state snapshot for Stellar accounts.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `address` | `TEXT` | No (PK) | None | Stellar address (`G...`) | Horizon (`account_id`) | Stellar account public address. |
| `sequence` | `TEXT` | No | None | String Integer | Horizon (`sequence`) | Current account transaction sequence number counter. |
| `subentry_count` | `INTEGER` | No | `0` | Integer count | Horizon (`subentry_count`) | Count of active trustlines, offers, and signer subentries. |
| `last_modified_ledger` | `BIGINT` | No | None | Ledger sequence | Horizon (`last_modified_ledger`)| Ledger sequence where account was last updated. |
| `num_sponsored` | `INTEGER` | No | `0` | Integer count | Horizon (`num_sponsored`) | Number of subentries this account is sponsoring reserves for. |
| `num_sponsoring` | `INTEGER` | No | `0` | Integer count | Horizon (`num_sponsoring`) | Number of sponsors subsidizing this account. |
| `balances` | `JSONB` | No | `'[]'` | JSONB Array | Horizon (`balances`) | Array of asset balances held by the account (amounts as decimal strings). |
| `flags` | `JSONB` | No | `'{}'` | JSONB Object | Horizon (`flags`) | Account authorization flags (`auth_required`, `auth_revocable`, etc.). |
| `thresholds` | `JSONB` | No | `'{}'` | JSONB Object | Horizon (`thresholds`) | Operation security weight thresholds (`low_threshold`, `med_threshold`, `high_threshold`). |
| `indexed_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Initial insertion timestamp into Lumina. |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp of most recent state refresh. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 6. `account_refresh_queue`
Outbox queue tracking accounts pending background state synchronization from Horizon.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `network` | `TEXT` | No (PK) | None | Text name | Internal | Network identifier. |
| `address` | `TEXT` | No (PK) | None | Stellar address (`G...`) | Internal | Account address requiring an update from Horizon. |
| `last_requested_ledger` | `BIGINT` | No | None | Ledger sequence | Internal | Ledger sequence that triggered the refresh request. |
| `queued_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp when address was enqueued. |

---

### 7. `contract_events`
Soroban smart contract event log stream.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `id` | `TEXT` | No (PK) | None | Event ID string | Soroban RPC (`id`) | Unique event identifier (e.g. `<ledger>-<index>`). |
| `type` | `TEXT` | No | `'contract'`| Event type | Soroban RPC (`type`) | Event origin type (`'contract'`, `'system'`, `'diagnostic'`). |
| `contract_id` | `TEXT` | No | None | Contract address (`C...`)| Soroban RPC (`contractId`)| Address of contract that emitted the event. |
| `ledger` | `BIGINT` | No | None | Ledger sequence | Soroban RPC (`ledger`) | Sequence number of the ledger containing the event. |
| `created_at` | `TIMESTAMPTZ` | No | None | ISO 8601 UTC | Soroban RPC (`ledgerClosedAt`)| Ledger close timestamp. |
| `paging_token` | `TEXT` | No | None | String token | Soroban RPC (`pagingToken`)| Opaque paging token for cursor traversal. |
| `topics` | `TEXT[]` | No | `'{}'` | Base64 ScVal array | Soroban RPC (`topic`) | Array of raw base64-encoded ScVal topic elements. |
| `value` | `JSONB` | Yes | None | JSONB Object | Soroban RPC (`value`) | Decoded or raw JSON representation of event value payload. |
| `indexed_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Ingestion timestamp. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 8. `contract_schemas`
Registry of custom decoding schemas for Soroban smart contracts.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `contract_id` | `TEXT` | No (PK) | None | Contract address (`C...`)| User Registration | Target contract identifier. |
| `version` | `INTEGER` | No | `1` | Integer counter | User Registration | Schema definition version. |
| `definition` | `JSONB` | No | None | JSON Schema | User Registration | Complete decoding schema describing event topics and parameters. |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp schema was registered. |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp schema was updated. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 9. `custom_events`
Soroban contract events decoded into structured key-value fields via `contract_schemas`.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `event_id` | `TEXT` | No (PK) | None | Event ID string | `contract_events.id` | Reference to parent event. |
| `contract_id` | `TEXT` | No | None | Contract address (`C...`)| Soroban RPC | Emitting contract address. |
| `event_name` | `TEXT` | No (PK) | None | Event name identifier | Schema decoded | Human-readable event name (e.g. `'transfer'`, `'mint'`). |
| `ledger` | `BIGINT` | No | None | Ledger sequence | Soroban RPC | Ledger sequence containing the event. |
| `created_at` | `TIMESTAMPTZ` | No | None | ISO 8601 UTC | Soroban RPC | Ledger close timestamp. |
| `schema_version` | `INTEGER` | No | None | Integer counter | Schema decoded | Schema version applied during decoding. |
| `fields` | `JSONB` | No | `'{}'` | JSONB Object | Schema decoded | Structured key-value dictionary of decoded event attributes. |
| `indexed_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Ingestion timestamp. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 10. `contract_storage_entries`
Soroban ledger storage entries tracked for state and archival detection.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `contract_id` | `TEXT` | No (PK) | None | Contract address (`C...`)| Soroban RPC | Contract owning the storage entry. |
| `key` | `TEXT` | No (PK) | None | Base64 XDR | Soroban RPC (`key`) | Base64-encoded `LedgerKey` XDR string. |
| `durability` | `TEXT` | No | None | String enum | Soroban RPC (`durability`)| Storage durability: `'persistent'` or `'temporary'`. |
| `state` | `TEXT` | No | `'active'` | String enum | Internal detection | Lifecycle state: `'active'` or `'archived'`. |
| `value` | `JSONB` | Yes | None | JSONB Object | Soroban RPC / Decoded | Decoded native representation of storage value. |
| `value_xdr` | `TEXT` | Yes | None | Base64 XDR | Soroban RPC (`xdr`) | Raw `LedgerEntryData` XDR string. |
| `live_until_ledger` | `BIGINT` | Yes | None | Ledger sequence | Soroban RPC (`liveUntilLedgerSeq`)| Expiration ledger sequence for TTL eviction. |
| `last_modified_ledger`| `BIGINT` | No | None | Ledger sequence | Soroban RPC (`lastModifiedLedgerSeq`)| Ledger sequence where entry was last modified. |
| `indexed_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Ingestion timestamp. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 11. `trustlines`
Asset trustline relationships between accounts and non-native assets.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `account` | `TEXT` | No (PK) | None | Stellar address (`G...`) | Horizon (`account_id`) | Account holding the trustline. |
| `asset_code` | `TEXT` | No (PK) | None | 1-12 char alphanumeric | Horizon (`asset_code`) | Asset code (e.g. `'USDC'`). |
| `asset_issuer` | `TEXT` | No (PK) | None | Stellar address (`G...`) | Horizon (`asset_issuer`) | Issuing account address. |
| `trust_limit` | `TEXT` | No | `'922337203685.4775807'`| Decimal string (units) | Horizon (`limit`) | Maximum balance authorized for this trustline. |
| `balance` | `TEXT` | No | `'0'` | Decimal string (units) | Horizon (`balance`) | Current asset balance held by account. |
| `authorized` | `BOOLEAN` | No | `TRUE` | Boolean | Horizon (`authorized`) | Whether trustline is authorized by the issuer. |
| `last_modified_ledger`| `BIGINT` | No | None | Ledger sequence | Horizon (`last_modified_ledger`)| Ledger sequence of last trustline mutation. |
| `created_at` | `TIMESTAMPTZ` | No | None | ISO 8601 UTC | Horizon / Inferred | Creation timestamp. |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp of most recent update in database. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 12. `assets`
Registry and aggregate metrics for distinct issued assets.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `asset_code` | `TEXT` | No (PK) | None | 1-12 char alphanumeric | Horizon | Asset code (e.g. `'USDC'`). |
| `asset_issuer` | `TEXT` | No (PK) | None | Stellar address (`G...`) | Horizon | Issuing account address. |
| `holder_count` | `INTEGER` | No | `0` | Integer count | Internal aggregation | Number of unique accounts holding positive balance. |
| `first_seen_ledger` | `BIGINT` | No | None | Ledger sequence | Internal | Ledger sequence when the asset was first encountered. |
| `last_activity_ledger`| `BIGINT` | No | None | Ledger sequence | Internal | Ledger sequence of most recent payment/trade involving this asset. |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp asset was recorded. |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp metrics were updated. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 13. `asset_volume_buckets`
Hourly rolling trading and payment volume aggregates per asset.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `asset_code` | `TEXT` | No (PK) | None | 1-12 char alphanumeric | Internal | Asset code. |
| `asset_issuer` | `TEXT` | No (PK) | None | Stellar address (`G...`) | Internal | Asset issuer address. |
| `bucket_time` | `TIMESTAMPTZ` | No (PK) | None | ISO 8601 UTC (Hour bucket)| Internal (`date_trunc('hour', ...)`) | Beginning timestamp of the hourly window. |
| `volume` | `NUMERIC(20, 7)`| No | `0` | Asset units ($10^{-7}$ precision)| Internal aggregation | Aggregate volume transferred or traded within this hour. |
| `operation_count` | `INTEGER` | No | `0` | Integer count | Internal aggregation | Total payment and trade operations in this bucket. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 14. `api_keys`
Access control and rate-limiting keys for downstream API and export consumers.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | No (PK) | Auto-inc | Integer ID | Internal | Primary key identifier. |
| `key_hash` | `TEXT` | No (Unique)| None | 64-char Hex SHA-256 | Internal | Hash of secret API key used for authentication. |
| `key_prefix` | `TEXT` | No | None | 8-character string | Internal | Key prefix exposed in UI for identification. |
| `label` | `TEXT` | No | None | Text | User assigned | Descriptive name of API consumer. |
| `rate_limit` | `INTEGER` | No | `60` | Requests / Minute | User assigned | Maximum allowed request rate. |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Key creation timestamp. |
| `revoked_at` | `TIMESTAMPTZ` | Yes | None | ISO 8601 UTC | Internal | Revocation timestamp if deactivated. |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Last update timestamp. |
| `export_enabled` | `BOOLEAN` | No | `FALSE` | Boolean | Internal | Whether key has access to bulk export routes. |

---

### 15. `ledger_retry_queue`
Durable queue of failed ledgers processed by the background `RetryWorker`.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `ledger` | `BIGINT` | No (PK) | None | Ledger sequence | Internal | Sequence number of ledger that failed ingestion. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |
| `attempt_count` | `INTEGER` | No | `0` | Integer count | Internal | Retry attempts executed. |
| `next_attempt_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Earliest timestamp for next retry attempt. |
| `last_error` | `TEXT` | Yes | None | Error string | Internal | Error message captured on last attempt. |
| `first_failed_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp when ledger first failed. |
| `last_attempted_at`| `TIMESTAMPTZ` | Yes | None | ISO 8601 UTC | Internal | Timestamp of most recent retry attempt. |
| `permanently_failed`| `BOOLEAN` | No | `FALSE` | Boolean | Internal | Set to `true` when retry count exceeds threshold (10 attempts). |

---

### 16. `failed_ledgers`
Audit table recording ledgers that failed inline ingestion attempts.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `sequence` | `BIGINT` | No (PK) | None | Ledger sequence | Internal | Sequence number of failed ledger. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |
| `error` | `TEXT` | Yes | None | Error string | Internal | Diagnostic error message from inline failure. |
| `attempt_count` | `INTEGER` | No | `1` | Integer count | Internal | Inline attempts executed before cursor skipped. |
| `failed_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp failure was recorded. |

---

### 17. `liquidity_pools`
Automated Market Maker (AMM) liquidity pool state.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `pool_id` | `TEXT` | No (PK) | None | 64-char Hex SHA-256 | Horizon (`id`) | Canonical pool identifier. |
| `asset_a` | `TEXT` | No | None | Asset string (`native` or `CODE:ISSUER`) | Horizon (`reserves[0].asset`) | First asset in pool pair. |
| `asset_b` | `TEXT` | No | None | Asset string | Horizon (`reserves[1].asset`) | Second asset in pool pair. |
| `fee_bp` | `INTEGER` | No | `30` | Basis Points (0.01%) | Horizon (`fee_bp`) | Trading fee (e.g. 30 = 0.30%). |
| `reserve_a` | `NUMERIC(20, 7)`| No | `0` | Asset A units ($10^{-7}$) | Horizon (`reserves[0].amount`)| Current balance of asset A held by pool. |
| `reserve_b` | `NUMERIC(20, 7)`| No | `0` | Asset B units ($10^{-7}$) | Horizon (`reserves[1].amount`)| Current balance of asset B held by pool. |
| `total_shares` | `NUMERIC(20, 7)`| No | `0` | Share units ($10^{-7}$) | Horizon (`total_shares`) | Total circulating pool liquidity share tokens. |
| `last_ledger` | `BIGINT` | No | `0` | Ledger sequence | Horizon | Ledger sequence of last reserve change. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp record was updated. |

---

### 18. `liquidity_pool_shares`
Individual account holdings of liquidity pool share tokens.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `pool_id` | `TEXT` | No (PK) | None | 64-char Hex SHA-256 | Horizon | Reference to liquidity pool. |
| `account` | `TEXT` | No (PK) | None | Stellar address (`G...`) | Horizon | Account owning the pool share tokens. |
| `shares` | `NUMERIC(20, 7)`| No | `0` | Share units ($10^{-7}$) | Horizon (`balance`) | Amount of pool shares held. |
| `last_ledger` | `BIGINT` | No | `0` | Ledger sequence | Horizon | Ledger sequence of last balance change. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Timestamp record was updated. |

---

### 19. `claimable_balances`
Stellar claimable balance entries (escrowed balances waiting to be claimed).

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `balance_id` | `TEXT` | No (PK) | None | 64-char Hex ID | Horizon (`id`) | Unique claimable balance identifier. |
| `asset` | `TEXT` | No | None | Asset string | Horizon (`asset`) | Asset escrowed in the balance. |
| `amount` | `NUMERIC(20, 7)`| No | None | Asset units ($10^{-7}$) | Horizon (`amount`) | Escrowed asset amount. |
| `sponsor` | `TEXT` | Yes | None | Stellar address (`G...`) | Horizon (`sponsor`) | Account providing the base reserve. |
| `claimants` | `JSONB` | No | `'[]'::jsonb`| JSONB Array | Horizon (`claimants`) | Array of valid claimants and release conditions. |
| `status` | `TEXT` | No | `'unclaimed'`| String enum | Internal tracking | Current state: `'unclaimed'` or `'claimed'`. |
| `claimed_by` | `TEXT` | Yes | None | Stellar address (`G...`) | Horizon / Inferred | Account that successfully claimed the balance. |
| `claimed_at` | `TIMESTAMPTZ` | Yes | None | ISO 8601 UTC | Horizon / Inferred | Timestamp balance was claimed. |
| `claimed_ledger`| `BIGINT` | Yes | None | Ledger sequence | Horizon / Inferred | Ledger sequence in which the claim occurred. |
| `created_ledger`| `BIGINT` | No | None | Ledger sequence | Horizon | Ledger sequence in which balance was created. |
| `created_at` | `TIMESTAMPTZ` | No | None | ISO 8601 UTC | Horizon | Creation timestamp. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 20. `claimable_balance_claimants`
Relational breakdown of designated recipient accounts and predicates for claimable balances.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `balance_id` | `TEXT` | No (PK) | None | 64-char Hex ID | Horizon | Reference to parent claimable balance. |
| `destination` | `TEXT` | No (PK) | None | Stellar address (`G...`) | Horizon (`destination`)| Account authorized to claim. |
| `predicate_type`| `TEXT` | No | `'unconditional'`| Predicate type | Horizon (`predicate`) | Type of claim condition (`'unconditional'`, `'and'`, `'or'`, `'not'`, `'abs_before'`, `'rel_before'`). |
| `predicate_details`| `JSONB` | Yes | None | JSONB Object | Horizon | Raw predicate conditions. |
| `abs_before` | `TIMESTAMPTZ` | Yes | None | ISO 8601 UTC | Horizon | Deadline timestamp before which balance must be claimed. |
| `rel_before` | `BIGINT` | Yes | None | Seconds | Horizon | Number of relative seconds from creation before claim expires. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 21. `path_payments`
Detailed records for strict-send and strict-receive cross-asset path payments.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `operation_id` | `TEXT` | No (PK) | None | 64-bit Integer string | Horizon (`id`) | Reference to parent operation. |
| `transaction_hash`| `TEXT` | No | None | 64-char Hex SHA-256 | Horizon (`transaction_hash`)| Parent transaction hash. |
| `ledger` | `BIGINT` | No | None | Ledger sequence | Horizon | Ledger sequence containing the payment. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |
| `payment_type` | `TEXT` | No | None | String enum | Horizon (`type`) | Payment flavor: `'path_payment_strict_receive'` or `'path_payment_strict_send'`. |
| `from_account` | `TEXT` | No | None | Stellar address (`G...`) | Horizon (`from`) | Sending account. |
| `to_account` | `TEXT` | No | None | Stellar address (`G...`) | Horizon (`to`) | Receiving destination account. |
| `source_asset` | `TEXT` | No | None | Asset string | Horizon (`source_asset_*`)| Asset debited from sender. |
| `source_amount`| `NUMERIC(20, 7)`| No | None | Source asset units | Horizon (`source_amount`)| Amount debited from sender. |
| `dest_asset` | `TEXT` | No | None | Asset string | Horizon (`asset_*`) | Asset credited to recipient. |
| `dest_amount` | `NUMERIC(20, 7)`| No | None | Destination asset units | Horizon (`amount`) | Amount received by recipient. |
| `path_assets` | `TEXT[]` | No | `'{}'` | Text Array | Horizon (`path`) | Intermediate assets traversed along the route. |
| `hop_count` | `INTEGER` | No | `0` | Integer count | Internal | Number of intermediate exchange hops in path. |
| `created_at` | `TIMESTAMPTZ` | No | None | ISO 8601 UTC | Horizon (`created_at`) | Timestamp payment was executed. |

---

### 22. `path_payment_hops`
Individual orderbook hops traversed during path payments.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `operation_id` | `TEXT` | No (PK) | None | 64-bit Integer string | Horizon | Reference to path payment operation. |
| `hop_index` | `INTEGER` | No (PK) | None | 0-based integer | Internal | Sequence index of this hop along the route. |
| `asset` | `TEXT` | No | None | Asset string | Horizon (`path[i]`) | Intermediate asset exchanged at this step. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |

---

### 23. `account_signer_changes`
Audit trail of signer additions, modifications, and removals (`set_options` operations).

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `id` | `BIGSERIAL` | No (PK) | Auto-inc | Integer ID | Internal | Primary key identifier. |
| `account` | `TEXT` | No | None | Stellar address (`G...`) | Horizon | Account having signers altered. |
| `operation_id` | `TEXT` | No | None | 64-bit Integer string | Horizon (`id`) | Operation ID executing the modification. |
| `transaction_hash`| `TEXT` | No | None | 64-char Hex SHA-256 | Horizon (`transaction_hash`)| Parent transaction hash. |
| `ledger` | `BIGINT` | No | None | Ledger sequence | Horizon | Ledger sequence of the operation. |
| `network` | `TEXT` | No | `'mainnet'` | Text name | Internal | Network identifier. |
| `signer_key` | `TEXT` | No | None | Public key or hash | Horizon (`signer_key`)| Signer identifier key added or modified. |
| `weight` | `INTEGER` | No | None | Weight (0–255) | Horizon (`signer_weight`)| Assigned signer weight (0 means removed). |
| `action` | `TEXT` | No | None | String enum | Internal | Action performed: `'added'`, `'updated'`, or `'removed'`. |
| `created_at` | `TIMESTAMPTZ` | No | None | ISO 8601 UTC | Horizon (`created_at`) | Timestamp of modification. |

---

### 24. `account_threshold_changes`
Audit trail of threshold and home domain adjustments (`set_options` operations).

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `id` | `BIGSERIAL` | No (PK) | Auto-inc | Integer ID | Internal | Primary key identifier. |
| `account` | `TEXT` | No | None | Stellar address (`G...`) | Horizon | Account having thresholds altered. |
| `operation_id` | `TEXT` | No | None | 64-bit Integer string | Horizon (`id`) | Operation ID executing the change. |
| `transaction_hash`| `TEXT` | No | None | 64-char Hex SHA-256 | Horizon (`transaction_hash`)| Parent transaction hash. |
| `ledger` | `BIGINT` | No | None | Ledger sequence | Horizon | Ledger sequence of the change. |
| `network` | `TEXT` | No | `'mainnet'` | Text name | Internal | Network identifier. |
| `master_weight` | `INTEGER` | Yes | None | Weight (0–255) | Horizon (`master_key_weight`)| Weight of the primary master account key. |
| `low_threshold` | `INTEGER` | Yes | None | Weight (0–255) | Horizon (`low_threshold`) | Threshold weight for low-security operations. |
| `med_threshold` | `INTEGER` | Yes | None | Weight (0–255) | Horizon (`med_threshold`) | Threshold weight for medium-security operations. |
| `high_threshold` | `INTEGER` | Yes | None | Weight (0–255) | Horizon (`high_threshold`) | Threshold weight for high-security operations. |
| `home_domain` | `TEXT` | Yes | None | Domain string | Horizon (`home_domain`) | Federation and TOML home domain. |
| `set_flags` | `TEXT[]` | Yes | None | Text array | Horizon (`set_flags_s`) | Account flags enabled. |
| `clear_flags` | `TEXT[]` | Yes | None | Text array | Horizon (`clear_flags_s`)| Account flags disabled. |
| `created_at` | `TIMESTAMPTZ` | No | None | ISO 8601 UTC | Horizon (`created_at`) | Timestamp of change. |

### 25. `account_state_history`
Stored copies of an account, one per observed last-modified ledger. Written by the indexer on each account refresh and read by `account(asOfLedger:)`. Pruned by the retention window `RETENTION_ACCOUNT_STATE_HISTORY_DAYS`. See [ACCOUNT_STATE_HISTORY.md](ACCOUNT_STATE_HISTORY.md) for what a copy captures and what it does not.

| Column | Type | Nullable | Default | Units / Format | Source | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `address` | `TEXT` | No (PK) | None | Stellar address (`G...`) | Horizon (`account_id`) | Account the copy describes. |
| `network` | `TEXT` | No (PK) | `'mainnet'` | Text name | Internal | Network identifier. |
| `last_modified_ledger` | `BIGINT` | No (PK) | None | Ledger sequence | Horizon (`last_modified_ledger`) | Ledger in which this state was last modified. Copies are looked up by this value. |
| `sequence` | `TEXT` | No | None | String Integer | Horizon (`sequence`) | Account transaction sequence number at that state. |
| `subentry_count` | `INTEGER` | No | `0` | Integer count | Horizon (`subentry_count`) | Subentries (trustlines, offers, signers) at that state. |
| `num_sponsored` | `INTEGER` | No | `0` | Integer count | Horizon (`num_sponsored`) | Subentries sponsored at that state. |
| `num_sponsoring` | `INTEGER` | No | `0` | Integer count | Horizon (`num_sponsoring`) | Sponsors at that state. |
| `balances` | `JSONB` | No | `'[]'` | JSONB Array | Horizon (`balances`) | Asset balances at that state (amounts as decimal strings). |
| `flags` | `JSONB` | No | `'{}'` | JSONB Object | Horizon (`flags`) | Authorization flags at that state. |
| `thresholds` | `JSONB` | No | `'{}'` | JSONB Object | Horizon (`thresholds`) | Signing thresholds at that state. |
| `recorded_at` | `TIMESTAMPTZ` | No | `NOW()` | ISO 8601 UTC | Internal | Wall-clock time the copy was stored. Retention prunes on this column. |
