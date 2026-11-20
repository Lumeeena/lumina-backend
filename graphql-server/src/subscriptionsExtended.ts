/**
 * Extended subscriptions wired into the GraphQL schema (#231, #378).
 *
 * Streams `newTrade` (triggered by `kind: 'ledger'` notifications) and
 * `newContractEvent` (triggered by `kind: 'events'` notifications) over the
 * same PostgreSQL LISTEN/NOTIFY `LedgerNotifier` path that `newTransaction`
 * and `accountActivity` use.
 *
 * ## Why `NEW_OFFER` is omitted
 *
 * Order-book offers are not yet indexed into PostgreSQL. Rather than exposing a
 * dead subscription field or an unused topic that never emits, `newOffer` /
 * `NEW_OFFER` is deliberately left out of the schema and resolver map until an
 * offers table and indexer pipeline exist.
 */
import { getContractEventsByLedger, getTradesByLedger } from './db';
import { resolveNetworkArgument } from './networks';
import type { IndexedKind, IndexedNotification } from './notifications';
import type { SubscriptionContext } from './subscriptions';
import { subsystem } from './logger';

/**
 * Active extended subscription topics.
 * `NEW_OFFER` is intentionally omitted until offers are indexed (#378).
 */
export const EXTENDED_SUBSCRIPTION_TOPICS = {
  NEW_TRADE: 'NEW_TRADE',
  NEW_CONTRACT_EVENT: 'NEW_CONTRACT_EVENT',
} as const;

interface ExtendedSubscriptionLogger {
  warn(message: string, detail?: unknown): void;
}

function loggerFor(
  ctx: SubscriptionContext,
  logSink?: (message: string, detail?: unknown) => void
): ExtendedSubscriptionLogger {
  if (ctx.requestLogger) return ctx.requestLogger;
  if (logSink) return { warn: (message: string, detail?: unknown) => logSink(message, detail) };
  return subsystem('subscription');
}

async function* expandByKind<T>(
  notifications: AsyncIterableIterator<IndexedNotification>,
  expectedKind: IndexedKind,
  network: string,
  load: (ledger: number) => Promise<T[]>,
  requestLogger: ExtendedSubscriptionLogger
): AsyncGenerator<T> {
  for await (const notification of notifications) {
    if (notification.kind !== expectedKind) continue;
    // Double-filtered by network (notification + SQL predicate) so streams on
    // one chain never receive rows from another.
    if ((notification.network ?? network) !== network) continue;

    let rows: T[];
    try {
      rows = await load(notification.ledger);
    } catch (err) {
      requestLogger.warn('extended subscription failed to read ledger', {
        kind: expectedKind,
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

export interface NewTradeSubscriptionArgs {
  network?: string | null;
  baseAssetCode?: string | null;
  counterAssetCode?: string | null;
  account?: string | null;
}

export interface NewContractEventSubscriptionArgs {
  network?: string | null;
  contractId?: string | null;
  type?: string | null;
}

/**
 * Subscription resolvers for `newTrade` and `newContractEvent`, merged into
 * `createSubscriptionResolvers()` in `subscriptions.ts`.
 */
export function createExtendedSubscriptionResolvers(
  logSink?: (message: string, detail?: unknown) => void
) {
  return {
    newTrade: {
      subscribe(_: unknown, args: NewTradeSubscriptionArgs, ctx: SubscriptionContext) {
        const { pool, notifier } = ctx;
        const network = resolveNetworkArgument(args.network, ctx.registry);
        return expandByKind(
          notifier.subscribe(),
          'ledger',
          network.name,
          (ledger) =>
            getTradesByLedger(pool, network.name, ledger, {
              baseAssetCode: args.baseAssetCode,
              counterAssetCode: args.counterAssetCode,
              account: args.account,
            }),
          loggerFor(ctx, logSink)
        );
      },
      resolve: (payload: unknown) => payload,
    },

    newContractEvent: {
      subscribe(_: unknown, args: NewContractEventSubscriptionArgs, ctx: SubscriptionContext) {
        const { pool, notifier } = ctx;
        const network = resolveNetworkArgument(args.network, ctx.registry);
        return expandByKind(
          notifier.subscribe(),
          'events',
          network.name,
          (ledger) =>
            getContractEventsByLedger(pool, network.name, ledger, {
              contractId: args.contractId,
              type: args.type,
            }),
          loggerFor(ctx, logSink)
        );
      },
      resolve: (payload: unknown) => payload,
    },
  };
}
