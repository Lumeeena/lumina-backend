/**
 * The indexer's Horizon client.
 *
 * The implementation lives in `@lumina/shared` so this service and the GraphQL
 * server cannot drift apart again — the server's copy had no throttle, so the
 * service with the smaller request budget was the one being rate-limited. What
 * stays here is what is specific to the indexer: its metrics registry, its log
 * sink and its pacing knobs.
 *
 * The signatures are unchanged (a Horizon base URL as the first argument), so no
 * call site and no test had to move, and the suite in `horizon.test.ts` now
 * exercises the shared client.
 */
import {
  createHorizonClient,
  type HorizonAccount,
  type HorizonLedger,
  type HorizonOperation,
  type HorizonTransaction,
} from '@lumina/shared';
import {
  horizonRequestDuration,
  horizonRequests,
  horizonThrottleInterval,
  horizonQueuedRequests,
  horizonWaitTime,
} from './metrics';
import { subsystem } from './logger';
import { createThrottle, type RequestPurpose } from './throttle';

const log = subsystem('horizon');

export const PAGE_LIMIT = 200;
const ACCOUNT_REQUEST_TIMEOUT_MS = 10_000; // 10 seconds

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

export type {
  HorizonAccount,
  HorizonBalance,
  HorizonLedger,
  HorizonOperation,
  HorizonTransaction,
} from '@lumina/shared';
export { PAGE_LIMIT } from '@lumina/shared';

interface HorizonClientConfig {
  minIntervalMs: number;
  maxIntervalMs: number;
  authToken?: string;
  tipWeightFactor: number;
}

let throttle: ReturnType<typeof createThrottle>['throttle'];
let fetchJson: ReturnType<typeof createThrottle>['fetchJson'];

const REQUEST_TIMEOUT_MS = parseInt(process.env.HORIZON_REQUEST_TIMEOUT_MS ?? '10000', 10);

export function initializeHorizonClient(config: HorizonClientConfig): void {
  const client = createHorizonClient({
    name: 'horizon',
    minIntervalMs: config.minIntervalMs,
    maxIntervalMs: config.maxIntervalMs,
    authToken: config.authToken,
    tipWeightFactor: config.tipWeightFactor,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    metrics: {
      requestsTotal: horizonRequests,
      requestDuration: horizonRequestDuration,
      currentInterval: horizonThrottleInterval,
      queuedRequests: horizonQueuedRequests,
      waitTime: horizonWaitTime,
    },
    logger: subsystem('horizon'),
  });

  throttle = client.throttle;
  fetchJson = client.fetchJson;
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

export function getLatestLedgerSequence(horizonUrl: string): Promise<number> {
  return client.getLatestLedgerSequence(horizonUrl);
}

export function getLedger(horizonUrl: string, sequence: number, purpose: RequestPurpose = 'tip'): Promise<HorizonLedger> {
  return client.getLedger(sequence, horizonUrl);
}

export function getLedgerTransactions(
  horizonUrl: string,
  sequence: number,
  purpose: RequestPurpose = 'tip'
): Promise<HorizonTransaction[]> {
  return client.getLedgerTransactions(sequence, horizonUrl, purpose);
}
}

export function getLedgerOperations(
  horizonUrl: string,
  sequence: number,
  purpose: RequestPurpose = 'tip'
): Promise<HorizonOperation[]> {
  return client.getLedgerOperations(sequence, horizonUrl, purpose);
}
}

/** `null` for accounts that don't exist or have been merged away. */
export function getAccount(horizonUrl: string, address: string): Promise<HorizonAccount | null> {
  return client.getAccount(address, horizonUrl);
}
}
