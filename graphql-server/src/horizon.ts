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
  type HorizonTrade,
  type HorizonTradesFilter,
  type HorizonTransaction,
  type HorizonEndpoint,
} from '@lumina/shared';
import { horizonRequestDuration, horizonRequests } from './metrics';
import { subsystem } from './logger';

// Types re-exported from @lumina/shared so callers import them from this module,
// and so the GraphQL layer does not depend on the shared package directly.
export type {
  HorizonAccount,
  HorizonBalance,
  HorizonBalance as Balance,
  HorizonLatestLedger,
  HorizonTransaction,
  HorizonTrade,
  HorizonTradePrice,
  HorizonTradesFilter,
} from '@lumina/shared';

/**
 * Default Horizon base URL, used when a call passes no `baseUrl`. It is set by
 * `HORIZON_URL` and falls back to the public Stellar Horizon. Per-network
 * callers pass their own URL instead, so this default is only the single-network
 * path.
 */
const HORIZON = process.env['HORIZON_URL'] ?? 'https://horizon.stellar.org';

/**
 * Retry budget handed to the shared client, for responses such as 429 that
 * are worth retrying. Retries are bounded so a Horizon that stays rate-limited
 * costs a fixed amount of waiting before the call gives up. The source does not
 * record why 3 was chosen. The test `getAccount gives up and returns null after
 * exhausting retries on repeated 429s` pins the behaviour at this budget.
 */
const MAX_RETRIES = 3;

/**
 * Base delay for the shared client's exponential backoff between retries, in
 * milliseconds. The exact schedule is defined in `@lumina/shared`, not here. The
 * source does not record why 300 was chosen.
 */
const BASE_BACKOFF_MS = 300;

/**
 * Per-attempt timeout, in milliseconds. Set by `HORIZON_REQUEST_TIMEOUT_MS`,
 * default 2000. It caps how long one request to Horizon can hold a GraphQL
 * request open, so a slow Horizon makes a fallback fail rather than hang. The
 * source does not record why 2000 was chosen.
 */
const REQUEST_TIMEOUT_MS = parseInt(process.env['HORIZON_REQUEST_TIMEOUT_MS'] ?? '2000', 10);

/**
 * The one shared Horizon client for this process. All exports below delegate to
 * it, so they share its throttle, retry and metrics.
 */
const client = createHorizonClient({
  name: 'horizon',
  baseUrl: HORIZON,
  /**
   * Minimum gap between consecutive requests from this process, in milliseconds.
   * Set by `HORIZON_MIN_REQUEST_INTERVAL_MS`, default 100. That is at most 10
   * requests per second. The source does not record why 100 was chosen.
   */
  minIntervalMs: parseInt(process.env['HORIZON_MIN_REQUEST_INTERVAL_MS'] ?? '100', 10),
  maxRetries: MAX_RETRIES,
  baseBackoffMs: BASE_BACKOFF_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  metrics: { requestsTotal: horizonRequests, requestDuration: horizonRequestDuration },
  logger: subsystem('horizon'),
});

/**
 * Fetches the most recent transactions across the network.
 *
 * @param limit How many to return. Defaults to 20.
 * @param baseUrl Horizon base URL for the network to query. Defaults to `HORIZON_URL`.
 */
export function getRecentTransactions(
  limit = 20,
  baseUrl?: HorizonEndpoint
): Promise<HorizonTransaction[]> {
  return client.getRecentTransactions(limit, baseUrl);
}

/**
 * Fetches one account by address.
 *
 * Returns `null` for a 404, which means the account does not exist on that
 * network. A 404 is not retried. A run of 429 responses that exhausts the retry
 * budget also yields `null`, so a `null` can mean "not found" or "Horizon would
 * not answer". The two are not distinguished here.
 *
 * @param address Stellar account address (`G…`).
 * @param baseUrl Horizon base URL for the network to query. Defaults to `HORIZON_URL`.
 */
export function getAccount(
  address: string,
  baseUrl?: HorizonEndpoint
): Promise<HorizonAccount | null> {
  return client.getAccount(address, baseUrl);
}

/**
 * Fetches recent transactions for one account.
 *
 * @param address Stellar account address (`G…`).
 * @param limit How many to return. Defaults to 10.
 * @param baseUrl Horizon base URL for the network to query. Defaults to `HORIZON_URL`.
 */
export function getAccountTransactions(
  address: string,
  limit = 10,
  baseUrl?: HorizonEndpoint
): Promise<HorizonTransaction[]> {
  return client.getAccountTransactions(address, limit, baseUrl);
}

/**
 * Fetches the latest closed ledger that Horizon reports for a network.
 *
 * The `freshness` module uses this as the chain tip to measure indexer lag. It
 * returns `null` when Horizon gives no ledger. Callers must treat that as
 * "unknown", not as ledger zero.
 *
 * @param baseUrl Horizon base URL for the network to query. Defaults to `HORIZON_URL`.
 */
export function getLatestLedger(baseUrl?: HorizonEndpoint): Promise<HorizonLatestLedger | null> {
  return client.getLatestLedger(baseUrl);
}

/**
 * Fetches trades matching the filter.
 *
 * @param params Optional filter, forwarded to the shared client's `getTrades`.
 * @param baseUrl Horizon base URL for the network to query. Defaults to `HORIZON_URL`.
 */
export function getTrades(
  params?: HorizonTradesFilter,
  baseUrl?: HorizonEndpoint
): Promise<HorizonTrade[]> {
  return client.getTrades(params, baseUrl);
}
