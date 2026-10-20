/**
 * Chaos tests: fail each dependency of a running stack, then all of them at
 * once, and require the services to recover on their own.
 *
 * "On their own" is the deployment's own recovery and nothing more: the
 * services run under the restart policy docker-compose gives them (see
 * test/stack/supervisor.ts), and the only thing the test does after injecting
 * a fault is clear it. Recovery means all of:
 *
 * - the indexer has every ledger, with no gap, and has caught up to the chain;
 * - nothing is left in the retry queue or recorded as failed;
 * - both services report healthy, and the API serves the newest ledger;
 * - a subscriber that was connected before the fault receives again;
 * - contract events have caught up;
 * - neither service holds more Postgres connections than its pool allows.
 *
 * What happened along the way — how long the API stayed up, whether a process
 * restarted and why, how long recovery took — is recorded per scenario to
 * test/.artifacts/chaos/report.{json,md}. docs/CHAOS_TESTING.md has a run.
 *
 * Needs TEST_DATABASE_URL and both services built (`npm run build`).
 * CHAOS_SCENARIOS=name,name runs a subset.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, Stack, sleep, waitFor, type SubscriptionProbe } from '../stack/stack';
import type { ExitRecord, SupervisedService } from '../stack/supervisor';
import { SCENARIOS, type Scenario } from './scenarios';

const skip = process.env['TEST_DATABASE_URL'] ? false : 'TEST_DATABASE_URL is not set';
const RECOVERY_TIMEOUT_MS = Number(process.env['CHAOS_RECOVERY_TIMEOUT_MS'] ?? 90_000);
const ARTIFACTS = join(REPO_ROOT, 'test', '.artifacts', 'chaos');
/**
 * The most Postgres connections each service can hold without leaking: its
 * pools at their default ceiling of 10, plus one dedicated connection — the
 * indexer's leader lock (beside a write and a read pool), the server's LISTEN.
 */
const MAX_CONNECTIONS: Record<string, number> = { 'lumina-indexer': 21, 'lumina-graphql': 11 };
/** The indexer reads events a few ledgers behind the RPC tip on purpose (EVENTS_SAFETY_LAG_LEDGERS). */
const EVENTS_LAG_LEDGERS = 8;

const only = (process.env['CHAOS_SCENARIOS'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
const selected = only.length > 0 ? SCENARIOS.filter(s => only.includes(s.name)) : SCENARIOS;

interface Restart {
  service: string;
  code: number | null;
  afterInjectMs: number;
  reason: string;
}

interface ScenarioReport {
  name: string;
  dependency: Scenario['dependency'];
  fault: string;
  midTransaction: boolean | null;
  holdMs: number;
  recovered: boolean;
  /** From the fault clearing to the last recovery condition holding. */
  recoveryMs: number | null;
  failure?: string;
  duringFault: {
    /** Share of probes the GraphQL API answered with data while the fault held. */
    apiAvailability: number;
    /** First non-200 from each /health after the fault went in, if any. */
    indexerUnhealthyAfterMs: number | null;
    graphqlUnhealthyAfterMs: number | null;
    ledgersIndexed: number;
  };
  restarts: Restart[];
  subscriptionDisconnects: number;
  connections: { before: Record<string, number>; after: Record<string, number> };
  errorsLogged: { indexer: number; graphql: number };
}

const reports: ScenarioReport[] = [];

/**
 * Why the process said it was stopping: an uncaught exception's message, else
 * its last fatal line, else its last error line.
 */
function exitReason(exit: ExitRecord): string {
  const lines = [...exit.lastLines].reverse();
  const uncaught = lines.find(line => /^\w*Error: /.test(line));
  if (uncaught) return `uncaught ${uncaught.trim()}`;
  for (const level of [60, 50]) {
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { level?: number; msg?: string; err?: unknown };
        if (entry.level === level) return [entry.msg, typeof entry.err === 'string' ? entry.err : ''].filter(Boolean).join(': ');
      } catch {
        // Not a log line.
      }
    }
  }
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
}

function errorsLogged(service: SupervisedService, since: number): number {
  return service.recentLines.filter(line => {
    try {
      const entry = JSON.parse(line) as { level?: number; time?: string };
      return (entry.level ?? 0) >= 50 && Date.parse(entry.time ?? '') >= since;
    } catch {
      return false;
    }
  }).length;
}

async function contractEventsTip(stack: Stack): Promise<number> {
  const { rows: [row] } = await stack.observer.query<{ max: string | null }>('SELECT max(ledger) AS max FROM contract_events');
  return Number(row?.max ?? 0);
}

/** Every recovery condition at once; resolves to the first one that does not hold, or null. */
async function unrecovered(stack: Stack, probe: SubscriptionProbe, since: number): Promise<string | null> {
  const tip = stack.horizon.tip();
  const ledgers = await stack.ledgers();
  if (ledgers.gaps !== 0) return `${ledgers.gaps} ledgers missing between ${ledgers.min} and ${ledgers.max}`;
  if (ledgers.max < tip - 3) return `indexer at ledger ${ledgers.max}, chain at ${tip}`;
  const owed = await stack.owedLedgers();
  if (owed > 0) return `${owed} ledgers still queued for retry or recorded as failed`;
  const [indexerHealth, graphqlHealth] = await Promise.all([stack.indexerHealth(), stack.graphqlHealth()]);
  if (indexerHealth.status !== 200) return `indexer /health is ${indexerHealth.status ?? indexerHealth.error}`;
  if (graphqlHealth.status !== 200) return `graphql /health is ${graphqlHealth.status ?? graphqlHealth.error}`;
  const served = await stack.servedTip();
  if (served === null || served < ledgers.max - 3) return `the API serves ledger ${served}, the indexer has ${ledgers.max}`;
  if (probe.lastReceivedAt <= since) return 'the subscription has received nothing since the fault cleared';
  const events = await contractEventsTip(stack);
  if (events < tip - EVENTS_LAG_LEDGERS) return `contract events at ledger ${events}, chain at ${tip}`;
  const connections = await stack.connections();
  for (const [name, count] of Object.entries(connections)) {
    if (count > (MAX_CONNECTIONS[name] ?? 0)) return `${name} holds ${count} Postgres connections`;
  }
  return null;
}

async function runScenario(scenario: Scenario): Promise<ScenarioReport> {
  const stack = await Stack.start({ name: `chaos-${scenario.name}`, artifactsDir: join(ARTIFACTS, scenario.name) });
  const probe = stack.subscribe('subscription { newTransaction { hash ledger } }');
  try {
    // Start-up, not recovery: generous, because a cold CI runner starting two
    // freshly built services is slow, and a slow start is not what is tested.
    await stack.waitUntilCaughtUp(120_000);
    await waitFor('the subscription to receive before the fault', () => probe.received > 0, 60_000);
    const connectionsBefore = await stack.connections();
    const exitsBefore = { indexer: stack.indexer.exits.length, graphql: stack.graphql.exits.length };

    const injectedAt = Date.now();
    const { midTransaction } = await scenario.inject(stack);
    const ledgersAtInject = (await stack.ledgers()).max;

    // While the fault holds, record what still works rather than asserting it:
    // degrading is allowed, staying down is not.
    let probes = 0;
    let answered = 0;
    let indexerUnhealthyAfterMs: number | null = null;
    let graphqlUnhealthyAfterMs: number | null = null;
    const holdUntil = Date.now() + scenario.holdMs;
    do {
      const [served, indexerHealth, graphqlHealth] = await Promise.all([
        stack.servedTip(), stack.indexerHealth(), stack.graphqlHealth(),
      ]);
      probes++;
      if (served !== null) answered++;
      if (indexerHealth.status !== 200 && indexerUnhealthyAfterMs === null) indexerUnhealthyAfterMs = Date.now() - injectedAt;
      if (graphqlHealth.status !== 200 && graphqlUnhealthyAfterMs === null) graphqlUnhealthyAfterMs = Date.now() - injectedAt;
      await sleep(500);
    } while (Date.now() < holdUntil);
    const ledgersIndexed = (await stack.ledgers()).max - ledgersAtInject;

    await scenario.clear(stack);
    const clearedAt = Date.now();

    let recoveryMs: number | null = null;
    let failure: string | undefined;
    let lastProblem: string | null = 'not checked yet';
    try {
      recoveryMs = await waitFor(
        'recovery',
        async () => (lastProblem = await unrecovered(stack, probe, clearedAt)) === null,
        RECOVERY_TIMEOUT_MS,
        500
      );
    } catch {
      failure = `not recovered ${RECOVERY_TIMEOUT_MS / 1000}s after the fault cleared: ${lastProblem}`;
    }

    // Give idle pool connections time to be reaped before counting them.
    await sleep(2_000);
    const restarts: Restart[] = [];
    for (const [service, before] of [[stack.indexer, exitsBefore.indexer], [stack.graphql, exitsBefore.graphql]] as const) {
      for (const exit of service.exits.slice(before)) {
        restarts.push({ service: service.options.name, code: exit.code, afterInjectMs: exit.at - injectedAt, reason: exitReason(exit) });
      }
    }

    return {
      name: scenario.name,
      dependency: scenario.dependency,
      fault: scenario.fault,
      midTransaction: midTransaction ?? null,
      holdMs: scenario.holdMs,
      recovered: failure === undefined,
      recoveryMs,
      ...(failure ? { failure } : {}),
      duringFault: {
        apiAvailability: probes === 0 ? 1 : answered / probes,
        indexerUnhealthyAfterMs,
        graphqlUnhealthyAfterMs,
        ledgersIndexed,
      },
      restarts,
      subscriptionDisconnects: probe.disconnects,
      connections: { before: connectionsBefore, after: await stack.connections() },
      errorsLogged: { indexer: errorsLogged(stack.indexer, injectedAt), graphql: errorsLogged(stack.graphql, injectedAt) },
    };
  } finally {
    probe.close();
    await stack.stop();
  }
}

function markdown(rows: ScenarioReport[]): string {
  const ms = (v: number | null) => (v === null ? '—' : `${(v / 1000).toFixed(1)} s`);
  const lines = [
    '| scenario | mid-tx | recovered | recovery | API up during fault | indexer unhealthy after | ledgers during fault | restarts |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    const restarts = r.restarts.length === 0
      ? 'none'
      : r.restarts.map(x => `${x.service} (exit ${x.code}): ${x.reason}`).join('; ');
    lines.push(
      `| \`${r.name}\` | ${r.midTransaction === null ? '—' : r.midTransaction ? 'yes' : 'no'} | ${r.recovered ? 'yes' : `**no** — ${r.failure}`} | ${ms(r.recoveryMs)} | ${Math.round(r.duringFault.apiAvailability * 100)}% | ${ms(r.duringFault.indexerUnhealthyAfterMs)} | ${r.duringFault.ledgersIndexed} | ${restarts} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

after(() => {
  if (reports.length === 0) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(join(ARTIFACTS, 'report.json'), JSON.stringify(reports, null, 2));
  writeFileSync(join(ARTIFACTS, 'report.md'), markdown(reports));
  process.stdout.write(`\n${markdown(reports)}\nrecorded to ${join(ARTIFACTS, 'report.{json,md}')}\n`);
});

for (const scenario of selected) {
  test(`${scenario.name}: ${scenario.fault}`, { skip, timeout: 360_000 }, async () => {
    const report = await runScenario(scenario);
    reports.push(report);
    assert.ok(report.recovered, report.failure);
    assert.ok(
      report.restarts.every(r => r.code !== null),
      'every exit was a process exiting, not being killed'
    );
  });
}
