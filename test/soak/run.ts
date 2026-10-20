#!/usr/bin/env node
/**
 * Soak test: run the whole stack under sustained load for a long time, and
 * fail if memory, handles or Postgres connections keep climbing.
 *
 * Tests run for seconds and the services run for weeks, and the bug class that
 * difference hides has already been found once: a Postgres connection leaked
 * per LISTEN reconnect, invisible in any short test and fatal after days. A
 * leak like that does not crash a soak — it would take days — but it does
 * show a floor that keeps rising, which is what this measures (see trend.ts
 * for how "rising" is decided, and detectsLeak.test.ts for the proof that it
 * is decided correctly).
 *
 * The load, for the whole run:
 * - the indexer follows a chain that closes a ledger every second, each with
 *   SOAK_TRANSACTIONS_PER_LEDGER transactions of five operations;
 * - SOAK_QUERIES_PER_SECOND GraphQL queries across the listings, lookups and
 *   nested resolvers clients use;
 * - long-lived subscriptions, plus one opened and closed every few seconds;
 * - every SOAK_RECONNECT_EVERY_MS, every pool and LISTEN connection is killed
 *   in Postgres, so the reconnect paths — where the known leak lived — run
 *   over and over. The leader-lock connection is spared: losing it restarts
 *   the indexer by design, and a restart would reset the very memory being
 *   watched.
 *
 * Unattended: one command, bounded by SOAK_DURATION_MS, exit status 0 or 1, a
 * report in SOAK_OUTPUT_DIR (report.md, report.json, samples.csv).
 * .github/workflows/soak.yml runs it on a schedule. Needs TEST_DATABASE_URL and
 * both services built.
 *
 *   SOAK_DURATION_MS=3600000 npm run test:soak
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, Stack, sleep, type SubscriptionProbe } from '../stack/stack';
import { formatValue, judge, ResourceSampler, type Judgement } from './sampler';

const MINUTE = 60_000;

function env(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return value;
}

const DURATION_MS = env('SOAK_DURATION_MS', 60 * MINUTE);
const SAMPLE_INTERVAL_MS = env('SOAK_SAMPLE_INTERVAL_MS', 10_000);
const WARMUP_MS = env('SOAK_WARMUP_MS', Math.max(5 * MINUTE, DURATION_MS * 0.15));
const WINDOWS = env('SOAK_WINDOWS', 8);
const QUERIES_PER_SECOND = env('SOAK_QUERIES_PER_SECOND', 20);
const RECONNECT_EVERY_MS = env('SOAK_RECONNECT_EVERY_MS', 5 * MINUTE);
const TRANSACTIONS_PER_LEDGER = env('SOAK_TRANSACTIONS_PER_LEDGER', 20);
/** Requests the API may fail before the run is failed for it: reconnect churn costs a few. */
const MAX_ERROR_RATE = env('SOAK_MAX_ERROR_RATE', 0.02);
const OUTPUT_DIR = process.env['SOAK_OUTPUT_DIR'] || join(REPO_ROOT, 'test', '.artifacts', 'soak');

interface LoadStats {
  requests: number;
  errors: number;
  latenciesMs: number[];
}

/** The queries a client sends, in rotation. Each takes what the previous ones learned. */
function queries(stack: Stack, learned: { hash?: string; account: string }) {
  const account = learned.account;
  return [
    () => stack.query('{ ledgers(limit: 20) { items { sequence closedAt transactionCount operationCount } } }'),
    async () => {
      const page = await stack.query('{ transactions(limit: 20) { items { hash ledger operations { id type amount asset } } pageInfo { endCursor } } }');
      const body = page.body as { data?: { transactions?: { items: Array<{ hash: string }>; pageInfo: { endCursor: string | null } } } };
      const tx = body?.data?.transactions;
      if (tx?.items[0]) learned.hash = tx.items[0].hash;
      if (tx?.pageInfo.endCursor) {
        return stack.query('query($c: String) { transactions(limit: 20, cursor: $c) { items { hash } } }', { c: tx.pageInfo.endCursor });
      }
      return page;
    },
    () => stack.query('query($a: String!) { operations(account: $a, limit: 20) { items { id type from to amount asset } } }', { a: account }),
    () => stack.query(
      'query($a: String!) { account(address: $a) { address balances { assetType balance } transactions(limit: 5) { hash } operations(limit: 5) { id } signers { key } } }',
      { a: account }
    ),
    () => stack.query('{ indexerStatus { latestIndexedLedger horizonLedger lagLedgers stale } }'),
    () => stack.query('query($h: String!) { transaction(hash: $h) { hash memo operations { id type } } }', { h: learned.hash ?? '' }),
    () => stack.query('{ operations(limit: 20, type: CHANGE_TRUST) { items { id asset } } }'),
  ];
}

async function runLoad(stack: Stack, stats: LoadStats, until: number): Promise<void> {
  const learned = { account: stack.horizon.accounts[1]! };
  const rotation = queries(stack, learned);
  const concurrency = Math.max(1, Math.ceil(QUERIES_PER_SECOND / 10));
  const gapMs = 1_000 / (QUERIES_PER_SECOND / concurrency);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < until) {
      const started = Date.now();
      learned.account = stack.horizon.accounts[(next % (stack.horizon.accounts.length - 1)) + 1]!;
      const result = await rotation[next++ % rotation.length]!();
      const body = result.body as { errors?: unknown[] } | null;
      stats.requests++;
      if (result.status !== 200 || (body && Array.isArray(body.errors) && body.errors.length > 0)) stats.errors++;
      stats.latenciesMs.push(Date.now() - started);
      if (stats.latenciesMs.length > 100_000) stats.latenciesMs.splice(0, 50_000);
      await sleep(Math.max(0, gapMs - (Date.now() - started)));
    }
  }));
}

async function runSubscriptionChurn(stack: Stack, until: number): Promise<number> {
  let opened = 0;
  while (Date.now() < until) {
    const address = stack.horizon.accounts[opened % stack.horizon.accounts.length]!;
    const probe = stack.subscribe(`subscription { accountActivity(address: "${address}") { id type } }`);
    opened++;
    await sleep(5_000);
    probe.close();
    await sleep(1_000);
  }
  return opened;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function markdown(judgements: Judgement[], summary: Record<string, unknown>): string {
  const rows = judgements.map(j =>
    `| \`${j.series}\` | ${formatValue(j.series, j.first)} | ${formatValue(j.series, j.last)} | ${j.verdict === 'rising' ? '**rising**' : j.verdict} | ${j.reason} |`
  );
  return [
    `Soak run: ${Math.round(DURATION_MS / MINUTE)} min, sampled every ${SAMPLE_INTERVAL_MS / 1000} s, ` +
      `first ${Math.round(WARMUP_MS / MINUTE)} min excluded as warm-up, ${WINDOWS} windows.`,
    '',
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    '',
    '| series | first | last | verdict | why |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  if (WARMUP_MS >= DURATION_MS) throw new Error('SOAK_WARMUP_MS must be shorter than SOAK_DURATION_MS');
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const stack = await Stack.start({
    name: 'soak',
    artifactsDir: OUTPUT_DIR,
    chain: { ledgerIntervalMs: 1_000, transactionsPerLedger: TRANSACTIONS_PER_LEDGER, operationsPerTransaction: 5, accounts: 200 },
  });
  const longLived: SubscriptionProbe[] = [];
  try {
    await stack.waitUntilCaughtUp(120_000);
    for (let i = 0; i < 3; i++) longLived.push(stack.subscribe('subscription { newTransaction { hash ledger } }'));

    const metricsOf = (service: 'indexer' | 'graphql') => async () => {
      const result = await stack.metrics(service);
      return result.status === 200 && typeof result.body === 'string' ? result.body : null;
    };
    const sampler = new ResourceSampler(
      [
        { name: 'indexer', prefix: 'lumina_indexer_', scrape: metricsOf('indexer') },
        { name: 'graphql', prefix: 'lumina_graphql_', scrape: metricsOf('graphql') },
      ],
      () => stack.connections(),
      target => `lumina-${target}`
    );

    const startedAt = Date.now();
    const until = startedAt + DURATION_MS;
    const stats: LoadStats = { requests: 0, errors: 0, latenciesMs: [] };
    let reconnects = 0;
    const load = runLoad(stack, stats, until);
    const churn = runSubscriptionChurn(stack, until);
    const reconnectLoop = (async () => {
      if (RECONNECT_EVERY_MS === 0) return;
      for (let at = startedAt + RECONNECT_EVERY_MS; at < until; at += RECONNECT_EVERY_MS) {
        await sleep(Math.max(0, at - Date.now()));
        if (Date.now() < until) {
          await stack.terminateBackends({ sparingLeader: true });
          reconnects++;
        }
      }
    })();

    let lastProgress = 0;
    while (Date.now() < until) {
      await sampler.sample();
      if (Date.now() - lastProgress > 5 * MINUTE) {
        lastProgress = Date.now();
        process.stderr.write(`soak: ${Math.round((Date.now() - startedAt) / MINUTE)} of ${Math.round(DURATION_MS / MINUTE)} min, ${stats.requests} requests\n`);
      }
      await sleep(SAMPLE_INTERVAL_MS);
    }
    const [subscriptionsOpened] = await Promise.all([churn, load, reconnectLoop]);

    const judgements = judge(sampler, WARMUP_MS, WINDOWS);
    const exits = [
      ...stack.indexer.exits.map(e => ({ service: 'indexer', ...e })),
      ...stack.graphql.exits.map(e => ({ service: 'graphql', ...e })),
    ];
    const ledgers = await stack.ledgers();
    const errorRate = stats.requests === 0 ? 1 : stats.errors / stats.requests;
    const problems = [
      ...judgements.filter(j => j.verdict !== 'stable').map(j => `${j.series}: ${j.verdict} — ${j.reason}`),
      ...exits.map(e => `${e.service} exited (code ${e.code}) during the run`),
      ...[...sampler.missed.entries()].filter(([, n]) => n > 0).map(([name, n]) => `${name} did not answer /metrics ${n} times`),
      ...(errorRate > MAX_ERROR_RATE ? [`${(errorRate * 100).toFixed(2)}% of requests failed`] : []),
      ...(ledgers.gaps > 0 ? [`${ledgers.gaps} ledgers missing`] : []),
    ];
    const summary = {
      verdict: problems.length === 0 ? 'pass' : 'fail',
      problems,
      requests: stats.requests,
      errorRate: Number(errorRate.toFixed(4)),
      latencyMs: { p50: percentile(stats.latenciesMs, 0.5), p95: percentile(stats.latenciesMs, 0.95), p99: percentile(stats.latenciesMs, 0.99) },
      subscriptions: { longLived: longLived.length, churned: subscriptionsOpened, disconnects: longLived.reduce((n, p) => n + p.disconnects, 0) },
      reconnects,
      ledgersIndexed: ledgers.count,
      exits: exits.length,
    };

    const csv = ['t_ms,series,value'];
    for (const [key, { samples }] of sampler.series) for (const s of samples) csv.push(`${s.t},${key},${s.v}`);
    writeFileSync(join(OUTPUT_DIR, 'samples.csv'), `${csv.join('\n')}\n`);
    writeFileSync(join(OUTPUT_DIR, 'report.json'), JSON.stringify({
      config: { DURATION_MS, SAMPLE_INTERVAL_MS, WARMUP_MS, WINDOWS, QUERIES_PER_SECOND, RECONNECT_EVERY_MS, TRANSACTIONS_PER_LEDGER },
      summary, judgements, exits,
    }, null, 2));
    const report = markdown(judgements, summary);
    writeFileSync(join(OUTPUT_DIR, 'report.md'), report);
    process.stdout.write(`${report}\nrecorded to ${OUTPUT_DIR}\n`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  } finally {
    for (const probe of longLived) probe.close();
    await stack.stop();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
