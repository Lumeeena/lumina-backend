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
import { horizonRequestDuration, horizonRequests } from './metrics';
import { subsystem } from './logger';

export type {
  HorizonAccount,
  HorizonBalance,
  HorizonLedger,
  HorizonOperation,
  HorizonTransaction,
} from '@lumina/shared';
export { PAGE_LIMIT } from '@lumina/shared';

const MIN_REQUEST_INTERVAL_MS = parseInt(process.env.HORIZON_MIN_REQUEST_INTERVAL_MS ?? '100', 10);

/**
 * A ledger page carries up to 200 transactions, so the indexer's requests are
 * given more room than the GraphQL server's small account lookups: an aborted
 * page is a ledger that has to be fetched again, not a query that answers
 * slightly later. `HORIZON_REQUEST_TIMEOUT_MS` was shared all along, but only
 * the server had a default for it.
 */
const REQUEST_TIMEOUT_MS = parseInt(process.env.HORIZON_REQUEST_TIMEOUT_MS ?? '10000', 10);

const client = createHorizonClient({
  name: 'horizon',
  minIntervalMs: MIN_REQUEST_INTERVAL_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  metrics: { requestsTotal: horizonRequests, requestDuration: horizonRequestDuration },
  logger: subsystem('horizon'),
});

export function getLatestLedgerSequence(horizonUrl: string): Promise<number> {
  return client.getLatestLedgerSequence(horizonUrl);
}

export function getLedger(horizonUrl: string, sequence: number): Promise<HorizonLedger> {
  return client.getLedger(sequence, horizonUrl);
}

export function getLedgerTransactions(
  horizonUrl: string,
  sequence: number
): Promise<HorizonTransaction[]> {
  return client.getLedgerTransactions(sequence, horizonUrl);
}

export function getLedgerOperations(
  horizonUrl: string,
  sequence: number
): Promise<HorizonOperation[]> {
  return client.getLedgerOperations(sequence, horizonUrl);
}

/** `null` for accounts that don't exist or have been merged away. */
export function getAccount(horizonUrl: string, address: string): Promise<HorizonAccount | null> {
  return client.getAccount(address, horizonUrl);
}
