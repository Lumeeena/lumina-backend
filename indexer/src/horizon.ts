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
 *
 * ## Tuning constants
 *
 * - `PAGE_LIMIT` (200) — Horizon's maximum records-per-page. A full page is also
 *   the signal that another page exists: the shared client follows `next` links
 *   only when the current page is exactly this size, so a short final page stops
 *   pagination without a second round-trip.
 * - `REQUEST_TIMEOUT_MS` (10 s, overridable via `HORIZON_REQUEST_TIMEOUT_MS`) —
 *   generous by default because a 200-record ledger page is not a small response.
 *   An indexer that hangs on a wedged Horizon is worse than one that retries.
 * - `ACCOUNT_REQUEST_TIMEOUT_MS` (10 s) — reserved for account-fetch paths that
 *   may need a longer window; the shared client's own timeout applies today.
 */
import {
  createHorizonClient,
  type HorizonAccount,
  type HorizonLedger,
  type HorizonOperation,
  type HorizonTransaction,
  type HorizonTrade,
  type HorizonTradePrice,
  type HorizonTradesFilter,
} from '@lumina/shared';
import {
  horizonRequestDuration,
  horizonRequests,
  horizonThrottleInterval,
  horizonQueuedRequests,
  horizonWaitTime,
} from './metrics';
import { subsystem } from './logger';

/**
 * Horizon's maximum records per page, and the signal that another page exists.
 * Re-exported from the shared client so the indexer and tests reference one
 * constant.
 */
export const PAGE_LIMIT = 200;

/** Reserved timeout for account-fetch paths (10 s). */
const ACCOUNT_REQUEST_TIMEOUT_MS = 10_000;

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

/**
 * Configuration the indexer passes to the shared Horizon client at startup.
 *
 * - `minIntervalMs` / `maxIntervalMs` — bounds for the adaptive request throttle.
 * - `authToken` — optional Bearer token for authenticated Horizon endpoints with
 *   higher rate limits; never logged.
 * - `tipWeightFactor` — relative priority for tip vs backfill requests.
 */
interface HorizonClientConfig {
  minIntervalMs: number;
  maxIntervalMs: number;
  authToken?: string;
  tipWeightFactor: number;
}

/** Per-request timeout, overridable via `HORIZON_REQUEST_TIMEOUT_MS`. */
const REQUEST_TIMEOUT_MS = parseInt(process.env.HORIZON_REQUEST_TIMEOUT_MS ?? '10000', 10);

/** The shared client instance, initialised once at startup. */
let client: ReturnType<typeof createHorizonClient>;

/**
 * Creates and stores the shared Horizon client with the indexer's metrics,
 * logger, and pacing configuration.
 *
 * Must be called once during startup before any fetch function is used; the
 * exported functions below delegate to the stored client.
 */
export function initializeHorizonClient(config: HorizonClientConfig): void {
  client = createHorizonClient({
    name: 'horizon',
    minIntervalMs: config.minIntervalMs,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    // The indexer writes what Horizon returns, so a response that does not
    // match the fields it reads must fail here, naming the field, and not
    // reach an INSERT. See shared/src/validate.ts.
    validateResponses: true,
    metrics: {
      requestsTotal: horizonRequests,
      requestDuration: horizonRequestDuration,
      currentInterval: horizonThrottleInterval,
      queuedRequests: horizonQueuedRequests,
      waitTime: horizonWaitTime,
    },
    logger: subsystem('horizon'),
  });
}

/**
 * Returns the latest ledger sequence Horizon reports for the given network.
 *
 * Fetches `/ledgers?order=desc&limit=1` and reads the first record's sequence.
 * Returns `0` when Horizon has no records (an empty network or a misconfigured
 * URL).
 */
export function getLatestLedgerSequence(horizonUrl: string): Promise<number> {
  return client.getLatestLedgerSequence(horizonUrl);
}

/**
 * Fetches a single ledger by sequence number.
 *
 * Throws on a non-OK response (e.g. 404 for a ledger that does not exist yet)
 * because the indexer's ledger walk must not silently skip a missing ledger.
 */
export function getLedger(horizonUrl: string, sequence: number): Promise<HorizonLedger> {
  return client.getLedger(sequence, horizonUrl);
}

/**
 * Fetches all transactions for a ledger, following pagination links.
 *
 * Uses `PAGE_LIMIT` records per page; a short final page (fewer than
 * `PAGE_LIMIT` records) stops pagination without an extra round-trip.
 */
export function getLedgerTransactions(
  horizonUrl: string,
  sequence: number,
): Promise<HorizonTransaction[]> {
  return client.getLedgerTransactions(sequence, horizonUrl);
}

/**
 * Fetches all operations for a ledger, following pagination links.
 *
 * Operations include the `source_account` plus type-specific fields in an
 * open-ended index signature, so payment, path-payment, and manage-offer
 * details are all accessible without a union type per operation type.
 */
export function getLedgerOperations(
  horizonUrl: string,
  sequence: number,
): Promise<HorizonOperation[]> {
  return client.getLedgerOperations(sequence, horizonUrl);
}

/**
 * Fetches an account from Horizon.
 *
 * Returns `null` for accounts that don't exist or have been merged away (a 404),
 * so the indexer can treat "not found" as "not yet created" rather than an
 * error. Transient failures (429, 5xx) throw so queued refreshes can retry.
 */
export function getAccount(horizonUrl: string, address: string): Promise<HorizonAccount | null> {
  return client.getAccount(address, horizonUrl);
}

/**
 * Fetches trades from Horizon, optionally filtered by asset pair, offer, or
 * cursor. Returns an empty array when no trades match.
 */
export function getTrades(
  horizonUrl: string,
  params?: HorizonTradesFilter
): Promise<HorizonTrade[]> {
  return client.getTrades(params, horizonUrl);
}

export type { HorizonTrade, HorizonTradePrice, HorizonTradesFilter };
