# Contract Storage Indexing

This document describes the contract storage indexing feature, which tracks Soroban contract storage entries and their historical changes.

## Overview

The indexer polls Soroban RPC's `getLedgerEntries` endpoint to fetch contract storage values and maintains:

1. **Current state** (`contract_storage_entries` table) - The latest value of each storage key
2. **Change history** (`contract_storage_history` table) - Append-only log of all value changes

## Architecture

### Tables

#### contract_storage_entries

Current storage values, keyed by `(contract_id, key, network)`:

- `contract_id`: Contract address (C... encoded)
- `key`: LedgerKey XDR (base64) - the full key used in `getLedgerEntries` calls
- `durability`: `persistent` or `temporary`
- `state`: `active` (currently live) or `archived` (TTL expired, inaccessible)
- `value`: Decoded native value (JSONB)
- `value_xdr`: Raw LedgerEntryData XDR (base64)
- `live_until_ledger`: When the entry's TTL expires (if reported by RPC)
- `last_modified_ledger`: Last ledger where this entry changed
- `network`: Network identifier

#### contract_storage_history

Append-only change log, keyed by `(contract_id, key, last_modified_ledger, network)`:

- Same fields as `contract_storage_entries` except `state` (history entries are never archived)
- Each value change creates a new row
- Enables time-travel queries: "what was the value at ledger N?"

### State Tracking

Storage entries have three possible states:

1. **Active**: Currently live in the RPC (row in `contract_storage_entries` with `state = 'active'`)
2. **Archived**: Previously active, TTL expired (row with `state = 'archived'`)
3. **Absent**: Never seen (no row at all)

The distinction matters:

- **Archived** entries were once active and can be restored (if their TTL is extended)
- **Absent** entries have never existed or have never been polled

### Key Discovery

The indexer maintains a watch list per network that includes:

1. **Seed keys** from `INDEXED_CONTRACT_STORAGE_KEYS` environment variable (base64 LedgerKey XDRs)
2. **Tracked keys** from the database - any key ever seen on this network

A key is never silently dropped from the watch list, so archival detection is reliable.

### Archival Detection

When a watched key stops appearing in `getLedgerEntries` responses:

- If the key was previously `active`: mark it `archived`
- If the key was never seen: remain `absent` (no row)
- If the key was already `archived`: no-op

This prevents false archival signals from transient RPC issues.

## Configuration

### Required

- `SOROBAN_RPC_URL`: RPC endpoint (storage indexing requires Soroban RPC)
- `INDEXED_CONTRACT_STORAGE_KEYS`: Comma-separated base64 LedgerKey XDRs to seed the watch list

### Optional

- `STORAGE_HISTORY_RETENTION_LEDGERS`: How many ledgers of history to keep (default: 500,000)
  - History older than `current_ledger - retention_ledgers` is pruned
  - Set to a large value to retain more history; set to 0 to disable pruning

## Decoding

Storage values are decoded using `@stellar/stellar-sdk`'s `scValToNative`:

- All ScVal types are supported: scalars, maps, vectors, structs, bytes, addresses, symbols
- **i128/u128** decode to JavaScript `bigint` to preserve precision above 2^53
- Decoded values are stored as JSONB using `bigintReplacer` (converts bigints to strings)
- Raw XDR is preserved alongside decoded values for round-tripping

### Error Handling

The new `decodeScVal` function returns a structured result:

```typescript
type DecodeScValResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };
```

Undecodable entries are reported rather than silently dropped, making schema mismatches visible.

## Retention Policy

History is unbounded by default but can be pruned:

- `pruneContractStorageHistory(pool, network, retentionLedgers)` deletes entries older than the window
- Run periodically (e.g., daily) to bound storage growth
- The retention window should be long enough for your use case (time-travel queries, audits, etc.)

Example:

```typescript
// Keep 500,000 ledgers of history (~35 days at 5s/ledger)
await pruneContractStorageHistory(pool, "mainnet", 500_000);
```

## Querying

### Current value

```sql
SELECT value, last_modified_ledger
FROM contract_storage_entries
WHERE contract_id = 'CABC...' AND key = '<base64-ledger-key>' AND network = 'mainnet';
```

### Historical value at ledger N

```sql
SELECT value, last_modified_ledger
FROM contract_storage_history
WHERE contract_id = 'CABC...'
  AND key = '<base64-ledger-key>'
  AND network = 'mainnet'
  AND last_modified_ledger <= N
ORDER BY last_modified_ledger DESC
LIMIT 1;
```

If no row is found in history, check `contract_storage_entries` - it may have been the initial value.

### All changes in a ledger range

```sql
SELECT contract_id, key, value, last_modified_ledger
FROM contract_storage_history
WHERE contract_id = 'CABC...'
  AND network = 'mainnet'
  AND last_modified_ledger BETWEEN A AND B
ORDER BY last_modified_ledger DESC;
```

## Limitations

### Key Discovery

Storage keys must be provided explicitly via `INDEXED_CONTRACT_STORAGE_KEYS` or discovered through the database. The indexer does not enumerate a contract's storage automatically because:

- `getLedgerEntries` requires explicit keys (not a contract-wide scan)
- Enumerating keys would require walking the ledger or parsing events for key references

Future work could:

- Extract keys from contract events (e.g., `transfer` events reference balance keys)
- Maintain a registry of interesting keys per contract type
- Support contract-specific key generation patterns

### Performance

- `getLedgerEntries` has a limit of 200 keys per call
- Large watch lists are batched automatically
- History writes are per-entry (one INSERT per changed value)
- Consider indexing and retention tuning for high-throughput contracts

## Related Issues

This feature addresses:

- #85: Contract storage table (current values)
- #86: Fetch entries via getLedgerEntries (RPC integration)
- #87: Decode ScVal keys and values (type coverage + error reporting)
- #88: Track state changes over time (history table + retention)
