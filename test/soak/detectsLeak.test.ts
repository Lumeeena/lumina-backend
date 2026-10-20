/**
 * The soak test's claim, checked end to end: a resource leak is caught by its
 * trend while the process is still up, and a healthy process doing the same
 * work is not flagged.
 *
 * Runs the same sampler and detector as the soak (sampler.ts, trend.ts)
 * against two copies of a small service (fixtures/leakyService.ts) for about a
 * minute — one that lets go of what it allocates and one that keeps a slice of
 * it. Real leaks are slower; the fixture's are fast so that a minute is a long
 * run in its terms, and the thresholds are the soak's own, unscaled.
 *
 * Needs TEST_DATABASE_URL: the connection leak is a real Postgres connection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { Pool } from 'pg';
import { freePort, httpJson, sleep } from '../stack/stack';
import { judge, ResourceSampler, type Judgement } from './sampler';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const skip = DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

const RUN_MS = 60_000;
const WARMUP_MS = 8_000;
const SAMPLE_MS = 500;

interface Fixture {
  name: string;
  port: number;
  child: ChildProcess;
}

async function startFixture(name: string, leak: boolean): Promise<Fixture> {
  const port = await freePort();
  const url = new URL(DATABASE_URL!);
  url.searchParams.set('application_name', `lumina-soak-${name}`);
  const child = spawn(process.execPath, ['--require', 'ts-node/register', join(__dirname, 'fixtures', 'leakyService.ts')], {
    env: {
      ...process.env,
      TS_NODE_PROJECT: join(__dirname, '..', 'tsconfig.json'),
      TS_NODE_TRANSPILE_ONLY: 'true',
      PORT: String(port),
      DATABASE_URL: url.toString(),
      LEAK: leak ? '1' : '0',
      TICK_MS: '500',
    },
    stdio: 'ignore',
  });
  return { name, port, child };
}

function verdicts(judgements: Judgement[], target: string): Record<string, string> {
  return Object.fromEntries(
    judgements.filter(j => j.series.startsWith(`${target}.`)).map(j => [j.series.slice(target.length + 1), j.verdict])
  );
}

test('a leaking service is caught by trend before it crashes, and its healthy twin is not', { skip, timeout: 180_000 }, async t => {
  const observer = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const fixtures = [await startFixture('healthy', false), await startFixture('leaking', true)];
  try {
    const sampler = new ResourceSampler(
      fixtures.map(f => ({
        name: f.name,
        prefix: 'leaky_',
        scrape: async () => {
          const result = await httpJson(`http://127.0.0.1:${f.port}/metrics`, {}, 2_000);
          return result.status === 200 && typeof result.body === 'string' ? result.body : null;
        },
      })),
      async () => {
        const { rows } = await observer.query<{ application_name: string; n: string }>(
          `SELECT application_name, count(*) AS n FROM pg_stat_activity
            WHERE application_name LIKE 'lumina-soak-%' GROUP BY application_name`
        );
        return Object.fromEntries(rows.map(r => [r.application_name, Number(r.n)]));
      },
      target => `lumina-soak-${target}`
    );

    const started = Date.now();
    while (Date.now() - started < RUN_MS) {
      await sampler.sample();
      await sleep(SAMPLE_MS);
    }
    const judgements = judge(sampler, WARMUP_MS, 8);
    const report = judgements.map(j => `${j.series}: ${j.verdict} — ${j.reason}`).join('\n');
    for (const j of judgements) t.diagnostic(`${j.series}: ${j.verdict} — ${j.reason}`);

    // Caught by trend, not by a crash: both processes are still running.
    for (const f of fixtures) assert.equal(f.child.exitCode, null, `${f.name} exited during the run`);

    assert.deepEqual(verdicts(judgements, 'leaking'), {
      rss: 'rising', heap: 'rising', handles: 'rising', fds: 'rising', pgConnections: 'rising',
    }, report);
    assert.deepEqual(verdicts(judgements, 'healthy'), {
      rss: 'stable', heap: 'stable', handles: 'stable', fds: 'stable', pgConnections: 'stable',
    }, report);
  } finally {
    for (const f of fixtures) f.child.kill('SIGKILL');
    await observer.end();
  }
});
