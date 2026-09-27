/**
 * The GraphQL server's Horizon client.
 *
 * The implementation is `@lumina/shared`'s — the same one the indexer runs — so
 * this fallback path is now paced by the throttle the indexer has always had.
 * It used to fire at Horizon unthrottled, and the moment it carries real load is
 * exactly the moment the indexer has not written the account yet, which is also
 * when a 429 costs the client an answer.
 *
 * A deployment serves more than one chain, so every call takes the base URL of
 * the network it is asking about: falling back to the primary network's Horizon
 * when the database has nothing for testnet would hand a client mainnet data
 * under a testnet label. The flat `HORIZON_URL` remains the default so the
 * single-network deployment — and the unit tests — keep one obvious URL.
 */
import {
  createHorizonClient,
  type HorizonAccount,
  type HorizonLatestLedger,
  type HorizonTransaction,
} from '@lumina/shared';
import { horizonRequestDuration, horizonRequests } from './metrics';
import { subsystem } from './logger';

export type {
  HorizonAccount,
  HorizonBalance,
  HorizonBalance as Balance,
  HorizonLatestLedger,
  HorizonTransaction,
} from '@lumina/shared';

const HORIZON = process.env['HORIZON_URL'] ?? 'https://horizon.stellar.org';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 300;
const REQUEST_TIMEOUT_MS = parseInt(process.env['HORIZON_REQUEST_TIMEOUT_MS'] ?? '2000', 10);

const client = createHorizonClient({
  name: 'horizon',
  baseUrl: HORIZON,
  minIntervalMs: parseInt(process.env['HORIZON_MIN_REQUEST_INTERVAL_MS'] ?? '100', 10),
  maxRetries: MAX_RETRIES,
  baseBackoffMs: BASE_BACKOFF_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  metrics: { requestsTotal: horizonRequests, requestDuration: horizonRequestDuration },
  logger: subsystem('horizon'),
});

export function getRecentTransactions(
  limit = 20,
  baseUrl?: string
): Promise<HorizonTransaction[]> {
  return client.getRecentTransactions(limit, baseUrl);
}

export function getAccount(
  address: string,
  baseUrl?: string
): Promise<HorizonAccount | null> {
  return client.getAccount(address, baseUrl);
}

export function getAccountTransactions(
  address: string,
  limit = 10,
  baseUrl?: string
): Promise<HorizonTransaction[]> {
  return client.getAccountTransactions(address, limit, baseUrl);
}

export function getLatestLedger(baseUrl?: string): Promise<HorizonLatestLedger | null> {
  return client.getLatestLedger(baseUrl);
}
