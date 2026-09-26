import { Pool } from 'pg';
import { loadMigrations, runMigrations } from './migrations';

async function main() {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'status') {
    throw new Error('Usage: migrate <up|status>');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/lumina' });
  try {
    const status = await runMigrations(pool, loadMigrations(), command === 'up');
    console.log(`Applied: ${status.applied.length ? status.applied.join(', ') : '(none)'}`);
    console.log(`Pending: ${status.pending.length ? status.pending.join(', ') : '(none)'}`);
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
