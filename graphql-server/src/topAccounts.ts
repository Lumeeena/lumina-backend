/**
 * Top-accounts-by-activity query (#230).
 *
 * Leaderboard query over a configurable window, built on rollup tables.
 */

import { Pool } from "pg";

interface TopAccountEntry {
  account: string;
  operationCount: number;
  tradeCount: number;
  totalVolume: string;
  score: number;
}

interface TopAccountsOptions {
  window: "1d" | "7d" | "30d" | "all";
  limit: number;
  network?: string;
}

// Window definitions in seconds
const WINDOW_SECONDS = {
  "1d": 86400,
  "7d": 604800,
  "30d": 2592000,
  all: 0,
} as const;

/**
 * Query the top accounts by activity using rollup tables.
 *
 * Score is computed as a weighted sum of operations and trades, with
 * tie-breaking by total volume (descending).
 *
 * @param pool - Database connection pool
 * @param options - Query options (window, limit, network)
 */
export async function getTopAccountsByActivity(
  pool: Pool,
  options: TopAccountsOptions,
): Promise<TopAccountEntry[]> {
  const { window, limit, network } = options;
  const windowSeconds = WINDOW_SECONDS[window];

  // Build the time filter clause
  const timeFilter =
    windowSeconds > 0
      ? `AND ao.ledger_close_time > NOW() - INTERVAL '${windowSeconds} seconds'`
      : "";

  const networkFilter = network ? "AND a.network = $2" : "";

  const query = `
    WITH account_ops AS (
      SELECT
        source_account as account,
        COUNT(*) as operation_count
      FROM history_operations ao
      WHERE 1=1 ${timeFilter} ${networkFilter}
      GROUP BY source_account
    ),
    account_trades AS (
      SELECT
        account,
        COUNT(*) as trade_count,
        SUM(volume) as total_volume
      FROM history_trades
      WHERE 1=1 ${timeFilter} ${networkFilter}
      GROUP BY account
    ),
    combined AS (
      SELECT
        COALESCE(ops.account, trades.account) as account,
        COALESCE(ops.operation_count, 0) as operation_count,
        COALESCE(trades.trade_count, 0) as trade_count,
        COALESCE(trades.total_volume, 0) as total_volume
      FROM account_ops ops
      FULL OUTER JOIN account_trades trades ON ops.account = trades.account
    )
    SELECT
      account,
      operation_count,
      trade_count,
      total_volume::text as total_volume,
      (operation_count + trade_count * 2)::float as score
    FROM combined
    WHERE account IS NOT NULL
    ORDER BY score DESC, total_volume DESC
    LIMIT $1
  `;

  const params: unknown[] = network ? [limit, network] : [limit];
  const result = await pool.query(query, params);

  return result.rows.map((row) => ({
    account: row.account,
    operationCount: parseInt(row.operation_count, 10),
    tradeCount: parseInt(row.trade_count, 10),
    totalVolume: row.total_volume,
    score: parseFloat(row.score),
  }));
}
