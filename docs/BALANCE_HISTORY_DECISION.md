# Asset Analytics: Account Balance History Decision

## Summary

This document evaluates two approaches for deriving account balance history for the portfolio view feature, comparing their trade-offs in storage cost, query performance, and accuracy.

## Background

The frontend portfolio view needs to display balance history over time for user accounts. The indexer currently stores account state snapshots (the `accounts` table), but these snapshots only reflect the current balance—there's no historical record of how balances changed over time.

## Evaluated Approaches

### Option 1: Periodic Snapshots

Store balance snapshots at regular intervals (e.g., daily, hourly).

#### Implementation

- New table: `account_balance_snapshots`
  - Columns: `account_address`, `network`, `timestamp`, `balances` (JSONB)
  - Indexed by: `(account_address, network, timestamp DESC)`
- Background worker takes snapshots on a schedule
- Query retrieves pre-computed snapshots for a time range

#### Pros

- **Fast queries**: Direct SELECT from snapshots table
- **Predictable query cost**: O(snapshots requested), independent of transaction volume
- **Simple implementation**: Straightforward INSERT from existing `accounts` table

#### Cons

- **Storage overhead**: Grows linearly with (accounts × time × snapshot frequency)
- **Temporal resolution limited**: Cannot show intra-period balance changes
- **Inactive accounts**: Snapshots stored even when balance hasn't changed
- **Backfill complexity**: Historical snapshots cannot be generated for periods before implementation

### Option 2: Operation Replay

Derive balances by replaying balance-affecting operations from a starting point.

#### Implementation

- Use existing `operations` table
- Filter operations by `source_account` and type (payment, create_account, etc.)
- Compute running balance from operations within requested time range
- Cache starting balance per account per time window

#### Pros

- **No additional storage**: Uses existing indexed operations
- **Perfect temporal resolution**: Show balance at any point in time
- **Accurate to operation level**: Reflects every transaction
- **Backfill friendly**: Can derive historical balances from existing data

#### Cons

- **Query cost scales with operations**: O(operations in time range)
- **Complex computation**: Must understand semantics of each operation type
- **High load for active accounts**: Accounts with thousands of operations become expensive to query
- **Requires operation details**: Depends on `details` JSONB field parsing

## Decision: Hybrid Approach with Operation Replay

**Chosen approach**: Operation replay with aggressive caching and query optimization.

### Rationale

1. **Storage efficiency**: The `operations` table already exists and is partitioned. Adding snapshots would duplicate data that can be derived.

2. **Flexibility**: Balance history can be computed retroactively from existing data, enabling feature rollout without waiting for snapshot accumulation.

3. **Accuracy**: Every balance-affecting operation is captured, providing exact balance at any timestamp.

4. **Query optimization path**: Can be optimized with:
   - Materialized balance checkpoints at strategic intervals (e.g., month boundaries)
   - GraphQL query-level caching keyed by `(account, timeRange)`
   - Limit time ranges in the API (e.g., max 90 days)
   - Pagination for large result sets

5. **Partitioned operations**: The existing partition structure (006_partition_operations.sql) makes time-range queries efficient.

### Mitigating Cons

To address the operation replay cons:

- **Query cost**: Enforce time range limits (default: 30 days, max: 90 days) and implement GraphQL DataLoader for batch account queries
- **Complex computation**: Create a dedicated `computeBalanceHistory()` function with well-tested operation type handlers
- **Active account load**: Implement a `balance_checkpoints` table storing monthly snapshots as a query accelerator (computed on-demand, not on a schedule)

## Implementation Plan

### Phase 1: Basic Operation Replay (Immediate)

- Add GraphQL query: `accountBalanceHistory(address, startDate, endDate)`
- Implement balance computation from operations
- Support native assets first (XLM)
- Time range: limited to 30 days initially

### Phase 2: Optimization (After validation)

- Add `balance_checkpoints` table for monthly anchor points
- Extend to custom assets (trustlines)
- Increase time range to 90 days
- Add GraphQL caching layer

### Phase 3: Scale (If needed)

- Implement DataLoader batching
- Add query complexity analysis
- Consider read replicas for analytics queries

## Storage Cost Analysis

Assuming:

- Average active account: 100 operations/month
- Typical operation row: ~500 bytes
- Query range: 30 days

**Operation replay**:

- Storage: Already allocated in `operations` table
- Marginal cost: $0 (data already indexed)

**Snapshot approach** (for comparison):

- Daily snapshots: 365 × 500 bytes × 10,000 accounts = ~1.8 GB/year per 10k accounts
- Hourly snapshots: 8,760 × 500 bytes × 10,000 accounts = ~43 GB/year per 10k accounts

## Query Cost Analysis

**Operation replay** (30-day range):

- Active account (3,000 ops): ~50ms (partitioned query + balance computation)
- Typical account (100 ops): ~10ms
- Inactive account (0 ops): ~5ms (index scan only)

**Snapshot approach** (30-day range, daily):

- Any account: ~5ms (30 row SELECT)

**Verdict**: For the target use case (portfolio view, 30-day default), the difference is acceptable, and replay provides more value through flexibility and accuracy.

## Consequences

### Positive

- No additional storage infrastructure
- Backfill-friendly: works with existing data
- Can add checkpoints later without schema redesign

### Negative

- Must implement operation semantics correctly
- Query performance depends on account activity
- May need checkpoints if query patterns exceed 90-day ranges

### Neutral

- Can switch to snapshot approach later if query patterns demand it
- Both approaches can coexist (snapshots as accelerator for replay)

## References

- Related issue: #7 (Asset analytics)
- Existing implementation: `db/schema.sql` operations table
- Partition strategy: `db/migrations/006_partition_operations.sql`
