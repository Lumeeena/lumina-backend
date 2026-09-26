/**
 * `indexerStatus`: how far the indexed data sits behind the chain.
 *
 * ## What the query is for
 *
 * A cached index answers "what happened" faster than the chain can, and is
 * wrong the moment it falls behind. This is the number that lets a client say
 * *that* out loud — "data is 12 ledgers behind" or "showing cached data" —
 * instead of presenting a stale ledger as current.
 *
 * ## What it is not
 *
 * Not an SLA and not a gate. Both sides of the comparison are read at the
 * moment of the call and the answer is stale the instant it is returned; a
 * threshold can be crossed between two calls on the same page. Withholding
 * data because this says `stale` would turn a lagging indexer into a total
 * outage, which is the wrong trade: labelled stale data beats no data.
 *
 * ## Why neither side failing is an error
 *
 * The interesting moment for this query is exactly when something is wrong —
 * the indexer stopped, Horizon is unreachable. Failing the query in that case
 * would leave a client with an error where it most wanted an answer, so a
 * failure on either side comes back as `null` plus `stale: true`.
 */
import type { Pool } from 'pg';
import { getIndexedTip } from './db';
import { getLatestLedger } from './horizon';
import { networkEnumValue, type NetworkConfig } from './networks';
import { subsystem } from './logger';

/**
 * Ledgers behind Horizon before the data counts as stale.
 *
 * The indexer legitimately trails by a ledger or two: it reads a closed ledger
 * and writes it after the fact. Beyond a handful, the gap is a stopped
 * indexer rather than ordinary lag, and a client labelling the data current
 * would be wrong.
 */
export const STALE_AFTER_LEDGERS = 20;

const log = subsystem('freshness');

export interface IndexerStatusReport {
  /** The `Network` enum value these numbers describe. */
  network: string;
  latestIndexedLedger: number | null;
  latestIndexedAt: string | null;
  horizonLedger: number | null;
  lagLedgers: number | null;
  stale: boolean;
  checkedAt: string;
}

export interface FreshnessOptions {
  /** Injected so the test does not need Horizon. */
  readHorizonLedger?: (baseUrl: string) => Promise<{ sequence: number } | null>;
  staleAfterLedgers?: number;
  /** Epoch milliseconds, injected so the test can pin `checkedAt`. */
  now?: () => number;
}

export async function getIndexerStatus(
  pool: Pool,
  network: NetworkConfig,
  options: FreshnessOptions = {}
): Promise<IndexerStatusReport> {
  const readHorizonLedger = options.readHorizonLedger ?? getLatestLedger;
  const staleAfter = options.staleAfterLedgers ?? STALE_AFTER_LEDGERS;
  const checkedAt = (options.now ?? Date.now)();

  const [tip, horizon] = await Promise.all([
    readIndexedTip(pool, network.name),
    readHorizonLedger(network.horizonUrl).catch(err => {
      log.warn({ network: network.name, err: err instanceof Error ? err.message : err }, 'horizon tip unavailable');
      return null;
    }),
  ]);

  const horizonLedger = horizon?.sequence ?? null;
  const lagLedgers =
    horizonLedger !== null && tip.sequence !== null ? horizonLedger - tip.sequence : null;

  return {
    network: networkEnumValue(network.name),
    latestIndexedLedger: tip.sequence,
    latestIndexedAt: tip.indexedAt,
    horizonLedger,
    lagLedgers,
    stale: lagLedgers === null || tip.sequence === null || lagLedgers > staleAfter,
    checkedAt: new Date(checkedAt).toISOString(),
  };
}

/**
 * The indexed side of the comparison.
 *
 * Read failures are swallowed rather than propagated: Postgres being down is
 * the one failure mode where this query cannot answer at all, and `null` plus
 * `stale: true` is a more useful answer to "how current is this?" than a
 * transport error the client would have to interpret.
 */
async function readIndexedTip(pool: Pool, network: string) {
  try {
    return await getIndexedTip(pool, network);
  } catch (err) {
    log.warn({ network, err: err instanceof Error ? err.message : err }, 'indexed tip unavailable');
    return { sequence: null, indexedAt: null };
  }
}
