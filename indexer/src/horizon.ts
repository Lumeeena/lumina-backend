/**
 * Typed Horizon client for the indexer. Kept independent of the frontend's and
 * graphql-server's Horizon clients so this service has no cross-package imports.
 */

import { horizonRequestDuration, horizonRequests } from './metrics';
import { subsystem } from './logger';
import { createThrottle } from './throttle';

const log = subsystem('horizon');

export const PAGE_LIMIT = 200;

export interface HorizonLedger {
  sequence: number;
  closed_at: string;
  successful_transaction_count: number;
  failed_transaction_count: number;
  operation_count: number;
  base_fee_in_stroops: number;
  base_reserve_in_stroops: number;
}

export interface HorizonTransaction {
  hash: string;
  ledger: number;
  created_at: string;
  source_account: string;
  fee_charged: string;
  operation_count: number;
  successful: boolean;
  memo_type: string;
  memo?: string;
}

export interface HorizonOperation {
  id: string;
  type: string;
  transaction_hash: string;
  created_at: string;
  source_account: string;
  [key: string]: unknown;
}

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
}

export interface HorizonAccount {
  account_id: string;
  sequence: string;
  subentry_count: number;
  last_modified_ledger: number;
  num_sponsored: number;
  num_sponsoring: number;
  balances: HorizonBalance[];
  flags: { auth_required: boolean; auth_revocable: boolean; auth_immutable: boolean; auth_clawback_enabled: boolean };
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
}

interface HorizonPage<T> {
  _embedded: { records: T[] };
  _links: { next?: { href: string } };
}

const MIN_REQUEST_INTERVAL_MS = parseInt(process.env.HORIZON_MIN_REQUEST_INTERVAL_MS ?? '100', 10);

const { throttle, fetchJson, postJson } = createThrottle({
  name: 'horizon',
  minIntervalMs: MIN_REQUEST_INTERVAL_MS,
  metrics: {
    requestsTotal: horizonRequests,
    requestDuration: horizonRequestDuration,
  },
});

async function fetchAllPages<T>(url: string): Promise<T[]> {
  const records: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const page: HorizonPage<T> = await fetchJson<HorizonPage<T>>(next);
    records.push(...page._embedded.records);
    next = page._embedded.records.length === PAGE_LIMIT ? page._links.next?.href : undefined;
  }
  return records;
}

export async function getLatestLedgerSequence(horizonUrl: string): Promise<number> {
  const page = await fetchJson<HorizonPage<HorizonLedger>>(`${horizonUrl}/ledgers?order=desc&limit=1`);
  return page._embedded.records[0]?.sequence ?? 0;
}

export function getLedger(horizonUrl: string, sequence: number): Promise<HorizonLedger> {
  return fetchJson<HorizonLedger>(`${horizonUrl}/ledgers/${sequence}`);
}

export function getLedgerTransactions(horizonUrl: string, sequence: number): Promise<HorizonTransaction[]> {
  return fetchAllPages<HorizonTransaction>(
    `${horizonUrl}/ledgers/${sequence}/transactions?order=asc&limit=${PAGE_LIMIT}`
  );
}

export function getLedgerOperations(horizonUrl: string, sequence: number): Promise<HorizonOperation[]> {
  return fetchAllPages<HorizonOperation>(
    `${horizonUrl}/ledgers/${sequence}/operations?order=asc&limit=${PAGE_LIMIT}`
  );
}

/** Returns null (rather than throwing) for accounts that don't exist or have been merged away. */
export async function getAccount(horizonUrl: string, address: string): Promise<HorizonAccount | null> {
  const stopTimer = horizonRequestDuration.startTimer();
  let res: Response;
  try {
    res = await fetch(`${horizonUrl}/accounts/${address}`);
  } catch (err) {
    horizonRequests.inc({ status: 'error' });
    stopTimer();
    throw err;
  }
  stopTimer();
  horizonRequests.inc({ status: String(res.status) });

  if (!res.ok) {
    if (res.status !== 404) log.warn({ address, status: res.status }, 'horizon account fetch failed');
    return null;
  }
  return (await res.json()) as HorizonAccount;
}
