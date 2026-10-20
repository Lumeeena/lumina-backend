/**
 * Mainnet operations from Horizon, cached on disk, for the audits that replay
 * real traffic through the indexer's write path (trustlines.ts, assets.ts).
 *
 * Both audits act on the same operation types, so one `fetch` serves both and
 * their numbers come from the same stretch of ledgers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { HorizonOperation } from '../../indexer/src/horizon';

export const HORIZON_URL = process.env.AUDIT_HORIZON_URL ?? 'https://horizon.stellar.org';
export const OPS_CACHE = process.env.AUDIT_OPS_CACHE ?? join(__dirname, '.cache', 'mainnet-ops.json');

/** The operation types processAssetOperation acts on; everything else is a no-op. */
const ASSET_OPS = new Set([
  'change_trust', 'payment', 'path_payment_strict_send', 'path_payment_strict_receive',
]);

export interface OpsCache {
  horizon: string;
  fromLedger: number;
  toLedger: number;
  scanned: number;
  ops: HorizonOperation[];
}

/**
 * GET a Horizon URL as JSON, waiting out a 429 rather than failing. A dropped
 * connection is retried too, a bounded number of times: a long walk (the
 * operations audit fetches thousands of pages) otherwise dies on one blip.
 */
export async function horizonGet<T>(url: string): Promise<T> {
  for (let failures = 0; ;) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (++failures > 5) throw err;
      process.stderr.write(`request failed (${err instanceof Error ? err.message : err}), retrying in ${failures * 5}s\n`);
      await new Promise(r => setTimeout(r, failures * 5_000));
      continue;
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 10);
      process.stderr.write(`rate limited, waiting ${wait}s\n`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Horizon ${res.status} on ${url}`);
    return await res.json() as T;
  }
}

export async function fetchOps(pages: number): Promise<void> {
  // Start a fixed distance behind the tip and page forward, so the replay sees
  // ledgers in the order the indexer does and the cursor never chases the tip.
  const tip = await horizonGet<{ _embedded: { records: { sequence: number }[] } }>(
    `${HORIZON_URL}/ledgers?order=desc&limit=1`
  );
  const startLedger = tip._embedded.records[0].sequence - 20_000;
  let cursor = (BigInt(startLedger) << 32n).toString();
  const ops: HorizonOperation[] = [];
  let scanned = 0;
  let lastLedger = startLedger;

  for (let page = 0; page < pages; page++) {
    const body = await horizonGet<{ _embedded: { records: (HorizonOperation & { paging_token: string })[] } }>(
      `${HORIZON_URL}/operations?order=asc&limit=200&cursor=${cursor}`
    );
    const records = body._embedded.records;
    if (records.length === 0) break;
    for (const op of records) {
      scanned++;
      // The paging token's high 32 bits are the ledger sequence.
      lastLedger = Number(BigInt(op.paging_token) >> 32n);
      if (ASSET_OPS.has(op.type)) ops.push({ ...op, ledger: lastLedger } as HorizonOperation);
    }
    cursor = records[records.length - 1].paging_token;
    if (page % 25 === 0) process.stderr.write(`page ${page}: ${scanned} scanned, ${ops.length} kept, ledger ${lastLedger}\n`);
  }

  mkdirSync(join(OPS_CACHE, '..'), { recursive: true });
  const cache: OpsCache = { horizon: HORIZON_URL, fromLedger: startLedger, toLedger: lastLedger, scanned, ops };
  writeFileSync(OPS_CACHE, JSON.stringify(cache));
  console.log(`cached ${ops.length} asset operations (of ${scanned}) from ledgers ${startLedger}-${lastLedger} to ${OPS_CACHE}`);
}

export function loadOps(): OpsCache {
  if (!existsSync(OPS_CACHE)) throw new Error(`no cached operations at ${OPS_CACHE}; run "fetch" first`);
  return JSON.parse(readFileSync(OPS_CACHE, 'utf8')) as OpsCache;
}

/** Cached operations grouped by ledger, in ledger order: one transaction each, as indexLedger does. */
export function opsByLedger(cache: OpsCache): Map<number, HorizonOperation[]> {
  const byLedger = new Map<number, HorizonOperation[]>();
  for (const op of cache.ops) {
    const ledger = (op as unknown as { ledger: number }).ledger;
    const list = byLedger.get(ledger) ?? [];
    list.push(op);
    byLedger.set(ledger, list);
  }
  return byLedger;
}
