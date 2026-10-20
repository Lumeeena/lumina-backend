# Indexing Guarantees & Completeness Reference

## Executive Summary

Lumina is designed as a near-real-time ingestion engine for Stellar Classic and Soroban smart contract activity. 

To maintain high throughput and prevent upstream failures from freezing ingestion, the indexer trades **strict transactional completeness** for **availability and eventual consistency**. Downstream consumers (GraphQL API users, data pipelines, financial auditors, and bulk-export consumers) must understand the precise guarantees, failure modes, and boundary conditions documented below.

---

## 1. Core System Guarantees

### At-Least-Once Delivery & Idempotency
- **Guarantee**: All database insertion routines (`indexLedger`, `insertContractEvents`, `upsertContractStorageEntries`, `insertTrades`) are written with idempotency guards (`ON CONFLICT ... DO NOTHING` or `ON CONFLICT ... DO UPDATE`).
- **Implication**: Any ledger, event, or trade can be safely re-ingested or re-scanned multiple times without creating duplicate rows, corrupting sequence numbers, or artificially inflating metrics.

### Intra-Ledger Transactional Atomicity
- **Guarantee**: A single ledger's header (`ledgers`), transactions (`transactions`), and operations (`operations`) are committed within a single PostgreSQL database transaction.
- **Implication**: You will never observe partial ledger state: if a transaction exists in the database, its corresponding ledger header and operations are guaranteed to be present.

---

## 2. Known Limitations & Completeness Gaps

The database **does not guarantee 100% gapless completeness out of the box**. Downstream consumers must be aware of the following architectural behaviors:

### A. Fresh Database Tip-Start Behavior
- **Behavior**: When the indexer boots against an unpopulated database with no `START_LEDGER` set, it queries Horizon for the current chain tip (`latestLedgerSequence`) and begins ingestion from that point forward.
- **Limitation**: The database **does not contain historical data prior to initial deployment** unless explicitly populated via the historical backfill worker (`BACKFILL_START_LEDGER`). A query for transactions from last month will return 0 rows on a fresh cluster even though those transactions occurred on-chain.

### B. Ledger Skipping on Retry Exhaustion
- **Behavior**: If an individual ledger fails to fetch or process after `LEDGER_RETRY_ATTEMPTS` (default: 3 attempts with exponential backoff), the inline loop logs an error and skips the ledger so the cursor can continue tracking the live chain.
- **Limitation**: Temporary network timeouts or upstream Horizon errors can introduce sequence gaps in `ledgers`, `transactions`, and `operations`.
- **Mitigation**: Skipped ledgers are enqueued into `ledger_retry_queue` and tracked in `failed_ledgers`. They are subsequently repaired by `RetryWorker` and the periodic `repairLedgerGaps()` job (see Section 4).

### C. Soroban Event Per-Cycle Truncation (`MAX_EVENTS_PER_CYCLE = 200`)
- **Behavior**: Soroban RPC `getEvents` returns up to `MAX_EVENTS_PER_CYCLE` (default: 200 events) per poll cycle. If more than 200 events occurred during the queried ledger range, the response is marked `truncated: true`.
- **Limitation**: In high-throughput contract environments, contract events are not written instantaneously in the same poll tick. Remaining events are fetched in subsequent poll ticks as the cursor advances, creating a temporary ingestion lag for contract events relative to ledger headers.

### D. Soroban RPC Retention Window Exceeded
- **Behavior**: Public Soroban RPC nodes retain historical contract events for a finite sliding window (typically ~100,000 to 200,000 ledgers, or approximately 7–14 days).
- **Limitation**: If an indexer instance is paused or offline longer than the RPC node's retention window, `loop.eventsCursor` will fall behind the oldest available ledger. Soroban RPC does not return errors when querying past ledgers; it silently returns empty event arrays.
- **Automatic Recovery**: The indexer detects when `loop.eventsCursor < oldestAvailable` using `getRetentionInfo()` and automatically jumps the cursor forward to `oldestAvailable`, incrementing the `soroban_retention_window_exceeded` metric. Historical events in the lost window cannot be recovered from Soroban RPC.

### E. Data Retention & Pruning
- **Behavior**: When retention policies are enabled (`RETENTION_ENABLED=true`), background jobs (`pruneExpiredData`) periodically delete rows older than configured windows (e.g. 30 days for transactions, 90 days for operations).
- **Limitation**: Historical records beyond the retention horizon are permanently removed. Bulk-export consumers requiring permanent archives must consume events via real-time streams or export pipelines before pruning.

---

## 3. How to Detect Data Gaps

Consumers can verify data completeness and detect gaps using either SQL queries or Prometheus metrics.

### SQL Gap Detection Queries

#### 1. Find Ledger Sequence Gaps
To detect missing ledger numbers between the minimum and maximum indexed sequence:
```sql
SELECT 
    sequence + 1 AS gap_start, 
    next_seq - 1 AS gap_end,
    (next_seq - sequence - 1) AS missing_ledgers
FROM (
    SELECT 
        sequence, 
        LEAD(sequence) OVER (ORDER BY sequence) AS next_seq
    FROM ledgers
    WHERE network = 'mainnet'
) sub
WHERE next_seq > sequence + 1;
```

#### 2. Inspect Failed and Unresolved Ledgers
Check for ledgers that encountered permanent or pending ingestion errors:
```sql
-- Ledgers that failed inline ingestion
SELECT sequence, network, attempt_count, error, failed_at 
FROM failed_ledgers 
ORDER BY sequence DESC;

-- Ledgers currently waiting in the retry queue
SELECT ledger, network, attempt_count, next_attempt_at, last_error, permanently_failed 
FROM ledger_retry_queue 
WHERE NOT permanently_failed;
```

#### 3. Inspect Soroban Event Ledger Continuity
```sql
SELECT 
    contract_id,
    ledger + 1 AS gap_start,
    next_ledger - 1 AS gap_end
FROM (
    SELECT 
        contract_id,
        ledger,
        LEAD(ledger) OVER (PARTITION BY contract_id ORDER BY ledger) AS next_ledger
    FROM contract_events
    WHERE network = 'mainnet'
) sub
WHERE next_ledger > ledger + 1;
```

### Prometheus Metrics for Monitoring Completeness

| Metric Name | Type | Description | Alerting Threshold |
| :--- | :--- | :--- | :--- |
| `indexer_ledger_gaps_count` | Gauge | Number of missing ledger sequence numbers detected below the tip. | `> 0` for > 15 minutes |
| `indexer_errors_total{loop="ledger"}` | Counter | Cumulative failures during inline ledger ingestion. | Rate > 0.05 / sec |
| `indexer_soroban_events_truncated_total` | Counter | Number of times Soroban `getEvents` exceeded the 200 event page limit. | Informational / capacity alert |
| `indexer_soroban_retention_window_exceeded_total`| Counter | Soroban event cursor fell behind RPC retention, causing skipped ledgers. | `> 0` (Indicates permanent event loss) |
| `indexer_account_cache_size` | Gauge | Active account addresses in the LRU rate-limit protection cache. | N/A |

---

## 4. How Completeness is Repaired & Improved

Lumina provides three automated mechanisms to restore data completeness:

### 1. In-Loop Gap Repair (`repairLedgerGaps`)
Every 30 seconds (`GAP_REPAIR_EVERY_N_TICKS`), the main indexer loop calls `repairLedgerGaps()`. This function:
1. Queries `findLedgerGaps(pool, network, batchLimit = 10)` to identify missing sequence numbers.
2. Ingests missing ledgers out-of-order.
3. Automatically closes sequence holes created by transient network blips.

### 2. Durable Background Retry Worker (`RetryWorker`)
A dedicated background daemon (`RetryWorker`) runs every 30 seconds independently of the main loop. It:
1. Inspects `ledger_retry_queue` for rows where `next_attempt_at <= NOW() AND NOT permanently_failed`.
2. Attempts to fetch and index the ledger.
3. On success, removes the ledger from `ledger_retry_queue` and calls `clearFailedLedger()`.
4. On failure, calculates exponential backoff and increments `attempt_count` (marking `permanently_failed = true` after 10 attempts).

### 3. Historical Backfill Worker (`runBackfillWorker`)
To populate historical data prior to startup:
- Configure `BACKFILL_START_LEDGER=<earliest_ledger_needed>`.
- The worker runs asynchronously in the background, walking backwards ledger-by-ledger (`curr - 1`).
- Uses throttled Horizon requests (`RequestPurpose = 'backfill'`) so historical ingestion never contends with real-time tip synchronization.
- Tracks state in `backfill_progress` so backfill resumes gracefully across service restarts.

---

## Summary Checklist for API Consumers

- [ ] **Do not assume Genesis completeness**: Check `MIN(sequence)` in `ledgers` before executing historical range queries.
- [ ] **Account for event latency**: Wait at least 3 ledgers (~15 seconds) past transaction confirmation before asserting Soroban contract event presence.
- [ ] **Monitor `indexer_ledger_gaps_count`**: Integrate gap monitoring into automated pipeline health checks.
- [ ] **Handle skipped ledgers**: Design downstream aggregators to tolerate sequence gaps or query `failed_ledgers` to verify ledger validity.
