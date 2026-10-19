# Operations Details JSONB Storage & TOAST Tuning Guide

## Executive Summary

The `operations` table is the highest-volume table in the Lumina database. The `details` column (`JSONB NOT NULL DEFAULT '{}'`) stores the full operation payload ingested from Stellar Horizon. Prior to this analysis, `operations.details` operated under PostgreSQL's default `EXTENDED` storage strategy with default TOAST thresholds (`TOAST_TUPLE_THRESHOLD = 2048` bytes).

This investigation evaluates:
1. The empirical storage footprint and compression ratio of `operations.details` across standard operation types.
2. The interaction between payload sizes, PostgreSQL heap page layout (8 KB), and TOAST storage strategies (`EXTENDED`, `MAIN`, `EXTERNAL`, `PLAIN`).
3. The storage savings achieved by pruning raw Horizon payloads down to the subset of fields actually consumed by downstream GraphQL queries and exports.
4. Concrete storage and TOAST configuration recommendations with migration paths.

---

## 1. Storage Footprint & Compression Benchmark

Empirical benchmarks were conducted using representative Horizon operation payloads (`payment`, `create_account`, `manage_buy_offer`, `path_payment_strict_receive`, `change_trust`) using `db/benchmark-operations-storage.ts`.

### Benchmark Results

| Operation Type | Raw Horizon Payload | Compressed Raw (`pglz`/`lz4`) | Pruned Payload | Pruned Compressed | Raw $\to$ Pruned Savings | Total Savings |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `payment` | 1,074 B | 476 B (55.7%) | 280 B | 233 B | 73.9% | 78.3% |
| `create_account` | 967 B | 398 B (58.8%) | 168 B | 157 B | 82.6% | 83.8% |
| `manage_buy_offer` | 1,072 B | 482 B (55.0%) | 244 B | 182 B | 77.2% | 83.0% |
| `path_payment_strict_receive` | 1,316 B | 577 B (56.2%) | 279 B | 231 B | 78.8% | 82.4% |
| `change_trust` | 1,095 B | 450 B (58.9%) | 296 B | 209 B | 73.0% | 80.9% |
| **Averages** | **1,105 B** | **477 B (56.8%)** | **253 B** | **202 B** | **77.1%** | **81.7%** |

### Projected Storage Growth (Raw vs. Pruned vs. Tuned TOAST)

| Ingested Rows | Default Raw (`EXTENDED`, No TOAST) | Pruned Schema | Pruned + Compressed (`lz4`) | Storage Reclaimed |
| :--- | :--- | :--- | :--- | :--- |
| **100,000** (100k) | 0.10 GB | 0.02 GB | 0.02 GB | ~0.08 GB |
| **1,000,000** (1M) | 1.03 GB | 0.24 GB | 0.19 GB | ~0.84 GB |
| **10,000,000** (10M) | 10.29 GB | 2.36 GB | 1.88 GB | ~8.41 GB |
| **100,000,000** (100M) | **102.91 GB** | **23.56 GB** | **18.81 GB** | **~84.10 GB (81.7%)** |

---

## 2. Analysis of PostgreSQL TOAST Behavior

### The Under-Threshold Inline Storage Problem
PostgreSQL divides table data into 8 KB heap pages. When a table row exceeds `TOAST_TUPLE_THRESHOLD` (fixed at ~2,048 bytes, or one-fourth of an 8 KB page), the engine attempts to compress and out-of-line TOAST variable-length columns (`EXTENDED` strategy).

However:
- Standard operation rows in `operations` have an overall width of **1,250 to 1,550 bytes** (UUID/string ID, transaction hash, timestamp, source account, plus ~1,105 bytes of `details` JSONB).
- Because 1,550 bytes is **strictly below 2,048 bytes**, PostgreSQL's TOAST engine **never triggers compression or out-of-line storage** under default settings.
- The entire raw JSON payload is written inline into the main table heap pages uncompressed.

### Consequences on Query Performance and Cache Efficiency
1. **Low Page Density**: Only 4 to 5 `operations` tuples fit into a single 8 KB buffer page.
2. **Buffer Cache Bloat**: Scanning or joining `operations` (e.g. filtering transactions or accounts) pulls massive amounts of uncompressed JSON into PostgreSQL's `shared_buffers`, evicting hot indexes and other tables.
3. **Sequential Scan Penalty**: Queries reading operations by ledger or timestamp must transfer ~103 GB across storage controllers for 100M records, whereas pruned or compressed data requires under 20 GB.

---

## 3. Evaluation of Storage and Compression Strategies

### A. Column Storage Strategies
PostgreSQL supports 4 column-level storage modes:
- `EXTENDED` (Default): Allows compression and out-of-line TOAST. Fails to activate when the total tuple is under 2 KB.
- `MAIN`: Allows inline compression first; only moves out-of-line if necessary. Ideal when combined with a reduced `toast_tuple_target`.
- `EXTERNAL`: Moves data out-of-line without compression. Not recommended (wastes disk space).
- `PLAIN`: Disallows compression and out-of-line storage. Not viable for dynamic JSONB.

### B. Compression Algorithms (`pglz` vs. `lz4`)
Beginning with PostgreSQL 14, columns can use `lz4` compression instead of the built-in `pglz`:
- **`pglz`**: Slower decompression throughput; decent compression ratio (~56%).
- **`lz4`**: ~3x to 4x faster decompression speed with negligible difference in compression ratio (~55-58%). Since indexer ingest and GraphQL query serving are CPU/IO-bound, `lz4` yields minimal CPU overhead during inserts and JSON deserialization.

### C. Threshold Tuning (`toast_tuple_target`)
PostgreSQL allows setting `toast_tuple_target` per table (minimum 128 bytes, default 2040 bytes):
```sql
ALTER TABLE operations SET (toast_tuple_target = 128);
```
Setting `toast_tuple_target = 128` forces PostgreSQL to compress any column larger than 128 bytes inline even when the tuple as a whole is well below 2,048 bytes.

---

## 4. Full Horizon Payload vs. Field Pruning

The GraphQL server (`graphql-server/src/db.ts:mapOperation`) and indexer exports only read a strict subset of operation attributes:
- **Core Accounts**: `source_account`, `from`, `to`, `funder`, `account`
- **Asset Fields**: `asset_type`, `asset_code`, `asset_issuer`
- **Amounts**: `amount`, `starting_balance`, `price`
- **DEX/Offer Fields**: `offer_id`, `selling_asset_type`, `selling_asset_code`, `selling_asset_issuer`, `buying_asset_type`, `buying_asset_code`, `buying_asset_issuer`

Horizon's full payload includes redundant metadata (`_links`, `paging_token`, `transaction_successful`, `transaction_hash`, `created_at`, redundant `type_i` numbers, duplicate ledger numbers) that are already stored in dedicated table columns (`operations.transaction_hash`, `operations.ledger`, `operations.created_at`).

Pruning redundant fields before insertion reduces uncompressed payload size from **1,105 bytes to 253 bytes (77.1% reduction)**.

---

## 5. Recommendations & Implementation Plan

### Recommendation 1: Configure Column Storage and Compression
Set the `details` column storage to `MAIN` with `lz4` compression (on PostgreSQL 14+) and lower `toast_tuple_target` on the `operations` table:

```sql
-- 1. Use LZ4 compression for JSONB details (PostgreSQL 14+)
ALTER TABLE operations ALTER COLUMN details SET COMPRESSION lz4;

-- 2. Prefer inline compression for details
ALTER TABLE operations ALTER COLUMN details SET STORAGE MAIN;

-- 3. Lower the TOAST target to compress inline payloads >= 128 bytes
ALTER TABLE operations SET (toast_tuple_target = 128);
```

*Note: Existing rows remain unaffected until rewritten. To apply compression to existing rows, run `VACUUM FULL operations;` or re-index in batches during a maintenance window.*

### Recommendation 2: Prune Details at Ingestion
In `indexer/src/db.ts`, filter out `_links`, duplicate transaction metadata, and null fields before calling `JSON.stringify(op)`:
```typescript
export function pruneOperationDetails(op: Record<string, any>): Record<string, any> {
  const {
    _links,
    id,
    paging_token,
    transaction_hash,
    transaction_successful,
    source_account,
    type,
    type_i,
    created_at,
    ...essentialDetails
  } = op;
  return essentialDetails;
}
```

### Expected Impact
- **Total Storage Reduction**: **81.7%** (from 102.9 GB to 18.8 GB per 100M operations).
- **Buffer Cache Hit Ratio**: 4x more operations fit per 8 KB memory buffer page.
- **IOPS Reduction**: Sequential scans on `operations` require reading ~80% fewer blocks from NVMe/SSD storage.
