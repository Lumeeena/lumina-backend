# Horizon Dependency & Field Contract

This document specifies the exact contract between Lumina's indexer and the Stellar Horizon API. It catalogs every consumed endpoint, field dependencies, data mappings, failure impacts, and contract testing procedures.

---

## 1. Verified Horizon Version

- **Verified Against**: Stellar Horizon **v2.30.0+** (Protocol 20 & Protocol 21).
- **Default Endpoints**:
  - Mainnet: `https://horizon.stellar.org`
  - Testnet: `https://horizon-testnet.stellar.org`
  - Futurenet: `https://horizon-futurenet.stellar.org`
- **Paging Protocol**: Cursor-based using `_links.next.href` or `paging_token` with page size limit of 200 records (`PAGE_LIMIT = 200`).

---

## 2. Endpoints and Consumed Fields

### 2.1 Latest Ledger Tip (`GET /ledgers?order=desc&limit=1`)

Used by the indexer loop (`getLatestLedgerSequence`) for catch-up/cursor discovery and by the GraphQL server (`getLatestLedger`) as a fallback when the database has not indexed any ledgers yet.

| Horizon Field | JSON Type | DB / Internal Destination | Required? | What Breaks Without It |
|---|---|---|---|---|
| `sequence` | `number` | `loop.cursor`, `lumina_latest_horizon_ledger` metric, GraphQL `Ledger.sequence` | **Yes** | Tip tracking halts; catch-up cannot calculate distance to tip; fallback tip returns 0. |
| `closed_at` | `string` (ISO-8601) | GraphQL fallback `Ledger.closedAt` | **Yes** | GraphQL tip fallback returns undefined/null, violating non-null schema contract. |
| `successful_transaction_count` | `number` | Summed with failed transactions for `Ledger.transactionCount` | **Yes** | Fallback transaction count calculation yields `NaN`. |
| `failed_transaction_count` | `number` | Summed with successful transactions for `Ledger.transactionCount` | **Yes** | Fallback transaction count calculation yields `NaN`. |
| `operation_count` | `number` | GraphQL fallback `Ledger.operationCount` | **Yes** | Fallback operation count is undefined, breaking non-null schema contract. |

---

### 2.2 Ledger Ingestion (`GET /ledgers/{sequence}`)

Fetched by the indexer for each ingested ledger (`getLedger`) and persisted into the `ledgers` table.

| Horizon Field | JSON Type | DB Column (`ledgers`) | Required? | What Breaks Without It |
|---|---|---|---|---|
| `sequence` | `number` | `sequence` (`bigint`, PK component) | **Yes** | Primary key constraint violation; ingestion aborts and rolls back. |
| `closed_at` | `string` (ISO-8601) | `closed_at` (`timestamptz`, NOT NULL) | **Yes** | NOT NULL constraint violation; ledger insertion rolls back. |
| `successful_transaction_count` | `number` | Summed for `transaction_count` (`integer`, NOT NULL) | **Yes** | Insertion fails with NOT NULL violation on `transaction_count`. |
| `failed_transaction_count` | `number` | Summed for `transaction_count` (`integer`, NOT NULL) | **Yes** | Insertion fails with NOT NULL violation on `transaction_count`. |
| `operation_count` | `number` | `operation_count` (`integer`, NOT NULL) | **Yes** | NOT NULL constraint violation on `operation_count`. |
| `base_fee_in_stroops` | `number` | `base_fee` (`bigint`, NOT NULL) | **Yes** | NOT NULL violation on `base_fee`. |
| `base_reserve_in_stroops` | `number` | `base_reserve` (`bigint`, NOT NULL) | **Yes** | NOT NULL violation on `base_reserve`. |

---

### 2.3 Transactions Ingestion (`GET /ledgers/{sequence}/transactions?order=asc&limit=200`)

Fetched with automatic pagination (`_links.next.href`) and stored in the `transactions` table.

| Horizon Field | JSON Type | DB Column (`transactions`) | Required? | What Breaks Without It |
|---|---|---|---|---|
| `hash` | `string` (hex 64) | `hash` (`text`, PK component) | **Yes** | Primary key violation; transaction lookup by hash fails; cannot deduplicate. |
| `ledger` | `number` | `ledger` (`bigint`, NOT NULL) | **Yes** | Keyset pagination `(ledger, hash)` breaks; partition and ledger filtering break. |
| `created_at` | `string` (ISO-8601) | `created_at` (`timestamptz`, NOT NULL) | **Yes** | NOT NULL violation; time-window queries (`from`, `to`) fail. |
| `source_account` | `string` (G-address) | `source_account` (`text`, NOT NULL) | **Yes** | Account filtering breaks; `account_refresh_queue` misses the active address. |
| `fee_charged` | `string` (integer stroops) | `fee_charged` (`text`, NOT NULL) | **Yes** | NOT NULL violation; fee accounting fails. |
| `operation_count` | `number` | `operation_count` (`integer`, NOT NULL) | **Yes** | NOT NULL violation on `operation_count`. |
| `successful` | `boolean` | `successful` (`boolean`, NOT NULL) | **Yes** | Success/failure filtering (`successful: Boolean`) fails. |
| `memo_type` | `string` | `memo_type` (`text`, NOT NULL) | **Yes** | Memo type classification fails. |
| `memo` | `string` (optional) | `memo` (`text`, nullable) | No (nullable) | If omitted when `memo_type` indicates a memo, trigram full-text search cannot match the transaction. |

---

### 2.4 Operations Ingestion (`GET /ledgers/{sequence}/operations?order=asc&limit=200`)

Fetched with automatic pagination (`_links.next.href`) and stored in `operations` table. Also triggers asset analytics processing.

| Horizon Field | JSON Type | DB Column (`operations`) | Required? | What Breaks Without It |
|---|---|---|---|---|
| `id` | `string` (bigint string) | `id` (`text`, PK component) | **Yes** | Unique constraint violation; keyset pagination `(ledger, id)` fails. |
| `type` | `string` | `type` (`text`, NOT NULL) | **Yes** | GraphQL `OperationType` mapping fails; operation filtering by type fails. |
| `transaction_hash` | `string` | `transaction_hash` (`text`, NOT NULL) | **Yes** | Cannot correlate operations with parent transaction; DataLoader batching breaks. |
| `created_at` | `string` (ISO-8601) | `created_at` (`timestamptz`, NOT NULL) | **Yes** | Operation ordering and timestamps fail. |
| `source_account` | `string` (G-address) | `source_account` (`text`, NOT NULL) | **Yes** | Account operation filtering breaks; `account_refresh_queue` misses account. |
| `[key: string]: unknown` (payload) | `object` | `details` (`jsonb`, NOT NULL) | **Yes** | Operation detail view fails. |
| `details.from`, `details.to` | `string` | Extracted in queries / asset analytics | Conditional (`payment`, `path_payment`) | Asset volume tracking and counterparty queries (`accountOperationsInLedger`) miss transfers. |
| `details.amount` | `string` | Extracted in asset analytics | Conditional (`payment`, `path_payment`) | Volume aggregations in `asset_daily_volume` and `AssetDetail.series` report zero. |
| `details.asset_type`, `asset_code`, `asset_issuer` | `string` | Asset parsing (`formatAsset`, `assetConditions`) | Conditional (`payment`, `change_trust`) | Asset filtering by `CODE:ISSUER` or `XLM` fails to match the operation. |
| `details.buying_asset_*`, `details.selling_asset_*` | `string` | DEX offer asset parsing | Conditional (`manage_sell_offer`, `manage_buy_offer`) | Order book and trade volume analytics for the involved assets are omitted. |

---

### 2.5 Account Snapshots (`GET /accounts/{address}`)

Queried during account worker refresh runs and stored in the `accounts` table.

| Horizon Field | JSON Type | DB Column (`accounts`) | Required? | What Breaks Without It |
|---|---|---|---|---|
| `account_id` (or `id`) | `string` (G-address) | `address` (`text`, PK component) | **Yes** | Upsert fails; address cannot be resolved. |
| `sequence` | `string` | `sequence` (`text`, NOT NULL) | **Yes** | Account sequence number is missing in GraphQL responses. |
| `subentry_count` | `number` | `subentry_count` (`integer`, NOT NULL) | **Yes** | NOT NULL violation; cannot determine reserve requirements. |
| `last_modified_ledger` | `number` | `last_modified_ledger` (`bigint`, NOT NULL) | **Yes** | Keyset pagination on `RECENT_ACTIVITY` (`last_modified_ledger DESC, address ASC`) fails; refresh thresholding loops infinitely. |
| `num_sponsored` | `number` | `num_sponsored` (`integer`, NOT NULL) | **Yes** | Sponsored account analytics break. |
| `num_sponsoring` | `number` | `num_sponsoring` (`integer`, NOT NULL) | **Yes** | Sponsoring account analytics break. |
| `balances` | `array` of `HorizonBalance` | `balances` (`jsonb`, NOT NULL) | **Yes** | Asset holders count and total supply calculations break; account balance views empty. |
| `balances[].asset_type` | `string` | `balances` JSONB | **Yes** | Cannot differentiate native (XLM) from issued credit assets. |
| `balances[].balance` | `string` | `balances` JSONB | **Yes** | Balance display and supply summation break. |
| `flags` | `object` (`auth_required`, `auth_revocable`, `auth_immutable`, `auth_clawback_enabled`) | `flags` (`jsonb`, NOT NULL) | **Yes** | Account security and compliance flag display breaks. |
| `thresholds` | `object` (`low_threshold`, `med_threshold`, `high_threshold`) | `thresholds` (`jsonb`, NOT NULL) | **Yes** | Multi-sig and threshold authorization checks fail. |

---

### 2.6 Trades Ingestion (`GET /trades?order=asc&limit=200&cursor=...`)

Queried by the trades indexer loop (`pollTrades`) and stored in the `trades` table. Deriving trades from operations alone is unreliable because a single path payment or DEX offer operation can cross multiple order book offers and produce several trade records.

| Horizon Field | JSON Type | DB Column (`trades`) | Required? | What Breaks Without It |
|---|---|---|---|---|
| `id` | `string` | `id` (`text`, PK component) | **Yes** | Primary key violation; deduplication (`ON CONFLICT (id, network) DO NOTHING`) fails. |
| `paging_token` | `string` | `paging_token` (`text`, NOT NULL) | **Yes** | Loop cursor tracking halts; cannot advance forward in `/trades`. |
| `ledger_close_time` | `string` (ISO-8601) | `ledger_close_time` (`timestamptz`, NOT NULL) | **Yes** | NOT NULL violation; chronological queries fail. |
| `trade_type` | `string` | `trade_type` (`text`, DEFAULT 'orderbook') | No | Falls back to `'orderbook'`. |
| `base_account` | `string` (G-address) | `base_account` (`text`, NOT NULL) | **Yes** | Account trades query (`trades(account:)`) fails to associate trade with base party. |
| `base_amount` | `string` (decimal) | `base_amount` (`numeric(20,7)`, NOT NULL) | **Yes** | NOT NULL check fails; volume calculations break. |
| `base_asset_type` | `string` | `base_asset_type` (`text`, NOT NULL) | **Yes** | Cannot determine whether asset is native or issued. |
| `base_asset_code` | `string` | `base_asset_code` (`text`, nullable) | Conditional (issued asset) | Asset pair query (`trades(baseAsset:)`) fails to match issued tokens. |
| `base_asset_issuer` | `string` | `base_asset_issuer` (`text`, nullable) | Conditional (issued asset) | Cannot distinguish identical token codes issued by different accounts. |
| `base_offer_id` | `string` | `base_offer_id` (`text`, nullable) | No | Offer correlation omitted. |
| `counter_account` | `string` (G-address) | `counter_account` (`text`, nullable) | Conditional | Account trades query (`trades(account:)`) fails to associate trade with counter party. |
| `counter_amount` | `string` (decimal) | `counter_amount` (`numeric(20,7)`, NOT NULL) | **Yes** | NOT NULL check fails; trade execution price calculation breaks. |
| `counter_asset_type` | `string` | `counter_asset_type` (`text`, NOT NULL) | **Yes** | Cannot determine whether counter asset is native or issued. |
| `counter_asset_code` | `string` | `counter_asset_code` (`text`, nullable) | Conditional (issued asset) | Counter asset pair filtering fails. |
| `counter_asset_issuer` | `string` | `counter_asset_issuer` (`text`, nullable) | Conditional (issued asset) | Counter token issuer verification fails. |
| `counter_offer_id` | `string` | `counter_offer_id` (`text`, nullable) | No | Counter offer tracking omitted. |
| `base_is_seller` | `boolean` | `base_is_seller` (`boolean`, nullable) | No | Maker/taker direction is unknown. |
| `price.n`, `price.d` | `string` or `number` | `price_n`, `price_d`, `price` | No | Price fraction and decimal ratio cannot be recorded. |

---

## 3. Contract Testing & Verification

1. **Recorded Fixtures**:
   - Golden response snapshots are saved in `indexer/src/__fixtures__/horizon.json`.
   - Recording procedures and fixture guidelines are documented in `docs/HORIZON_FIXTURES.md`.

2. **Test Suites Enforcing Contract**:
   - `shared/src/horizon.test.ts`: Verifies paging, retry logic, timeout handling, error isolation, trade fetching, and URL construction.
   - `indexer/src/horizon.test.ts`: Verifies parsing of recorded fixtures against expected TypeScript interfaces.
   - `graphql-server/src/horizon.test.ts`: Verifies GraphQL fallback behavior on Horizon outages, 404 handling, and fallback trades.

3. **Updating the Contract on Horizon Upgrades**:
   - Run verification queries against Horizon:
     ```bash
     curl "https://horizon.stellar.org/ledgers/50000000" | jq .
     curl "https://horizon.stellar.org/ledgers/50000000/transactions?limit=1" | jq .
     curl "https://horizon.stellar.org/ledgers/50000000/operations?limit=1" | jq .
     curl "https://horizon.stellar.org/trades?limit=1" | jq .
     ```
   - If Horizon introduces new fields or deprecates existing ones, update `shared/src/horizon.ts`, update `docs/HORIZON_CONTRACT.md`, and update tests in `horizon.test.ts`.
