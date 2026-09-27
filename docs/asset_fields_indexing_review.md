# Operations Indexing Strategies: JSONB vs Columns

## 1. Scope and Queried Fields
When filtering operations by asset (e.g. `XLM` or `USDC:GA5...`), an asset can appear in one of three roles:
- The payment asset (`asset_type`, `asset_code`, `asset_issuer`)
- The selling side of an offer (`selling_asset_type`, `selling_asset_code`, `selling_asset_issuer`)
- The buying side of an offer (`buying_asset_type`, `buying_asset_code`, `buying_asset_issuer`)

Currently, only `asset_code`, `asset_issuer`, and `asset_type` have expression indexes. To fully support the `assetConditions` search logic natively, we would need to index all **9 fields** (or create composite indexes).

## 2. Comparison of Approaches

We evaluate the three options for handling these 9 fields:

### A. Expression Indexes (Current Approach)
`CREATE INDEX idx_asset_code ON operations ((details->>'asset_code'))`

- **Storage Cost**: Moderate. The `details` JSONB column stores the key strings (e.g., `"asset_code"`, `"selling_asset_issuer"`) repeatedly for every row. An expression index also duplicates the extracted string in the B-Tree index. 
  - *JSONB overhead*: Keys are stored in every row. The word "selling_asset_issuer" alone is 20 bytes per row.
- **Write Cost**: High. On every `INSERT`, PostgreSQL must evaluate `details->>'field'` for all 9 indexes. This requires deserializing/traversing the JSONB document 9 times during the write path.
- **Indexing simplicity**: Poor. To fully cover search queries, you need a multitude of partial and composite expression indexes which clutter the schema.

### B. Generated Columns
`asset_code TEXT GENERATED ALWAYS AS (details->>'asset_code') STORED`

- **Storage Cost**: Highest. The value exists inside the `details` JSONB payload (along with its key string), AND is duplicated physically as a `TEXT` column on the table page. Adding 9 generated columns significantly increases table bloat (write amplification).
- **Write Cost**: Moderate. The expressions are evaluated once per row insertion. Then standard B-Tree indexes are built on top of the physical columns.
- **Indexing simplicity**: Better. Native indexing works well, but it bloats the main table footprint.

### C. Real Columns
Extract the 9 fields out of the `details` JSONB column into dedicated native columns, removing them from the JSONB payload entirely.

- **Storage Cost**: Lowest. Native `TEXT` or `VARCHAR` columns have minimal overhead (1 byte header + the string). Removing these 9 keys from the `details` JSONB saves ~150-200 bytes per row in repeated key-string storage alone. 
- **Write Cost**: Lowest. The data is written directly to native columns. Indexes are native B-trees over native columns. No JSONB parsing overhead during insertion.
- **Indexing simplicity**: Best. Native columns can easily support composite indexes (e.g., `(asset_code, asset_issuer)`) which match the query patterns optimally.

## 3. Quantitative Measurement Estimates
Assuming an average row where half of these fields are populated (e.g., a path payment):
- **Current JSONB Payload**: ~120 bytes for keys + ~150 bytes for values.
- **Generated Columns**: ~270 bytes in JSONB + ~150 bytes duplicated in table payload = ~420 bytes payload per row.
- **Real Columns**: 0 bytes in JSONB + ~150 bytes in table payload = ~150 bytes payload per row.

Extrapolating over 100M operations:
- Moving to real columns saves roughly **12 GB of raw table bloat** (from removed JSON keys) and eliminates the JSONB extraction cost on the `INSERT` hot path.

## 4. Recommendation
**Migrate to Real Columns.**

The `operations` table is the highest-volume table in the database. Using JSONB for highly queried and indexed fields creates structural friction:
1. Every new filter requirement adds multiple expression indexes (e.g., `selling_` and `buying_` fields are currently unindexed, forcing table scans or slow GIN searches).
2. The indexer writes in bulk. Doing JSONB extraction 9 times per row slows down the `INSERT` hot path.
3. Querying `(asset_code, asset_issuer)` is fundamentally a composite relationship, which is easier to index using native composite indexes: `CREATE INDEX idx_payment_asset ON operations (asset_code, asset_issuer)`.

**Next Steps**:
1. Add the 9 asset fields as real, nullable columns to `operations`.
2. Update the indexer (`indexer/src/db.ts`) to extract these fields from the Horizon operation object and insert them into the real columns, excluding them from the `details` JSONB.
3. Update `schema.sql` to use native B-Tree (and composite) indexes on these columns.
4. Update `graphql-server/src/search.ts` to query the native columns instead of `details->>'...'`.
