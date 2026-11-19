/**
 * Top-accounts-by-activity leaderboard query (#230, #376).
 *
 * Queries Lumina's real indexed tables (`operations` and `trades`) with all
 * values bound as SQL parameters — zero string interpolation.
 */
import type { Pool } from 'pg';
import { GraphQLError } from 'graphql';
import { ERROR_CODES } from './errorCodes';
import { MAX_PAGE_SIZE } from './pagination';

export interface TopAccountEntry {
  account: string;
  operationCount: number;
  tradeCount: number;
  totalVolume: string;
  score: number;
}

export type TopAccountsWindow = '1d' | '7d' | '30d' | 'all';

export interface TopAccountsOptions {
  window: TopAccountsWindow;
  limit: number;
  network: string;
}

const WINDOW_SECONDS: Record<TopAccountsWindow, number> = {
  '1d': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
  all: 0,
};

/** Maps GraphQL enum names (`DAY_1`, `DAY_7`, `DAY_30`, `ALL`) or string keys to canonical window keys. */
export function normalizeTopAccountsWindow(value?: string | null): TopAccountsWindow {
  switch (value) {
    case 'DAY_1':
    case '1d':
      return '1d';
    case 'DAY_7':
    case '7d':
    case undefined:
    case null:
      return '7d';
    case 'DAY_30':
    case '30d':
      return '30d';
    case 'ALL':
    case 'all':
      return 'all';
    default:
      throw new GraphQLError(
        `Invalid window "${value}". Expected one of DAY_1, DAY_7, DAY_30, ALL.`,
        { extensions: { code: ERROR_CODES.BAD_USER_INPUT } }
      );
  }
}

/**
 * Ranks accounts on `network` by activity score (`operation_count + trade_count * 2`),
 * tie-breaking by total trade volume descending.
 *
 * Parameter binding:
 * - Bounded window (`1d`, `7d`, `30d`): `$1` = network, `$2` = window seconds, `$3` = limit
 * - Unbounded window (`all`): `$1` = network, `$2` = limit
 */
export async function getTopAccountsByActivity(
  pool: Pick<Pool, 'query'>,
  options: TopAccountsOptions
): Promise<TopAccountEntry[]> {
  const { window, network } = options;
  const limit = Math.min(Math.max(1, Math.trunc(options.limit)), MAX_PAGE_SIZE);
  const windowSeconds = WINDOW_SECONDS[window];
  if (windowSeconds === undefined) {
    throw new GraphQLError(`Unsupported activity window: ${String(window)}`, {
      extensions: { code: ERROR_CODES.BAD_USER_INPUT },
    });
  }

  const hasWindow = windowSeconds > 0;
  const opsTimeClause = hasWindow
    ? "AND o.created_at >= NOW() - ($2::bigint * INTERVAL '1 second')"
    : '';
  const tradesTimeClause = hasWindow
    ? "AND t.ledger_close_time >= NOW() - ($2::bigint * INTERVAL '1 second')"
    : '';
  const limitParam = hasWindow ? '$3' : '$2';

  const query = `
    WITH account_ops AS (
      SELECT
        o.source_account AS account,
        COUNT(*) AS operation_count
      FROM operations o
      WHERE o.network = $1 ${opsTimeClause}
      GROUP BY o.source_account
    ),
    trade_legs AS (
      SELECT t.base_account AS account, t.base_amount AS volume
      FROM trades t
      WHERE t.network = $1 ${tradesTimeClause}
      UNION ALL
      SELECT t.counter_account AS account, t.counter_amount AS volume
      FROM trades t
      WHERE t.network = $1 AND t.counter_account IS NOT NULL ${tradesTimeClause}
    ),
    account_trades AS (
      SELECT
        tl.account,
        COUNT(*) AS trade_count,
        COALESCE(SUM(tl.volume), 0) AS total_volume
      FROM trade_legs tl
      GROUP BY tl.account
    ),
    combined AS (
      SELECT
        COALESCE(ops.account, tr.account) AS account,
        COALESCE(ops.operation_count, 0) AS operation_count,
        COALESCE(tr.trade_count, 0) AS trade_count,
        COALESCE(tr.total_volume, 0) AS total_volume
      FROM account_ops ops
      FULL OUTER JOIN account_trades tr ON ops.account = tr.account
    )
    SELECT
      account,
      operation_count,
      trade_count,
      total_volume::text AS total_volume,
      (operation_count + trade_count * 2)::float AS score
    FROM combined
    WHERE account IS NOT NULL
    ORDER BY score DESC, total_volume DESC, account ASC
    LIMIT ${limitParam}
  `;

  const params: unknown[] = hasWindow ? [network, windowSeconds, limit] : [network, limit];
  const result = await pool.query<{
    account: string;
    operation_count: string;
    trade_count: string;
    total_volume: string;
    score: string;
  }>(query, params);

  return result.rows.map((row) => ({
    account: row.account,
    operationCount: parseInt(row.operation_count, 10),
    tradeCount: parseInt(row.trade_count, 10),
    totalVolume: row.total_volume,
    score: parseFloat(row.score),
  }));
}
