# Indexer Control Flow & Architecture Guide

## Overview

The Lumina Indexer (`indexer/src/index.ts`) is a high-throughput, fault-tolerant ingestion daemon that streams blockchain state from Stellar Horizon and Soroban RPC into a PostgreSQL database.

This document serves as an onboarding guide for contributors, detailing:
1. An end-to-end walkthrough of a single polling iteration.
2. The four decoupled cursors and the architectural rationale for their independence.
3. The multi-tiered retry and failure isolation system.
4. The safety-lag and caching mechanisms designed to prevent data loss and rate-limiting.

---

## 1. End-to-End Loop Iteration Walkthrough

The indexer runs one autonomous `NetworkLoop` per configured network (e.g. `mainnet`, `testnet`). Each network runs concurrently inside `runIndependently()` and shares no state, caches, or cursors with other chains.

```
                  ┌──────────────────────────────────────────────┐
                  │              runNetworkLoop()                │
                  └──────────────────────┬───────────────────────┘
                                         │
                         1. Check Cursor Initialization
                                         │
                         2. Periodic Registry Discovery (every N ticks)
                                         │
                         3. Periodic Ledger Gap Repair (every 30s)
                                         │
                         4. Query Horizon Chain Tip (getLatestLedgerSequence)
                                         │
                         5. Ledger Catch-Up Loop (runLedgerCatchUp)
                            ├── Fetch Ledger, Transactions, Operations
                            ├── Account Cache Prune & Refresh Queue
                            └── Persist DB (indexLedger in a transaction)
                                         │
                         6. Poll Contract Events (pollContractEvents)
                            ├── Soroban RPC getEvents (with safety lag)
                            └── Generic & Custom Schema Decoding
                                         │
                         7. Poll Contract Storage (pollContractStorage)
                            ├── getContractStorageEntries
                            └── Detect Archival (active -> archived)
                                         │
                         8. Poll Trades (pollTrades via Horizon paging token)
                                         │
                         9. Sleep for POLL_INTERVAL_MS (default 5000ms)
```

### Detailed Execution Steps

1. **Cursor Initialization**:
   On process start, the loop queries `getLatestIndexedLedger(pool, network)`. If the database is empty:
   - If `START_LEDGER` is configured, it starts at `START_LEDGER - 1`.
   - Otherwise, it queries Horizon for the current chain tip and starts from the tip (see *Indexing Guarantees* for details).
2. **Registry Discovery (`pollRegistry`)**:
   Runs every `REGISTRY_POLL_EVERY_N_TICKS`. Queries the Lumina Registry contract on Soroban to discover newly deployed or registered contract IDs, dynamically updating `discoveredContractIds`. Non-contract addresses (`G...`) are filtered out to protect RPC event filters.
3. **Gap Repair Pass (`repairLedgerGaps`)**:
   Runs every `GAP_REPAIR_EVERY_N_TICKS` (~30 seconds). Scans the `ledgers` table for sequence number gaps below the current tip and attempts to back-index missing ledgers.
4. **Horizon Tip Query**:
   Calls Horizon `/fee_stats` or `/ledgers?order=desc&limit=1` to determine the latest closed ledger sequence number (`latestHorizonLedger`).
5. **Ledger Catch-Up (`runLedgerCatchUp`)**:
   Iterates sequentially from `cursor + 1` up to `latestHorizonLedger`:
   - Fetches ledger metadata, transactions, and operations in parallel (`Promise.all`).
   - Extracts all participating account addresses (`source_account`, destination accounts).
   - Consults the in-memory `accountCache` (see below). Stale accounts are scheduled for background refresh via `account_refresh_queue`.
   - Executes `indexLedger()` within a single database transaction: inserting ledger headers, transactions, and operations atomically.
   - Advances `loop.cursor` sequentially after each successful ledger write.
6. **Soroban Contract Events (`pollContractEvents`)**:
   Fetches smart contract events for watched contracts from Soroban RPC (`getEvents`). Decodes events against generic tables (`contract_events`) and registered schemas (`custom_events`).
7. **Soroban Contract Storage (`pollContractStorage`)**:
   Polls `getLedgerEntries` for all tracked storage keys. Compares returned entries against tracked keys: entries no longer returned by Soroban RPC are flagged as `archived`.
8. **DEX & Path Trades (`pollTrades`)**:
   Polls Horizon `/trades` using string paging tokens, capturing order matches and price discovery.
9. **Throttle & Sleep**:
   Waits `POLL_INTERVAL_MS` (default 5,000 ms) before initiating the next iteration.

---

## 2. The Four Decoupled Cursors

The indexer maintains four completely independent cursors. Decoupling them is a deliberate design requirement driven by the underlying protocols:

| Cursor Name | Stored In / Tracked By | Unit / Format | Purpose |
| :--- | :--- | :--- | :--- |
| **`loop.cursor`** | `ledgers.sequence` | `BIGINT` (Sequential Ledger Sequence) | Ingests core Stellar ledgers, transactions, and operations from Horizon. |
| **`loop.eventsCursor`** | `contract_events.ledger` | `BIGINT` (Ledger Sequence with Safety Lag) | Streams Soroban contract events from Soroban RPC. |
| **`loop.tradesCursor`** | In-memory token & DB | `TEXT` (Horizon Paging Token e.g. `12345-1`) | Tracks executed DEX orderbook and liquidity pool trades from Horizon `/trades`. |
| **`Backfill Cursor`** | `backfill_progress` | `BIGINT` (Descending Ledger Sequence) | Historical backfill worker walking backward (`curr - 1`). |

### Why Are These Cursors Separate?

1. **Horizon Ledger Cursor vs. Soroban Events Cursor**:
   - **Different Infrastructure**: Horizon and Soroban RPC are distinct physical services with independent ingestion pipelines. Horizon streams Classic operations; Soroban RPC indexes WASM contract events.
   - **Different Availability & Lag**: Soroban RPC nodes can lag behind Horizon by several ledgers, or temporarily stall during high-contract-load periods. Binding the Horizon cursor to Soroban would freeze the entire transaction and payment ingestion pipeline whenever Soroban RPC stalls.
   - **Network Mismatch**: A deployment can ingest Horizon transactions on mainnet while pointing its Soroban RPC to testnet for staging contracts.
2. **Horizon Ledger Cursor vs. Trades Cursor**:
   - Trades in Stellar are secondary execution artifacts produced when path payments or DEX offers cross in the orderbook.
   - The `/trades` endpoint does not use integer ledger numbers as its cursor; it uses 64-bit opaque paging tokens (e.g. `113271506972673-1`).
   - Multiple trades can occur in a single ledger, and many ledgers have zero trades. Mapping trades to integer ledger cursors would cause skipped trades or infinite loops on busy ledgers.
3. **Forward Tip Cursor vs. Backfill Cursor**:
   - The primary cursor (`loop.cursor`) must strictly keep up with real-time chain activity at the tip (1 ledger every 5 seconds).
   - Historical backfill walks backwards from `backfillEndLedger` to `backfillStartLedger`.
   - Keeping them separate ensures that heavy historical backfills (which use throttled `RequestPurpose = 'backfill'`) never delay real-time tip ingestion.

---

## 3. Safety-Lag & Caching Reasoning

### The Soroban Safety Lag (`EVENTS_SAFETY_LAG_LEDGERS = 3`)

```
Chain Tip:                    Ledger 105
Soroban RPC latestLedger:     Ledger 105 (Reported)
Soroban RPC Internally Indexed: Ledger 102 (Event still indexing!)
eventsCursor with Safety Lag:  105 - 3 + 1 = Ledger 103
```

- **The Problem**: Soroban RPC's `getEvents` response returns a field called `latestLedger`. In production, this reflects the RPC node's awareness of the current chain tip, **not** a guarantee that the node has finished parsing and storing all events for that ledger. Live testing showed that an event queried at `latestLedger` was absent, but querying the exact same ledger 2 seconds later returned the event.
- **The Solution**: Advancing `eventsCursor` immediately to `latestLedger + 1` permanently skips events that land right on the indexing boundary. Instead, the indexer holds the cursor back:
  ```typescript
  loop.eventsCursor = Math.max(loop.eventsCursor, latestLedger - EVENTS_SAFETY_LAG_LEDGERS + 1);
  ```
- Re-scanning the last 3 ledgers on every poll is computationally cheap and completely idempotent: `insertContractEvents` uses `ON CONFLICT (id, network) DO NOTHING`.

### Account Cache TTL & Size Limits (`ACCOUNT_CACHE_TTL_MS = 60000`, `ACCOUNT_CACHE_MAX_SIZE = 10000`)

- **The Problem**: Active accounts (arbitrage bots, exchange hot wallets, market makers) participate in almost every single ledger (every 5 seconds). Without an in-memory cache, the indexer would query Horizon's `/accounts/<id>` endpoint thousands of times per minute for the same addresses.
- **The Consequence**: This rapidly exhausts Horizon's per-IP rate limit (returning HTTP 429 Too Many Requests), which directly degrades the GraphQL server and external API clients sharing that Horizon gateway.
- **The Mechanism**:
  1. Accounts observed in transactions are checked against an in-memory LRU cache (`loop.accountCache`).
  2. If the address was fetched within `ACCOUNT_CACHE_TTL_MS` (60 seconds), the Horizon lookup is bypassed.
  3. When an account expires, it is added to `account_refresh_queue` and refreshed in background batches (`refreshAccountQueueBatch`).
  4. Cache size is bounded by `ACCOUNT_CACHE_MAX_SIZE` (10,000 entries) with strict LRU eviction (`pruneAccountCache`) to prevent Node.js heap leaks.

---

## 4. Retry Logic & Fault Tolerance

```
[Fetch Ledger] ──(Fails)──> [Attempt 1] ──(Backoff + Jitter)──> [Attempt 2]
                                                                      │
                                                          (Fails 3x Exhausted)
                                                                      │
                                                                      ▼
                                              ┌───────────────────────────────────────┐
                                              │ 1. Record in failed_ledgers           │
                                              │ 2. Enqueue in ledger_retry_queue      │
                                              │ 3. Allow loop cursor to skip forward  │
                                              └───────────────────────────────────────┘
                                                                      │
                                                                      ▼
                                              ┌───────────────────────────────────────┐
                                              │ Background RetryWorker (every 30s)    │
                                              │ Periodic repairLedgerGaps (every 30s) │
                                              └───────────────────────────────────────┘
```

1. **Inline Retries with Jittered Backoff**:
   When `fetchAndIndexLedger` fails (network blip, Horizon timeout), `fetchAndIndexLedgerWithRetry` retries up to `LEDGER_RETRY_ATTEMPTS = 3` times.
   Backoff delay uses exponential backoff with equal jitter (`calculateBackoffWithJitter`):
   $$\text{ceiling} = \min(\text{maxDelayMs}, \text{baseMs} \times 2^{\text{attempt}-1})$$
   $$\text{delay} = \lfloor\text{ceiling} / 2\rfloor + \text{random}(0, \lceil\text{ceiling} / 2\rceil)$$
   *Equal jitter guarantees a minimum deterministic delay while dispersing retry spikes across cluster nodes.*
2. **Failure Persistence & Non-Blocking Progression**:
   If all 3 attempts fail, halting the indexer would freeze downstream consumers. Instead:
   - The failure is logged with high severity.
   - The ledger is recorded in `failed_ledgers` (for audit and alerts).
   - The ledger is enqueued into `ledger_retry_queue` with `next_attempt_at = NOW()`.
   - The inline catch-up loop allows the cursor to advance so live ingestion continues.
3. **Decoupled Recovery (`RetryWorker` & `repairLedgerGaps`)**:
   - `RetryWorker` runs in a background timer every 30 seconds, picking up failed ledgers from `ledger_retry_queue` with exponential backoff up to 10 attempts.
   - `repairLedgerGaps()` runs every 30 seconds, detecting sequence gaps in `ledgers` (`sequence + 1 < next_sequence`) and repairing them out of band.
