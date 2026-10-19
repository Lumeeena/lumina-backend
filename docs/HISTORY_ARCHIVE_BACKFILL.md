# Stellar history archive backfill

Set `HISTORY_ARCHIVE_URL` for a single-network deployment or
`<NAME>_HISTORY_ARCHIVE_URL` for a network declared in `NETWORKS`. The value is
the archive root, not a ledger-specific URL. The indexer uses archive files
for the configured backwards backfill worker and sends the decoded ledger,
transaction, and operation rows through the same `indexLedger` database write
path used by live indexing. If no archive URL is configured, the existing
Horizon backfill remains available. A configured archive is authoritative:
request or decode failures are retried and reported rather than silently
falling back to Horizon.

The reader fetches Stellar Core's standard 64-ledger checkpoint files for
ledger headers, transaction sets, and transaction results. It caches one
checkpoint while walking its ledgers. Checkpoint files are gzip-compressed
XDR record streams, and the ledger sequence and transaction-result hashes are
validated when decoding.

## Archive sources and retention

The Stellar Development Foundation publishes public history archives at:

| Network | Archive root |
| --- | --- |
| Mainnet | `https://history.stellar.org/prd/core-live/core_live_001` |
| Testnet | `https://history.stellar.org/prd/core-testnet/core_testnet_001` |

These public roots are convenient archive sources, not a retention or
availability guarantee made by this application. Archive operators control
what checkpoints they retain. Before a large backfill, verify that the
configured root serves the checkpoint range needed by `BACKFILL_START_LEDGER`
and `BACKFILL_END_LEDGER`; a missing ledger checkpoint is surfaced as a
backfill failure. For self-hosted archives, configure the root and retention
policy with that archive's operator.

The archive is used only for historical backfill, not for the live tip: a
checkpoint is published periodically and may not yet contain the newest
ledgers. Forward indexing and ordinary catch-up continue to use Horizon.

Example for a single-network mainnet deployment:

```sh
HISTORY_ARCHIVE_URL=https://history.stellar.org/prd/core-live/core_live_001
BACKFILL_START_LEDGER=1000000
BACKFILL_END_LEDGER=1100000
```

For a multi-network deployment, set the network-specific variable instead,
for example `MAINNET_HISTORY_ARCHIVE_URL`.
