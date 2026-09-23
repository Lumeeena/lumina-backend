/**
 * Subscription resolvers.
 *
 * A notification says only that a ledger landed, so each resolver turns one
 * notification into the stream of rows a subscriber actually asked for: the
 * ledger's transactions, or just the operations touching one address. That
 * fan-out happens here rather than in the notifier, which stays a dumb pipe.
 */
import type { Pool } from 'pg';
import { getAccountOperationsInLedger, getTransactionsByLedger } from './db';
import type { IndexedNotification } from './notifications';
import type { LedgerNotifier } from './pubsub';
import type { subsystem } from './logger';

export interface SubscriptionContext {
  pool: Pool;
  notifier: LedgerNotifier;
  requestLogger: ReturnType<typeof subsystem>;
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
  load: (ledger: number) => Promise<T[]>,
  requestLogger: ReturnType<typeof subsystem>
): AsyncGenerator<T> {
  for await (const notification of notifications) {
    if (!isLedgerWrite(notification)) continue;

    let rows: T[];
    try {
      rows = await load(notification.ledger);
    } catch (err) {
      requestLogger.warn('subscription failed to read ledger', {
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

export function createSubscriptionResolvers() {
  return {
    newTransaction: {
      subscribe(_: unknown, __: unknown, { pool, notifier }: SubscriptionContext) {
        return expandLedgers(notifier.subscribe(), ledger => getTransactionsByLedger(pool, ledger), requestLogger);
      },
      // The stream already yields Transaction objects; without this Apollo
      // would look for a `newTransaction` key on each one.
      resolve: (payload: unknown) => payload,
    },

    accountActivity: {
      subscribe(_: unknown, args: { address: string }, { pool, notifier }: SubscriptionContext) {
        return expandLedgers(
          notifier.subscribe(),
          ledger => getAccountOperationsInLedger(pool, ledger, args.address),
          requestLogger
        );
      },
      resolve: (payload: unknown) => payload,
    },
  };
}
