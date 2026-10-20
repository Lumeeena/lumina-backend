#!/usr/bin/env node
/**
 * Records the contract test's fixtures: one real mainnet operation for every
 * shape Horizon was seen to return, with the ledger and transaction each
 * belongs to.
 *
 * A "shape" is an operation type plus the set of fields it carried plus the
 * kind of each asset field (native, credit, pool share) — so a native payment,
 * a credit payment and a payment to a muxed account are three shapes, because
 * the server reads them differently. Hand-written fixtures encode what
 * someone believed Horizon returns (see docs/HORIZON_FIXTURES.md); these are
 * what it did return.
 *
 * Reads ledgers cached by the operations audit, so the records are exactly
 * the ones Horizon served:
 *
 *   npm run audit:operations -- fetch 1000
 *   TS_NODE_PROJECT=test/tsconfig.json node --require ts-node/register \
 *     test/contract/recordFixtures.ts db/audit/.cache/mainnet-ledgers.jsonl [more.jsonl ...]
 *
 * Operations and ledgers are kept verbatim — `details` is the operation as
 * Horizon sent it, and that is what the contract is about. Transactions are
 * cached with only the fields indexLedger stores.
 */
import { createReadStream, writeFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

const OUT = join(__dirname, 'fixtures', 'operations.json');
/** Fields every operation has; they do not distinguish one shape from another. */
const COMMON = new Set(['_links', 'id', 'paging_token', 'transaction_successful', 'source_account', 'type', 'type_i', 'created_at', 'transaction_hash']);
const ASSET_TYPE_FIELDS = ['asset_type', 'selling_asset_type', 'buying_asset_type', 'source_asset_type'];

interface CachedLedger {
  ledger: Record<string, unknown> & { sequence: number };
  transactions: Array<Record<string, unknown> & { hash: string }>;
  operations: Array<Record<string, unknown> & { type: string; transaction_hash: string }>;
}

function shapeOf(op: Record<string, unknown>): string {
  const fields = Object.keys(op).filter(k => !COMMON.has(k)).sort();
  const assets = ASSET_TYPE_FIELDS.filter(k => k in op).map(k => {
    const v = op[k];
    return `${k}=${v === 'native' ? 'native' : v === 'liquidity_pool_shares' ? 'pool' : 'credit'}`;
  });
  return `${op['type']}|${fields.join(',')}|${assets.join(',')}`;
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('usage: recordFixtures.ts <ledgers.jsonl> [...]');
  const chosen = new Map<string, { ledger: CachedLedger['ledger']; transaction: CachedLedger['transactions'][number]; operation: CachedLedger['operations'][number] }>();
  let horizonLedgers = 0;
  for (const file of files) {
    for await (const line of createInterface({ input: createReadStream(file) })) {
      if (!line) continue;
      const cached = JSON.parse(line) as CachedLedger;
      horizonLedgers++;
      for (const operation of cached.operations) {
        const shape = shapeOf(operation);
        if (chosen.has(shape)) continue;
        const transaction = cached.transactions.find(t => t.hash === operation.transaction_hash);
        if (!transaction) throw new Error(`operation ${String(operation['id'])} has no transaction in ledger ${cached.ledger.sequence}`);
        chosen.set(shape, { ledger: cached.ledger, transaction, operation });
      }
    }
  }

  // Grouped by ledger, because indexLedger writes one ledger at a time and an
  // operation cannot land without its transaction (operations.transaction_hash
  // is a foreign key).
  const byLedger = new Map<number, CachedLedger>();
  for (const { ledger, transaction, operation } of chosen.values()) {
    const group = byLedger.get(ledger.sequence) ?? { ledger, transactions: [], operations: [] };
    if (!group.transactions.some(t => t.hash === transaction.hash)) group.transactions.push(transaction);
    group.operations.push(operation);
    byLedger.set(ledger.sequence, group);
  }
  const ledgers = [...byLedger.values()].sort((a, b) => a.ledger.sequence - b.ledger.sequence);
  for (const group of ledgers) group.operations.sort((a, b) => (BigInt(String(a['id'])) < BigInt(String(b['id'])) ? -1 : 1));

  writeFileSync(OUT, `${JSON.stringify({
    source: 'https://horizon.stellar.org',
    recorded: new Date().toISOString().slice(0, 10),
    scannedLedgers: horizonLedgers,
    shapes: chosen.size,
    ledgers,
  }, null, 1)}\n`);
  console.log(`recorded ${chosen.size} shapes from ${horizonLedgers} ledgers into ${ledgers.length} fixture ledgers at ${OUT}`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
