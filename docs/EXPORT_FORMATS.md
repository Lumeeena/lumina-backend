# Export formats and schemas

Part of #10. This document is the reference for reading a Lumina export: what
each column means, **what unit every number is in**, and a worked example that
loads an export end to end.

The single most important thing to get right here is units. Lumina mixes two
conventions in the same row, and reading one as the other silently produces
numbers that are wrong by a factor of 10 million:

| Convention | Where it appears | How to read it |
|---|---|---|
| **Stroops** (integer, 1 XLM = 10,000,000) | `ledgers.base_fee`, `ledgers.base_reserve`, `transactions.fee_charged` | A plain integer. `100` = 0.00001 XLM. |
| **Decimal string** (already scaled, 7 dp) | `operations.details->>'amount'`, `accounts.balances[].balance` | Already in XLM. `"100.0000000"` = 100 XLM. |
| **Raw contract integer** (contract's own scale) | `custom_events.fields` values typed `i128`/`u128` | An integer the contract chose the scale of. **Not** XLM and **not** stroops. |

Fees are stroops; transfer amounts are decimal; a Soroban token amount is
whatever the contract's decimals say. Nothing in the export rescales between
them.

## The two export formats

There are two, and they cover different tables.

### 1. CSV — `GET /export/:table` (per table, on demand)

Streams one table as CSV with a header row. Available for `ledgers`,
`transactions` and `operations`. The header names are exactly the column names
in the tables below, and each row is one record.

| Query parameter | Meaning |
|---|---|
| `min_ledger`, `max_ledger` | Ledger range (`sequence` for `ledgers`, `ledger` for the others) |
| `min_date`, `max_date` | Time range (`closed_at` for `ledgers`, `created_at` for the others) |

```bash
curl -H "X-Api-Key: $KEY" \
  "http://localhost:4000/export/transactions?min_ledger=52000000&max_ledger=52001000"
```

Because each call is one table, a full export is one request per table.

### 2. NDJSON — scheduled export (all tables at once)

When `S3_EXPORT_BUCKET` is set, the GraphQL service periodically writes one
newline-delimited JSON file to S3, containing **all** indexed data tables in one
pass. See `docs/POSTGRES_OPERATIONS.md` for the bucket, prefix, interval and
retention settings.

Each line is one record, wrapped in its table name:

```json
{"table":"transactions","record":{"hash":"...","ledger":52123456,"fee_charged":100,...}}
```

The tables included are `ledgers`, `transactions`, `operations`, `accounts`,
`contract_events`, `contract_schemas` and `custom_events`, in that order. **API
keys are deliberately excluded** — an export never contains credentials.

`record` is the row exactly as Postgres returned it: no renaming, no
rescaling, no reordering. So the column tables below describe both formats.

## Columns, per table

`network` appears in every table. Every row belongs to exactly one Stellar
network, and a transaction hash or ledger sequence can repeat across them, so
**filter on `network` before joining anything**. Without it, mainnet and testnet
rows with the same hash will join into each other.

### `ledgers`

| Column | Type | Meaning |
|---|---|---|
| `sequence` | bigint | Ledger number. Also the primary key (with `network`). |
| `closed_at` | timestamptz | When the ledger closed. |
| `transaction_count` | integer | Successful **and** failed transactions. |
| `operation_count` | integer | Operations in the ledger. |
| `base_fee` | bigint | Fee per operation, **in stroops**. |
| `base_reserve` | bigint | Base reserve, **in stroops**. |
| `indexed_at` | timestamptz | When Lumina wrote this row — not a chain time. |
| `network` | text | `mainnet`, `testnet`, … |

### `transactions`

| Column | Type | Meaning |
|---|---|---|
| `hash` | text | Transaction hash. Primary key (with `network`). |
| `ledger` | bigint | Ledger containing it. |
| `created_at` | timestamptz | Transaction time. |
| `source_account` | text | Fee-payer / source account. |
| `fee_charged` | bigint | **Stroops.** The fee actually paid. |
| `operation_count` | smallint | Operations in this transaction. |
| `successful` | boolean | Whether it succeeded. |
| `memo_type` | text | `text`, `id`, `hash`, `return`, or null. |
| `memo` | text | The memo body; null when `memo_type` is null. |
| `indexed_at` | timestamptz | When Lumina wrote this row. |
| `network` | text | Network this was seen on. |

### `operations`

| Column | Type | Meaning |
|---|---|---|
| `id` | text | Operation id, unique per network. |
| `type` | text | Operation type, **lowercase** (`payment`, `create_account`, …). |
| `transaction_hash` | text | Owning transaction. Joins to `transactions.hash`. |
| `ledger` | bigint | Ledger the operation is in. |
| `created_at` | timestamptz | Operation time. |
| `source_account` | text | Account that submitted it. |
| `details` | jsonb | **The type-specific fields.** See below. |
| `indexed_at` | timestamptz | When Lumina wrote this row. |
| `network` | text | Network this was seen on. |

`details` is the Horizon operation record, unflattened, so the columns differ per
`type`. The common ones:

| `details` key | Applies to | Meaning |
|---|---|---|
| `amount` | `payment`, `path_payment_*` | **Decimal string** already in XLM. `"100.0000000"` = 100 XLM. |
| `asset_type` | payment/offer | `native`, `credit_alphanum4`, … |
| `asset_code`, `asset_issuer` | credit assets | The asset, when not native |
| `from`, `to` | `payment`, `path_payment_*` | Counterparties |
| `starting_balance` | `create_account` | **Decimal string** in XLM |
| `funder` | `create_account` | Funding account |
| `offer_id`, `price`, `selling`, `buying` | `manage_sell_offer` | Offer terms; `price` is a **decimal string** |
| `limit` | `change_trust`, `allow_trust` | Trustline limit, **decimal string** |
| `account` | `account_merge`, sponsored ops | Affected account |
| `signer_key`, `signer_weight`, `*_threshold` | `set_options` | Account options |
| `data_name`, `data_value` | `manage_data` | Account data entries |

Amounts inside `details` are **strings, not numbers**. Parse them as decimal
(`decimal.Decimal` in Python, `BigInt`/string in JS) — never as a float.

### `accounts`

A **last-seen snapshot**, not current ledger state: Lumina writes a row when it
sees activity for an address, and updates it then. An account with no recent
activity will not be refreshed, so `balances` can lag the chain. Do not treat it
as authoritative current state.

| Column | Type | Meaning |
|---|---|---|
| `address` | text | Account ID. Primary key (with `network`). |
| `sequence` | text | Account sequence number, as text. |
| `subentry_count` | integer | Subentries (trustlines, offers, data…). |
| `last_modified_ledger` | bigint | Last ledger that changed this account. **The high-water mark for incremental syncs.** |
| `num_sponsored`, `num_sponsoring` | integer | Sponsorship counts. |
| `balances` | jsonb | Array of `{ balance, asset_type, asset_code?, asset_issuer?, limit? }`. **`balance` is a decimal string in XLM.** |
| `flags` | jsonb | `{ auth_required, auth_revocable, auth_immutable, auth_clawback_enabled }` |
| `thresholds` | jsonb | `{ low_threshold, med_threshold, high_threshold }` |
| `indexed_at` | timestamptz | First write. |
| `updated_at` | timestamptz | Last update — compare against `indexed_at` to detect staleness. |
| `network` | text | Network. |

### `contract_events` (Soroban)

| Column | Type | Meaning |
|---|---|---|
| `id` | text | Event id. Primary key (with `network`). |
| `type` | text | `contract`. |
| `contract_id` | text | Emitting contract. |
| `ledger` | bigint | Ledger the event was emitted in. |
| `created_at` | timestamptz | Ledger close time. |
| `paging_token` | text | Event's position in the ledger. |
| `topics` | text[] | Decoded topics, each **JSON-encoded** (`'"swap"'`, not `swap`). |
| `value` | jsonb | Decoded event value, or null. |
| `indexed_at` | timestamptz | When Lumina wrote this row. |
| `network` | text | Network. |

A topic that looks like `"\"swap\""` is JSON-encoded once more on purpose: a
topic is a `ScVal` of any type, so it is stringified as JSON to stay
type-preserving. Parse with `JSON.parse` rather than stripping quotes by hand.

### `contract_schemas`

One row per contract that registered a custom event schema (see
`docs/CUSTOM_SCHEMAS.md`).

| Column | Type | Meaning |
|---|---|---|
| `contract_id` | text | Contract. Primary key (with `network`). |
| `version` | integer | Schema version. |
| `definition` | jsonb | The registered schema, whole. |
| `created_at`, `updated_at` | timestamptz | First/last write. |
| `network` | text | Network. |

### `custom_events`

Events decoded against the schema above.

| Column | Type | Meaning |
|---|---|---|
| `event_id` | text | Source `contract_events.id`. |
| `contract_id` | text | Emitting contract. |
| `event_name` | text | Event name from the schema. |
| `ledger` | bigint | Ledger. |
| `created_at` | timestamptz | Ledger close time. |
| `schema_version` | integer | Which schema version decoded this. |
| `fields` | jsonb | `{ name: value, … }`, decoded per the schema. |
| `indexed_at` | timestamptz | When Lumina wrote this row. |
| `network` | text | Network. |

Primary key is `(event_id, event_name, network)`.

`fields` values are **strings**, and that is deliberate: the type this feature
exists for is `i128`, which does not fit a JSON number. An `i128` token amount is
carried as canonical decimal text (`"1208925819614629174706176"`) and is in the
**contract's own scale** — not XLM, not stroops. The schema's declared `type` is
what tells you how to parse it.

### `contract_storage_entries` (Soroban)

**Not currently included in either export format** — the table is documented
here so the schema is described in one place, but read it through the
`contractStorageEntries` GraphQL query. See `docs/API_GUIDE.md` for that query
and the archived-vs-absent distinction.

| Column | Type | Meaning |
|---|---|---|
| `contract_id` | text | Contract. |
| `key` | text | **Base64 XDR `LedgerKey`** addressing the entry. |
| `durability` | text | `persistent` or `temporary`. |
| `state` | text | `active` or `archived`. |
| `value` | jsonb | Decoded value, or null when archived. |
| `value_xdr` | text | Raw base64 `LedgerEntryData` XDR, or null when archived. |
| `live_until_ledger` | bigint | Ledger at which the TTL expires, if known. |
| `last_modified_ledger` | bigint | Last change. |
| `indexed_at` | timestamptz | When Lumina wrote this row. |
| `network` | text | Network. |

## Worked example: load an export and interpret it

Download the CSV for one table, then read it with a decimal type so nothing is
rounded. `jq` is not used here because it parses JSON numbers as doubles, which
loses precision on exactly the large integers this data contains.

```bash
curl -H "X-Api-Key: $KEY" \
  "http://localhost:4000/export/transactions?min_ledger=52120000&max_ledger=52121000" \
  -o transactions.csv
```

```python
import csv
from decimal import Decimal

STROOPS = Decimal(10_000_000)   # 1 XLM

with open("transactions.csv", newline="") as handle:
    for row in csv.DictReader(handle):
        # fee_charged is an integer count of stroops -> divide to get XLM.
        fee_xlm = Decimal(row["fee_charged"]) / STROOPS

        # operation_count is a plain count, and must never be negative.
        assert int(row["operation_count"]) >= 0

        # No floats anywhere: Decimal all the way through.
        print(row["hash"], row["network"], row["operation_count"], fee_xlm)
```

The same rows from the NDJSON export, where the wrapper carries the table name:

```python
import json
from decimal import Decimal

STROOPS = Decimal(10_000_000)

with open("lumina-export.ndjson") as handle:
    for line in handle:
        record = json.loads(line)
        if record["table"] != "transactions":
            continue
        row = record["record"]
        fee_xlm = Decimal(row["fee_charged"]) / STROOPS
        print(row["hash"], fee_xlm)
```

And joining operations to their transaction — always scoped by `network`, which
is what stops a testnet row joining onto a mainnet row with the same hash:

```python
from decimal import Decimal

txs = {}   # (hash, network) -> transaction
ops = []   # operations to resolve

with open("lumina-export.ndjson") as handle:
    for line in handle:
        record = json.loads(line)
        table, row = record["table"], record["record"]
        if table == "transactions":
            txs[(row["hash"], row["network"])] = row
        elif table == "operations":
            ops.append(row)

for op in ops:
    tx = txs.get((op["transaction_hash"], op["network"]))
    if tx is None:
        continue                      # transaction outside this export's range
    # operation amount is ALREADY decimal in XLM - do not divide by stroops.
    amount = op["details"].get("amount")
    if amount is not None:
        print(tx["hash"], op["type"], Decimal(amount))
```

The two things to carry away: **fees are stroops, transfer amounts are already
decimal**, and **every join needs `network`**.

## Incremental syncs

Each table has a ledger column to sync on: `sequence` for `ledgers`, `ledger` for
`transactions`, `operations`, `contract_events` and `custom_events`, and
`last_modified_ledger` for `accounts`. `contract_schemas` has no ledger column,
so it is not eligible for ledger-based incremental sync.

For the CSV endpoint, pass the range as `min_ledger` and track the highest
`ledger` you stored per table. For the scheduled NDJSON export, store the
maximum ledger value seen and only take rows above it next time.

Because `accounts` is a snapshot rather than a history, sync it on
`last_modified_ledger` and re-read the whole row — there is no per-change
history for that table.
