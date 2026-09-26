import type { Pool } from 'pg';
import {
  getAccountFromDb,
  getAccountOperations,
  getAccountTransactions,
  getEventsByContract,
  getLatestLedgerFromDb,
  getLedgerBySequence,
  getOperations,
  getOperationsByTransactionHash,
  getTransactionByHash,
  getTransactions,
  mapAccount,
} from './db';
import { createLoaders, type RequestLoaders } from './loaders';
import { getAccount as getAccountFromHorizon, getLatestLedger as getLatestLedgerFromHorizon } from './horizon';
import { createSubscriptionResolvers } from './subscriptions';
import { getContractSchema, getCustomEvents, type CustomEventFilter } from './customEvents';
import { getAssetDetail } from './assets';
import { getOperationsByAsset, searchTransactions } from './search';
import { getIndexerStatus } from './freshness';
import { getNetworks, resolveNetworkArgument, type NetworkConfig, type NetworkRegistry } from './networks';
import type { LedgerNotifier } from './pubsub';
import { ANONYMOUS_CALLER, type ApiCaller } from './auth';

export interface BaseContext {
  pool: Pool;
  /**
   * The networks this deployment serves, resolved once at startup.
   *
   * Every `network:` argument is checked against this, so an unconfigured
   * network is rejected rather than quietly reading another chain's rows.
   */
  registry: NetworkRegistry;
  /**
   * Loaders memoised per network, created on first use.
   *
   * One document can ask about several networks, and a loader batch is keyed by
   * a database column whose meaning depends on the network — a ledger sequence
   * or transaction hash is only unique within one — so batches must never be
   * shared across them.
   */
  loaders?: (network: NetworkConfig) => RequestLoaders;
  /** Present for websocket connections; absent for plain HTTP queries. */
  notifier?: LedgerNotifier;
  /**
   * Who this request is attributed to, resolved once by the auth middleware.
   *
   * Websocket connections are not authenticated — they cannot carry a header —
   * so they are always the anonymous caller until that path is built out.
   */
  caller?: ApiCaller;
}

export type Context = BaseContext;

export function createContext(
  pool: Pool,
  extra: Partial<Omit<Context, 'pool' | 'loaders'>> = {}
): Context {
  return {
    pool,
    registry: getNetworks(),
    loaders: loaderFactory(pool),
    caller: ANONYMOUS_CALLER,
    ...extra,
  };
}

function loaderFactory(pool: Pool): (network: NetworkConfig) => RequestLoaders {
  const byNetwork = new Map<string, RequestLoaders>();
  return network => {
    const existing = byNetwork.get(network.name);
    if (existing) return existing;
    const loaders = createLoaders(pool, network);
    byNetwork.set(network.name, loaders);
    return loaders;
  };
}

/** The network an optional `network:` argument names, or the primary one. */
function networkArgument(args: { network?: string | null }, ctx: Context): NetworkConfig {
  return resolveNetworkArgument(args.network, ctx.registry);
}

/**
 * The configured network a parent row was indexed on.
 *
 * Rows carry the network *name*; endpoints are only needed when a lookup falls
 * through to Horizon. A row whose network is no longer configured still reads
 * correctly from the database — only the fallback has nothing to fall back to,
 * so it inherits the primary network's Horizon URL rather than pretending the
 * row belongs to a different chain.
 */
function networkForParent(ctx: Context, name?: string): NetworkConfig {
  if (name === undefined) return ctx.registry.primary;
  const match = ctx.registry.networks.find(network => network.name === name);
  if (match) return match;
  return { ...ctx.registry.primary, name };
}

/**
 * Lumina GraphQL resolvers — backed by PostgreSQL (populated by indexer/).
 * Horizon is used only as an explicit fallback: an account that hasn't been
 * indexed yet (indexer only writes accounts it's seen activity for), or a
 * fresh database with no ledgers indexed yet.
 */
async function resolveAccount(address: string, ctx: Context, network: NetworkConfig) {
  if (ctx.loaders) return ctx.loaders(network).account.load(address);

  const fromDb = await getAccountFromDb(ctx.pool, network.name, address);
  if (fromDb) return fromDb;

  const horizonAccount = await getAccountFromHorizon(address, network.horizonUrl);
  if (!horizonAccount) return null;
  return mapAccount({
    network: network.name,
    address: horizonAccount.account_id,
    sequence: horizonAccount.sequence,
    subentry_count: horizonAccount.subentry_count,
    last_modified_ledger: horizonAccount.last_modified_ledger,
    num_sponsored: horizonAccount.num_sponsored,
    num_sponsoring: horizonAccount.num_sponsoring,
    balances: horizonAccount.balances,
    flags: horizonAccount.flags,
    thresholds: horizonAccount.thresholds,
  });
}

export const resolvers = {
  Subscription: createSubscriptionResolvers(),

  Query: {
    async transactions(
      _: unknown,
      args: { network?: string | null; limit?: number; cursor?: string | null },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const limit = args.limit ?? 20;
      const items = await getTransactions(ctx.pool, network.name, limit, args.cursor ?? null);
      return {
        items,
        pageInfo: {
          hasNextPage: items.length === limit,
          cursor: items.at(-1)?.hash ?? null,
        },
      };
    },

    async transaction(_: unknown, args: { network?: string | null; hash: string }, ctx: Context) {
      const network = networkArgument(args, ctx);
      return getTransactionByHash(ctx.pool, network.name, args.hash);
    },

    async account(_: unknown, args: { network?: string | null; address: string }, ctx: Context) {
      const network = networkArgument(args, ctx);
      return resolveAccount(args.address, ctx, network);
    },

    async operations(
      _: unknown,
      args: {
        network?: string | null;
        account?: string | null;
        type?: string | null;
        asset?: string | null;
        limit?: number;
        cursor?: string | null;
      },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const limit = args.limit ?? 20;

      // The asset filter needs its own query: an asset can appear as the
      // payment asset or either side of an offer, which the generic operations
      // query has no notion of.
      const items = args.asset
        ? await getOperationsByAsset(ctx.pool, {
            network: network.name,
            asset: args.asset,
            account: args.account ?? null,
            type: args.type ?? null,
            limit,
            cursor: args.cursor ?? null,
          })
        : await getOperations(ctx.pool, {
            network: network.name,
            account: args.account ?? null,
            type: args.type ?? null,
            limit,
            cursor: args.cursor ?? null,
          });

      return {
        items,
        pageInfo: {
          hasNextPage: items.length === limit,
          cursor: items.at(-1)?.id ?? null,
        },
      };
    },

    async search(
      _: unknown,
      args: { network?: string | null; query: string; limit?: number; cursor?: string | null },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const limit = args.limit ?? 20;
      const { items, nextCursor } = await searchTransactions(ctx.pool, {
        network: network.name,
        query: args.query,
        limit,
        cursor: args.cursor ?? null,
      });
      return {
        items,
        pageInfo: {
          hasNextPage: items.length === limit,
          // The search cursor encodes the ranking tuple, not just a row id.
          cursor: nextCursor,
        },
      };
    },

    async events(
      _: unknown,
      args: { network?: string | null; contractId: string; topic?: string | null; limit?: number; cursor?: string | null },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const limit = args.limit ?? 20;
      const items = await getEventsByContract(ctx.pool, {
        network: network.name,
        contractId: args.contractId,
        topic: args.topic ?? null,
        limit,
        cursor: args.cursor ?? null,
      });
      return {
        items,
        pageInfo: {
          hasNextPage: items.length === limit,
          cursor: items.at(-1)?.id ?? null,
        },
      };
    },

    async latestLedger(_: unknown, args: { network?: string | null }, ctx: Context) {
      const network = networkArgument(args, ctx);
      const fromDb = await getLatestLedgerFromDb(ctx.pool, network.name);
      if (fromDb) return fromDb;

      const horizonLedger = await getLatestLedgerFromHorizon(network.horizonUrl);
      if (!horizonLedger) return null;
      return {
        network: network.name,
        sequence: horizonLedger.sequence,
        closedAt: horizonLedger.closed_at,
        transactionCount: horizonLedger.successful_transaction_count + horizonLedger.failed_transaction_count,
        operationCount: horizonLedger.operation_count,
        baseFee: 100,
        baseReserve: 5000000,
      };
    },

    async ledger(_: unknown, args: { network?: string | null; sequence: number }, ctx: Context) {
      const network = networkArgument(args, ctx);
      return getLedgerBySequence(ctx.pool, network.name, args.sequence);
    },

    async customEvents(
      _: unknown,
      args: {
        network?: string | null;
        contractId: string;
        event: string;
        where?: CustomEventFilter[] | null;
        limit?: number;
        cursor?: string | null;
      },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const limit = args.limit ?? 20;
      const items = await getCustomEvents(ctx.pool, {
        network: network.name,
        contractId: args.contractId,
        event: args.event,
        where: args.where ?? null,
        limit,
        cursor: args.cursor ?? null,
      });
      return {
        items,
        pageInfo: {
          hasNextPage: items.length === limit,
          cursor: items.at(-1)?.eventId ?? null,
        },
      };
    },

    async contractSchema(
      _: unknown,
      args: { network?: string | null; contractId: string },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const schema = await getContractSchema(ctx.pool, network.name, args.contractId);
      if (!schema) return null;
      return {
        ...schema,
        events: schema.events.map(event => ({
          ...event,
          fields: event.fields.map(field => ({ ...field, optional: field.optional ?? false })),
        })),
      };
    },

    async asset(
      _: unknown,
      args: {
        network?: string | null;
        asset: string;
        from?: string | null;
        to?: string | null;
        bucketSeconds?: number | null;
      },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      return getAssetDetail(ctx.pool, {
        network: network.name,
        asset: args.asset,
        from: args.from ?? null,
        to: args.to ?? null,
        bucketSeconds: args.bucketSeconds ?? null,
      });
    },

    async indexerStatus(_: unknown, args: { network?: string | null }, ctx: Context) {
      const network = networkArgument(args, ctx);
      return getIndexerStatus(ctx.pool, network);
    },
  },

  Account: {
    async transactions(parent: { address: string; network?: string }, args: { limit?: number }, ctx: Context) {
      const network = networkForParent(ctx, parent.network);
      return getAccountTransactions(ctx.pool, network.name, parent.address, args.limit ?? 10);
    },
    async operations(parent: { address: string; network?: string }, args: { limit?: number }, ctx: Context) {
      const network = networkForParent(ctx, parent.network);
      return getAccountOperations(ctx.pool, network.name, parent.address, args.limit ?? 10);
    },
  },

  Transaction: {
    async ledgerData(parent: { ledger: number; network?: string }, _: unknown, ctx: Context) {
      const network = networkForParent(ctx, parent.network);
      return ctx.loaders
        ? ctx.loaders(network).ledger.load(parent.ledger)
        : getLedgerBySequence(ctx.pool, network.name, parent.ledger);
    },
    async account(parent: { sourceAccount: string; network?: string }, _: unknown, ctx: Context) {
      return resolveAccount(parent.sourceAccount, ctx, networkForParent(ctx, parent.network));
    },
    async operations(parent: { hash: string; network?: string }, _: unknown, ctx: Context) {
      const network = networkForParent(ctx, parent.network);
      return ctx.loaders
        ? ctx.loaders(network).operationsByTransactionHash.load(parent.hash)
        : getOperationsByTransactionHash(ctx.pool, network.name, parent.hash);
    },
  },

  Operation: {
    async transaction(parent: { transactionHash: string; network?: string }, _: unknown, ctx: Context) {
      const network = networkForParent(ctx, parent.network);
      return ctx.loaders
        ? ctx.loaders(network).transaction.load(parent.transactionHash)
        : getTransactionByHash(ctx.pool, network.name, parent.transactionHash);
    },
    async account(parent: { sourceAccount: string; network?: string }, _: unknown, ctx: Context) {
      return resolveAccount(parent.sourceAccount, ctx, networkForParent(ctx, parent.network));
    },
  },
};
