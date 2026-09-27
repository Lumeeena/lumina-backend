/**
 * Typed Horizon client for the indexer. Kept independent of the frontend's and
 * graphql-server's Horizon clients so this service has no cross-package imports.
 */

import { horizonRequestDuration, horizonRequests, horizonThrottleInterval, horizonQueuedRequests, horizonWaitTime } from './metrics';
import { subsystem } from './logger';
import { createThrottle, type RequestPurpose } from './throttle';

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

interface HorizonClientConfig {
  minIntervalMs: number;
  maxIntervalMs: number;
  authToken?: string;
  tipWeightFactor: number;
}

let throttle: ReturnType<typeof createThrottle>['throttle'];
let fetchJson: ReturnType<typeof createThrottle>['fetchJson'];
let postJson: ReturnType<typeof createThrottle>['postJson'];

export function initializeHorizonClient(config: HorizonClientConfig): void {
  const client = createThrottle({
    name: 'horizon',
    minIntervalMs: config.minIntervalMs,
    maxIntervalMs: config.maxIntervalMs,
    authToken: config.authToken,
    tipWeightFactor: config.tipWeightFactor,
    metrics: {
      requestsTotal: horizonRequests,
      requestDuration: horizonRequestDuration,
      currentInterval: horizonThrottleInterval,
      queuedRequests: horizonQueuedRequests,
      waitTime: horizonWaitTime,
    },
  });
  
  throttle = client.throttle;
  fetchJson = client.fetchJson;
  postJson = client.postJson;
}

async function fetchAllPages<T>(url: string, purpose: RequestPurpose = 'default'): Promise<T[]> {
  const records: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const page: HorizonPage<T> = await fetchJson<HorizonPage<T>>(next, undefined, purpose);
    records.push(...page._embedded.records);
    next = page._embedded.records.length === PAGE_LIMIT ? page._links.next?.href : undefined;
  }
  return records;
}

export async function getLatestLedgerSequence(horizonUrl: string): Promise<number> {
  const page = await fetchJson<HorizonPage<HorizonLedger>>(`${horizonUrl}/ledgers?order=desc&limit=1`, undefined, 'tip');
  return page._embedded.records[0]?.sequence ?? 0;
}

export function getLedger(horizonUrl: string, sequence: number, purpose: RequestPurpose = 'tip'): Promise<HorizonLedger> {
  return fetchJson<HorizonLedger>(`${horizonUrl}/ledgers/${sequence}`, undefined, purpose);
}

export function getLedgerTransactions(horizonUrl: string, sequence: number, purpose: RequestPurpose = 'tip'): Promise<HorizonTransaction[]> {
  return fetchAllPages<HorizonTransaction>(
    `${horizonUrl}/ledgers/${sequence}/transactions?order=asc&limit=${PAGE_LIMIT}`,
    purpose
  );
}

export function getLedgerOperations(horizonUrl: string, sequence: number, purpose: RequestPurpose = 'tip'): Promise<HorizonOperation[]> {
  return fetchAllPages<HorizonOperation>(
    `${horizonUrl}/ledgers/${sequence}/operations?order=asc&limit=${PAGE_LIMIT}`,
    purpose
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
