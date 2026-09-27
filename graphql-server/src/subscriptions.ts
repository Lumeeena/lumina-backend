/**
 * Subscription resolvers.
 *
 * A notification says only that a ledger landed, so each resolver turns one
 * notification into the stream of rows a subscriber actually asked for: the
 * ledger's transactions, or just the operations touching one address. That
 * fan-out happens here rather than in the notifier, which stays a dumb pipe.
 *
 * ## Why the network is filtered twice
 *
 * Ledger sequences repeat across chains — ledger 500 exists on mainnet and on
 * testnet — so a subscriber on one network must not be handed another's
 * notification, and reading rows by sequence alone would return whichever
 * network's rows happen to be there. Notifications are dropped unless they
 * carry the subscribed network, *and* the rows are read with that network in
 * the predicate: the first keeps the stream honest, the second keeps the rows
 * honest.
 */
import type { Pool } from 'pg';
import { getAccountOperationsInLedger, getTransactionsByLedger } from './db';
import { resolveNetworkArgument, type NetworkRegistry } from './networks';
import type { IndexedNotification } from './notifications';
import type { LedgerNotifier } from './pubsub';
import { subsystem } from './logger';

export interface SubscriptionContext {
  pool: Pool;
  /**
   * Used to turn the `network` argument into a network — omitted means the
   * primary. Optional only because the tests build a context from a pool and a
   * notifier; `resolveNetworkArgument` falls back to the process registry.
   */
  registry?: NetworkRegistry;
  notifier: LedgerNotifier;
  requestLogger?: ReturnType<typeof subsystem>;
}

/**
 * The one method a subscription needs from a logger.
 *
 * Narrow on purpose: a failed read produces a warning and nothing else, so the
 * stream cannot grow a dependency on the rest of the logging API.
 */
interface SubscriptionLogger {
  warn(message: string, detail?: unknown): void;
}

/** Notifications about ledger writes; event-only notifications are not rows. */
function isLedgerWrite(notification: IndexedNotification): boolean {
  return notification.kind === 'ledger';
}

/**
 * Expand each ledger notification into individual rows.
 *
 * A failed read is logged and skipped rather than ending the subscription: one
 * unreadable ledger should cost a client that ledger, not its connection.
 */
async function* expandLedgers<T>(
  notifications: AsyncIterableIterator<IndexedNotification>,
  network: string,
  load: (ledger: number) => Promise<T[]>,
  requestLogger: SubscriptionLogger
): AsyncGenerator<T> {
  for await (const notification of notifications) {
    if (!isLedgerWrite(notification)) continue;
    // An indexer that predates per-network notifications omits the field; it
    // only ever wrote one chain, so its rows belong to whichever network this
    // subscription resolved to.
    if ((notification.network ?? network) !== network) continue;

    let rows: T[];
    try {
      rows = await load(notification.ledger);
    } catch (err) {
      requestLogger.warn('subscription failed to read ledger', {
        network,
        ledger: notification.ledger,
        error: err instanceof Error ? err.message : err,
      });
      continue;
    }

    for (const row of rows) {
      yield row;
    }
  }
}

/**
 * @param logSink Captures the dropped-ledger warning instead of the process
 *   logger. Only the test passes one: it asserts a failed read is reported
 *   rather than silently swallowed, and a real process reports to its log.
 */
export function createSubscriptionResolvers(logSink?: (message: string, detail?: unknown) => void) {
  return {
    newTransaction: {
      subscribe(_: unknown, args: { network?: string | null }, ctx: SubscriptionContext) {
        const { pool, notifier } = ctx;
        const network = resolveNetworkArgument(args.network, ctx.registry);
        return expandLedgers(
          notifier.subscribe(),
          network.name,
          ledger => getTransactionsByLedger(pool, network.name, ledger),
          loggerFor(ctx, logSink)
        );
      },
      // The stream already yields Transaction objects; without this Apollo
      // would look for a `newTransaction` key on each one.
      resolve: (payload: unknown) => payload,
    },

    accountActivity: {
      subscribe(_: unknown, args: { network?: string | null; address: string }, ctx: SubscriptionContext) {
        const { pool, notifier } = ctx;
        const network = resolveNetworkArgument(args.network, ctx.registry);
        return expandLedgers(
          notifier.subscribe(),
          network.name,
          ledger => getAccountOperationsInLedger(pool, network.name, ledger, args.address),
          loggerFor(ctx, logSink)
        );
      },
      resolve: (payload: unknown) => payload,
    },
  };
}

/**
 * The request logger, a supplied sink, or a stand-in — in that order.
 *
 * A caller that builds a context without a logger must not stop a subscription
 * from starting, which is the bug this default exists to avoid: the warning
 * used to reference a name that was never in scope, so the first failed read
 * threw instead of logging.
 */
function loggerFor(
  ctx: SubscriptionContext,
  logSink?: (message: string, detail?: unknown) => void
) {
  if (ctx.requestLogger) return ctx.requestLogger;
  if (logSink) return { warn: (message: string, detail?: unknown) => logSink(message, detail) };
  return subsystem('subscription');
}
