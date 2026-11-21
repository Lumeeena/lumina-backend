import { Pool } from 'pg';
import { createHorizonClient } from '@lumina/shared';

/** One-off repair for pool totals previously accumulated from operations. */
async function repair(): Promise<void> {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!, process.argv[i + 1]!);
  const network = args.get('--network');
  const horizonUrl = args.get('--horizon-url');
  const databaseUrl = process.env.DATABASE_URL;
  if (!network || !horizonUrl || !databaseUrl) {
    throw new Error('usage: DATABASE_URL=... npm run repair:liquidity-pools -- --network <name> --horizon-url <url>');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const horizon = createHorizonClient({ name: 'pool-repair', minIntervalMs: 100 });
  try {
    const { rows } = await pool.query<{ pool_id: string }>(
      'SELECT pool_id FROM liquidity_pools WHERE network = $1 ORDER BY pool_id', [network]
    );
    for (const { pool_id: poolId } of rows) {
      const state = await horizon.getLiquidityPool(poolId, horizonUrl);
      if (state.reserves.length !== 2) throw new Error(`Horizon returned an invalid reserve set for pool ${poolId}`);
      await pool.query(
        `UPDATE liquidity_pools SET asset_a = $1, asset_b = $2, fee_bp = $3,
          reserve_a = $4::numeric, reserve_b = $5::numeric, total_shares = $6::numeric, updated_at = NOW()
         WHERE pool_id = $7 AND network = $8`,
        [state.reserves[0]!.asset, state.reserves[1]!.asset, state.fee_bp,
          state.reserves[0]!.amount, state.reserves[1]!.amount, state.total_shares, poolId, network]
      );
      process.stdout.write(`Repaired ${poolId}\n`);
    }
    process.stdout.write(`Repaired ${rows.length} liquidity pools on ${network}\n`);
  } finally {
    await pool.end();
  }
}

repair().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
