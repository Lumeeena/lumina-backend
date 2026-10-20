import type { Pool } from 'pg';
import {
  ACCOUNT_ORDER_NAMES,
  ACCOUNT_ORDERS,
  getAccountAsOfLedgerFromDb,
  getAccountFromDb,
  getAccountLifecycle,
  getAccountOperations,
  getAccountTransactions,
  getAccounts,
  getEventsByContract,
  getLatestLedgerFromDb,
  getLedgerBySequence,
  getLedgers,
  getOperations,
  getOperationsByTransactionHash,
  getTransactionByHash,
  getTransactions,
  getTradesFromDb,
  getTableCountEstimateOrExact,
  getContractStorageEntries,
  getAccountSigners,
  getSponsoredAccounts,
  getContractDeployment,
  getContracts,
  getNetworkStats,
  getActivityRollups,
  getSharedWasmContracts,
  mapAccount,
  type AccountOrder,
} from './db';
import {
  DEFAULT_PAGE_LIMIT,
  KEYSETS,
  MAX_AGGREGATE_ROWS,
  getAggregateLimit,
  assertRangeWithinLimit,
  pageInfo,
  getPageSize,
  type PaginationDirection,
} from './pagination';
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
import { computeBalanceHistory } from './balanceHistory';
import { parseAsOfLedger } from './accountHistory';
import { memoizeRequestQuery } from './requestMemo';
import { getEffects } from './effects';

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
  /**
   * Request-level query memoization cache, scoped strictly to this request context.
   */
  queryMemo?: Map<string, Promise<unknown>>;
}

export type Context = BaseContext;

const latestLedgerCacheTtlMs = parseInt(process.env['LATEST_LEDGER_CACHE_TTL_MS'] ?? '4000', 10);
const latestLedgerCache = new Map<string, { value: Awaited<ReturnType<typeof getLatestLedgerFromDb>>; cachedAt: number }>();

export function createContext(
  pool: Pool,
  extra: Partial<Omit<Context, 'pool' | 'loaders'>> = {}
): Context {
  return {
    pool,
    registry: getNetworks(),
    loaders: loaderFactory(pool),
    caller: ANONYMOUS_CALLER,
    queryMemo: new Map<string, Promise<unknown>>(),
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

/** Narrow an optional enum argument to a declared ordering. */
function isAccountOrder(value?: string | null): value is AccountOrder {
  return value != null && (ACCOUNT_ORDER_NAMES as string[]).includes(value);
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
      args: {
        network?: string | null;
        limit?: number;
        cursor?: string | null;
        direction?: PaginationDirection | null;
        order?: 'ASC' | 'DESC' | null;
        successful?: boolean | null;
        from?: string | null;
        to?: string | null;
        sourceAccount?: string | null;
        includeTotalCount?: boolean | null;
      },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'transactions', args, async () => {
        const limit = getPageSize(args.limit);
        const network = networkArgument(args, ctx);
        const items = await getTransactions(ctx.pool, network.name, limit, args.cursor ?? null, {
          order: args.order ?? 'DESC',
          successful: args.successful,
          from: args.from,
          to: args.to,
          sourceAccount: args.sourceAccount,
        });
        let totalCount = null;
        if (args.includeTotalCount) {
          totalCount = await getTableCountEstimateOrExact(ctx.pool, 'transactions', network.name);
        }
        return {
          items,
          pageInfo: pageInfo(
            KEYSETS.transactions,
            items,
            limit,
            tx => [tx.ledger, tx.hash],
            args.direction ?? 'FORWARD',
            Boolean(args.cursor),
            totalCount
          ),
        };
      });
    },

    async transaction(_: unknown, args: { network?: string | null; hash: string }, ctx: Context) {
      return memoizeRequestQuery(ctx.queryMemo, 'transaction', args, async () => {
        const network = networkArgument(args, ctx);
        return getTransactionByHash(ctx.pool, network.name, args.hash);
      });
    },

    async account(
      _: unknown,
      args: { network?: string | null; address: string; asOfLedger?: number | null },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'account', args, async () => {
        const network = networkArgument(args, ctx);
        if (args.asOfLedger != null) {
          // Stored history only. Horizon holds the current state, so falling
          // back to it here would answer a past question with today's balances.
          const ledger = parseAsOfLedger(args.asOfLedger);
          return getAccountAsOfLedgerFromDb(ctx.pool, network.name, args.address, ledger);
        }
        return resolveAccount(args.address, ctx, network);
      });
    },

    async accounts(
      _: unknown,
      args: { network?: string | null; orderBy?: string | null; limit?: number; cursor?: string | null; includeTotalCount?: boolean | null },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'accounts', args, async () => {
        const network = networkArgument(args, ctx);
        const limit = args.limit ?? DEFAULT_PAGE_LIMIT;
        // The enum cannot name an unknown value, and every declared order is in
        // ACCOUNT_ORDERS, so the fallback is unreachable in practice — but a bad
        // order must not reach SQL as an ORDER BY.
        const orderBy = isAccountOrder(args.orderBy) ? args.orderBy : 'RECENT_ACTIVITY';
        const items = await getAccounts(ctx.pool, {
          network: network.name,
          orderBy,
          limit,
          cursor: args.cursor ?? null,
        });
        let totalCount = null;
        if (args.includeTotalCount) {
          totalCount = await getTableCountEstimateOrExact(ctx.pool, 'accounts', network.name);
        }
        return {
          items,
          pageInfo: pageInfo(
            ACCOUNT_ORDERS[orderBy].keyset,
            items,
            limit,
            account => ACCOUNT_ORDERS[orderBy].keyOf(account),
            'FORWARD',
            Boolean(args.cursor),
            totalCount
          ),
        };
      });
    },

    async accountLifecycle(
      _: unknown,
      args: { network?: string | null; address: string; limit?: number | null; cursor?: string | null },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'accountLifecycle', args, async () => {
        const limit = getPageSize(args.limit);
        const network = networkArgument(args, ctx);
        const items = await getAccountLifecycle(ctx.pool, network.name, args.address, limit, args.cursor);
        return {
          items,
          pageInfo: pageInfo(KEYSETS.accountLifecycle, items, limit, operation => [operation.ledger, operation.id], 'FORWARD', Boolean(args.cursor)),
        };
      });
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
        direction?: PaginationDirection | null;
        order?: 'ASC' | 'DESC' | null;
        includeTotalCount?: boolean | null;
      },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'operations', args, async () => {
        const limit = getPageSize(args.limit);
        const network = networkArgument(args, ctx);

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
              order: args.order ?? 'DESC',
            })
          : await getOperations(ctx.pool, {
              network: network.name,
              account: args.account ?? null,
              type: args.type ?? null,
              limit,
              cursor: args.cursor ?? null,
              order: args.order ?? 'DESC',
            });

        let totalCount = null;
        if (args.includeTotalCount) {
          totalCount = await getTableCountEstimateOrExact(ctx.pool, 'operations', network.name);
        }

        return {
          items,
          // The asset filter keyset is the same ordering on the same table.
          pageInfo: pageInfo(
            args.asset ? KEYSETS.assetOperations : KEYSETS.operations,
            items,
            limit,
            operation => [operation.ledger, operation.id],
            args.direction ?? 'FORWARD',
            Boolean(args.cursor),
            totalCount
          ),
        };
      });
    },

    async search(
      _: unknown,
      args: { network?: string | null; query: string; limit?: number; cursor?: string | null; direction?: PaginationDirection | null },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'search', args, async () => {
        const limit = getPageSize(args.limit);
        const network = networkArgument(args, ctx);
        const { items, startCursor, endCursor, nextCursor } = await searchTransactions(ctx.pool, {
          network: network.name,
          query: args.query,
          limit,
          cursor: args.cursor ?? null,
        });
        // Search already computed the cursors from the ranking tuple, so its
        // own values are used rather than ones rebuilt from the rows.
        return {
          items,
          pageInfo: {
            hasNextPage: items.length === limit,
            hasPreviousPage: Boolean(args.cursor),
            startCursor,
            endCursor,
            cursor: nextCursor,
            totalCount: null,
          },
        };
      });
    },

    async events(
      _: unknown,
      args: {
        network?: string | null;
        contractId: string;
        topic?: string | null;
        limit?: number;
        cursor?: string | null;
        direction?: PaginationDirection | null;
        order?: 'ASC' | 'DESC' | null;
      },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'events', args, async () => {
        const limit = getPageSize(args.limit);
        const network = networkArgument(args, ctx);
        const items = await getEventsByContract(ctx.pool, {
          network: network.name,
          contractId: args.contractId,
          topic: args.topic ?? null,
          limit,
          cursor: args.cursor ?? null,
          order: args.order ?? 'DESC',
        });
        return {
          items,
          pageInfo: pageInfo(
            KEYSETS.events,
            items,
            limit,
            event => [event.ledger, event.id],
            args.direction ?? 'FORWARD',
            Boolean(args.cursor)
          ),
        };
      });
    },

    async contractStorageEntries(
      _: unknown,
      args: {
        network?: string | null;
        contractId: string;
        durability?: string | null;
        keyPrefix?: string | null;
        limit?: number;
        cursor?: string | null;
        direction?: PaginationDirection | null;
      },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'contractStorageEntries', args, async () => {
        const limit = getPageSize(args.limit);
        const network = networkArgument(args, ctx);
        const items = await getContractStorageEntries(ctx.pool, {
          network: network.name,
          contractId: args.contractId,
          durability: args.durability ?? null,
          keyPrefix: args.keyPrefix ?? null,
          limit,
          cursor: args.cursor ?? null,
        });
        return {
          items,
          pageInfo: {
            hasNextPage: items.length === limit,
            hasPreviousPage: Boolean(args.cursor),
            startCursor: items.at(0)?.key ?? null,
            endCursor: items.at(-1)?.key ?? null,
            cursor: items.at(-1)?.key ?? null,
          },
        };
      });
    },

    async latestLedger(_: unknown, args: { network?: string | null }, ctx: Context) {
      return memoizeRequestQuery(ctx.queryMemo, 'latestLedger', args, async () => {
        const network = networkArgument(args, ctx);
        const cached = latestLedgerCache.get(network.name);
        if (cached && Date.now() - cached.cachedAt < latestLedgerCacheTtlMs) return cached.value;

        const fromDb = await getLatestLedgerFromDb(ctx.pool, network.name);
        if (fromDb) {
          latestLedgerCache.set(network.name, { value: fromDb, cachedAt: Date.now() });
          return fromDb;
        }

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
      });
    },

    async ledger(_: unknown, args: { network?: string | null; sequence: number }, ctx: Context) {
      return memoizeRequestQuery(ctx.queryMemo, 'ledger', args, async () => {
        const network = networkArgument(args, ctx);
        return getLedgerBySequence(ctx.pool, network.name, args.sequence);
      });
    },

    async ledgers(
      _: unknown,
      args: { network?: string | null; limit?: number; cursor?: string | null; includeTotalCount?: boolean | null },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'ledgers', args, async () => {
        const network = networkArgument(args, ctx);
        const limit = args.limit ?? DEFAULT_PAGE_LIMIT;
        const items = await getLedgers(ctx.pool, network.name, limit, args.cursor ?? null);
        let totalCount = null;
        if (args.includeTotalCount) {
          totalCount = await getTableCountEstimateOrExact(ctx.pool, 'ledgers', network.name);
        }
        return {
          items,
          pageInfo: pageInfo(
            KEYSETS.ledgers,
            items,
            limit,
            ledger => ledger.sequence,
            'FORWARD',
            Boolean(args.cursor),
            totalCount
          ),
        };
      });
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
        direction?: PaginationDirection | null;
        order?: 'ASC' | 'DESC' | null;
      },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'customEvents', args, async () => {
        const limit = getPageSize(args.limit);
        const network = networkArgument(args, ctx);
        const items = await getCustomEvents(ctx.pool, {
          network: network.name,
          contractId: args.contractId,
          event: args.event,
          where: args.where ?? null,
          limit,
          cursor: args.cursor ?? null,
          order: args.order ?? 'DESC',
        });
        // The sort key is (ledger, eventId): the id alone is not unique within a
        // ledger, so keysetting on it would skip and repeat rows.
        return {
          items,
          pageInfo: pageInfo(
            KEYSETS.customEvents,
            items,
            limit,
            event => [event.ledger, event.eventId],
            args.direction ?? 'FORWARD',
            Boolean(args.cursor)
          ),
        };
      });
    },

    async contractSchema(
      _: unknown,
      args: { network?: string | null; contractId: string },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'contractSchema', args, async () => {
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
      });
    },

    async trades(
      _: unknown,
      args: {
        network?: string | null;
        baseAsset?: { assetType?: string | null; assetCode?: string | null; assetIssuer?: string | null } | null;
        counterAsset?: { assetType?: string | null; assetCode?: string | null; assetIssuer?: string | null } | null;
        account?: string | null;
        limit?: number;
        cursor?: string | null;
        includeTotalCount?: boolean | null;
      },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'trades', args, async () => {
        const limit = getPageSize(args.limit);
        const network = networkArgument(args, ctx);
        const items = await getTradesFromDb(ctx.pool, network.name, {
          baseAsset: args.baseAsset ?? undefined,
          counterAsset: args.counterAsset ?? undefined,
          account: args.account ?? undefined,
          limit,
          cursor: args.cursor ?? null,
        });
        let totalCount = null;
        if (args.includeTotalCount) {
          totalCount = await getTableCountEstimateOrExact(ctx.pool, 'trades', network.name);
        }
        return {
          items,
          pageInfo: pageInfo(
            KEYSETS.trades,
            items,
            limit,
            trade => [trade.ledgerCloseTime, trade.id],
            'FORWARD',
            Boolean(args.cursor),
            totalCount
          ),
        };
      });
    },

    async effects(
      _: unknown,
      args: {
        network?: string | null;
        account: string;
        type?: string | null;
        limit?: number;
        cursor?: string | null;
      },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'effects', args, async () => {
        const limit = getPageSize(args.limit);
        const network = networkArgument(args, ctx);
        const items = await getEffects(ctx.pool, {
          network: network.name,
          account: args.account,
          // The enum is Horizon's type name upper-cased; the table stores it as Horizon sent it.
          type: args.type ? args.type.toLowerCase() : null,
          limit,
          cursor: args.cursor ?? null,
        });
        return {
          items,
          pageInfo: pageInfo(KEYSETS.effects, items, limit, effect => [effect.ledger, effect.id], 'FORWARD', Boolean(args.cursor)),
        };
      });
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
      return memoizeRequestQuery(ctx.queryMemo, 'asset', args, async () => {
        const network = networkArgument(args, ctx);
        return getAssetDetail(ctx.pool, {
          network: network.name,
          asset: args.asset,
          from: args.from ?? null,
          to: args.to ?? null,
          bucketSeconds: args.bucketSeconds ?? null,
        });
      });
    },

    async assets(
      _: unknown,
      args: {
        network?: string | null;
        sortBy?: 'HOLDERS' | 'VOLUME';
        search?: string | null;
        limit?: number;
        cursor?: string | null;
      },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'assets', args, async () => {
        const network = networkArgument(args, ctx);
        const { getAssets } = await import('./assets');
        return getAssets(ctx.pool, {
          network: network.name,
          sortBy: args.sortBy ?? 'HOLDERS',
          search: args.search ?? null,
          limit: args.limit ?? 20,
          cursor: args.cursor ?? null,
        });
      });
    },

    async assetByKey(
      _: unknown,
      args: {
        network?: string | null;
        code: string;
        issuer: string;
      },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'assetByKey', args, async () => {
        const network = networkArgument(args, ctx);
        const { getAssetByKey } = await import('./assets');
        return getAssetByKey(ctx.pool, network.name, args.code, args.issuer);
      });
    },

    async accountBalanceHistory(
      _: unknown,
      args: {
        network?: string | null;
        address: string;
        asset?: string | null;
        from?: string | null;
        to?: string | null;
      },
      ctx: Context
    ) {
      return memoizeRequestQuery(ctx.queryMemo, 'accountBalanceHistory', args, async () => {
        const network = networkArgument(args, ctx);
        return computeBalanceHistory(
          ctx.pool,
          network.name,
          args.address,
          args.asset ?? 'XLM',
          args.from,
          args.to
        );
      });
    },

    async indexerStatus(_: unknown, args: { network?: string | null }, ctx: Context) {
      return memoizeRequestQuery(ctx.queryMemo, 'indexerStatus', args, async () => {
        const network = networkArgument(args, ctx);
        return getIndexerStatus(ctx.pool, network);
      });
    },

    // ─── #226: Signers & Sponsorship ─────────────────────────────────────
    async accountSigners(
      _: unknown,
      args: { network?: string | null; address: string },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      return getAccountSigners(ctx.pool, network.name, args.address);
    },
    async sponsoredAccounts(
      _: unknown,
      args: { network?: string | null; sponsorAddress: string; limit?: number | null },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const limit = getAggregateLimit(args.limit, MAX_AGGREGATE_ROWS);
      return getSponsoredAccounts(ctx.pool, network.name, args.sponsorAddress, limit);
    },

    // ─── #227: Contracts & Deployments ───────────────────────────────────
    async contract(
      _: unknown,
      args: { network?: string | null; contractId: string },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const row = await getContractDeployment(ctx.pool, network.name, args.contractId);
      if (!row) return null;
      return {
        contractId: row.contract_id,
        deployer: row.deployer,
        wasmHash: row.wasm_hash,
        deployedLedger: row.deployed_ledger,
        deployedAt: row.deployed_at,
      };
    },
    async contracts(
      _: unknown,
      args: { network?: string | null; limit?: number; cursor?: string },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const limit = getPageSize(args.limit, 20);
      const rows = await getContracts(ctx.pool, network.name, limit, args.cursor ?? undefined);
      return rows.map((row) => ({
        contractId: row.contract_id,
        deployer: row.deployer,
        wasmHash: row.wasm_hash,
        deployedLedger: row.deployed_ledger,
        deployedAt: row.deployed_at,
      }));
    },

    // ─── #228: Network Statistics ────────────────────────────────────────
    async networkStats(
      _: unknown,
      args: { network?: string | null; startTime: string; endTime: string; granularity?: string; limit?: number | null },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const granularity = args.granularity === 'day' ? 'day' : 'hour';
      const limit = getAggregateLimit(args.limit, MAX_AGGREGATE_ROWS);
      assertRangeWithinLimit(args.startTime, args.endTime, granularity, limit);
      const rows = await getNetworkStats(
        ctx.pool,
        network.name,
        args.startTime,
        args.endTime,
        granularity,
        limit
      );
      return rows.map((row) => ({
        bucketStart: row.bucket_start,
        transactionCount: row.transaction_count,
        operationCount: row.operation_count,
        activeAccounts: row.active_accounts,
        totalVolume: row.total_volume,
      }));
    },

    // ─── #229: Activity Rollups ──────────────────────────────────────────
    async activityRollups(
      _: unknown,
      args: {
        network?: string | null;
        granularity?: string;
        startTime: string;
        endTime: string;
        limit?: number | null;
      },
      ctx: Context
    ) {
      const network = networkArgument(args, ctx);
      const granularity = args.granularity === 'day' ? 'day' : 'hour';
      const limit = getAggregateLimit(args.limit, MAX_AGGREGATE_ROWS);
      assertRangeWithinLimit(args.startTime, args.endTime, granularity, limit);
      const rows = await getActivityRollups(
        ctx.pool,
        network.name,
        granularity,
        args.startTime,
        args.endTime,
        limit
      );
      return rows.map((row) => ({
        bucketStart: row.bucket_start,
        granularity: row.granularity,
        network: row.network,
        transactionCount: row.transaction_count,
        operationCount: row.operation_count,
        activeAccounts: row.active_accounts,
        totalVolume: row.total_volume,
      }));
    },
  },

  Account: {
    async transactions(parent: { address: string; network?: string }, args: { limit?: number }, ctx: Context) {
      const limit = getPageSize(args.limit, 10);
      const network = networkForParent(ctx, parent.network);
      return getAccountTransactions(ctx.pool, network.name, parent.address, limit);
    },
    async signers(parent: { address: string; network?: string }, _: unknown, ctx: Context) {
      const network = networkForParent(ctx, parent.network);
      return getAccountSigners(ctx.pool, network.name, parent.address);
    },
    async operations(parent: { address: string; network?: string }, args: { limit?: number }, ctx: Context) {
      const limit = getPageSize(args.limit, 10);
      const network = networkForParent(ctx, parent.network);
      return getAccountOperations(ctx.pool, network.name, parent.address, limit);
    },
  },

  ContractDeployment: {
    async sharedWasmContracts(
      parent: { contractId: string; wasmHash: string; network?: string },
      args: { limit?: number },
      ctx: Context
    ) {
      const network = networkForParent(ctx, parent.network);
      const limit = getPageSize(args.limit, 10);
      const rows = await getSharedWasmContracts(
        ctx.pool,
        network.name,
        parent.wasmHash,
        parent.contractId,
        limit
      );
      return rows.map((row) => ({
        contractId: row.contract_id,
        deployer: row.deployer,
        wasmHash: row.wasm_hash,
        deployedLedger: row.deployed_ledger,
        deployedAt: row.deployed_at,
      }));
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
  ContractEvent: {
    async transaction(parent: { transactionHash?: string | null; network?: string }, _: unknown, ctx: Context) {
      if (!parent.transactionHash) return null;
      const network = networkForParent(ctx, parent.network);
      return ctx.loaders
        ? ctx.loaders(network).transaction.load(parent.transactionHash)
        : getTransactionByHash(ctx.pool, network.name, parent.transactionHash);
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

  EffectDetails: {
    // effects.ts tags each detail object with the member type it was mapped to.
    __resolveType(details: { __typename: string }) {
      return details.__typename;
    },
  },
};
