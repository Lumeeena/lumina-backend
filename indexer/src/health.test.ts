import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { Config } from './config';
import {
  aggregateNetworkStates,
  buildDebugConfiguration,
  buildHealthReport,
  healthStatusCode,
  startHealthServer,
  type DebugConfiguration,
  type IndexerState,
} from './health';

const THRESHOLDS = { maxSecondsSinceIndex: 60, maxLagLedgers: 20, startToleranceSeconds: 300 };
const NOW = 1_700_000_000_000;

function state(overrides: Partial<IndexerState> = {}): IndexerState {
  return {
    latestIndexedLedger: 1000,
    latestHorizonLedger: 1000,
    lastIndexedAt: NOW - 5_000,
    startedAt: NOW - 120_000,
    ...overrides,
  };
}

const okPool = { query: async () => ({ rows: [{ '?column?': 1 }] }) } as unknown as Pool;
const deadPool = {
  query: async () => {
    throw new Error('connection refused');
  },
} as unknown as Pool;

const debugConfig: Config = {
  horizonUrl: 'https://user:horizon-secret@horizon.example/base/path?api_key=query-secret',
  databaseUrl: 'postgresql://lumina:database-secret@db.example:5432/lumina?sslmode=require',
  pollIntervalMs: 5000,
  startLedger: 100,
  dbPoolMax: 10,
  dbPoolIdleTimeoutMs: 10000,
  dbPoolConnectionTimeoutMs: 0,
  sorobanRpcUrl: 'https://soroban.example/rpc/token-path?token=soroban-secret',
  indexedContractIds: ['Cstatic'],
  registryContractId: 'Cregistry',
  registryReadAccount: 'Gpublic',
  registryNetworkPassphrase: undefined,
  registryPollIntervalMs: 60000,
  healthPort: 9090,
  ledgerRetryAttempts: 3,
  ledgerRetryBaseMs: 500,
  accountCacheTtlMs: 300000,
  accountCacheMaxSize: 50000,
  eventsSafetyLagLedgers: 3,
  sorobanMinRequestIntervalMs: 100,
  sorobanMaxEventsPerCycle: 5000,
  sorobanRetentionWindowLedgers: 300000,
};

test('a caught-up indexer is healthy', async () => {
  const report = await buildHealthReport(state(), okPool, THRESHOLDS, NOW);

  assert.equal(report.status, 'ok');
  assert.equal(report.database, 'ok');
  assert.equal(report.lagLedgers, 0);
  assert.equal(healthStatusCode(report), 200);
});

test('health runs a real query rather than assuming the database is reachable', async () => {
  let queried = false;
  const pool = {
    query: async () => {
      queried = true;
      return { rows: [] };
    },
  } as unknown as Pool;

  await buildHealthReport(state(), pool, THRESHOLDS, NOW);

  // A check that answers 200 because the process is alive removes the signal
  // while looking like it provides one.
  assert.equal(queried, true);
});

test('an unreachable database makes the service unhealthy', async () => {
  const report = await buildHealthReport(state(), deadPool, THRESHOLDS, NOW);

  assert.equal(report.status, 'degraded');
  assert.equal(report.database, 'unreachable');
  assert.equal(healthStatusCode(report), 503);
  assert.match(report.checks.find(c => c.name === 'database')?.detail ?? '', /connection refused/);
});

test('a stalled indexer is unhealthy even though its process is fine', async () => {
  // The failure that actually happens: the loop is running and no longer
  // making progress. Every other signal looks identical to a healthy service.
  const report = await buildHealthReport(
    state({ lastIndexedAt: NOW - 120_000 }),
    okPool,
    THRESHOLDS,
    NOW
  );

  assert.equal(report.status, 'degraded');
  assert.equal(report.secondsSinceLastIndex, 120);
  const freshness = report.checks.find(c => c.name === 'indexing-freshness');
  assert.equal(freshness?.ok, false);
  assert.match(freshness?.detail ?? '', /threshold 60s/);
});

test('falling behind Horizon is unhealthy', async () => {
  const report = await buildHealthReport(
    state({ latestIndexedLedger: 900, latestHorizonLedger: 1000 }),
    okPool,
    THRESHOLDS,
    NOW
  );

  assert.equal(report.lagLedgers, 100);
  assert.equal(report.status, 'degraded');
  assert.match(report.checks.find(c => c.name === 'indexing-lag')?.detail ?? '', /100 ledgers behind/);
});

test('lag never reports negative when the indexer is ahead of a stale tip', async () => {
  const report = await buildHealthReport(
    state({ latestIndexedLedger: 1005, latestHorizonLedger: 1000 }),
    okPool,
    THRESHOLDS,
    NOW
  );

  assert.equal(report.lagLedgers, 0);
  assert.equal(report.status, 'ok');
});

test('a service that has not indexed yet reports starting, not degraded', async () => {
  // Reporting a booting service as broken teaches people to ignore the signal.
  const report = await buildHealthReport(
    state({ lastIndexedAt: null, latestIndexedLedger: 0 }),
    okPool,
    THRESHOLDS,
    NOW
  );

  assert.equal(report.status, 'starting');
  assert.equal(report.secondsSinceLastIndex, null);
  assert.equal(healthStatusCode(report), 200);
});

test('a booting service with an unreachable database is still degraded', async () => {
  const report = await buildHealthReport(state({ lastIndexedAt: null }), deadPool, THRESHOLDS, NOW);

  assert.equal(report.status, 'degraded');
});

test('uptime is reported in seconds', async () => {
  const report = await buildHealthReport(state({ startedAt: NOW - 90_000 }), okPool, THRESHOLDS, NOW);

  assert.equal(report.uptimeSeconds, 90);
});

test('thresholds are honoured as configured', async () => {
  const lenient = { maxSecondsSinceIndex: 600, maxLagLedgers: 500, startToleranceSeconds: 300 };
  const report = await buildHealthReport(
    state({ lastIndexedAt: NOW - 120_000, latestIndexedLedger: 900, latestHorizonLedger: 1000 }),
    okPool,
    lenient,
    NOW
  );

  assert.equal(report.status, 'ok');
});

// ─── Multiple networks ─────────────────────────────────────────────────────

test('the flat numbers describe the network that is worst off', async () => {
  // Averaging two chains — or reporting whichever loop wrote last — hides the
  // one that is stuck behind a healthy one.
  const aggregated = aggregateNetworkStates(NOW, [
    { network: 'mainnet', latestIndexedLedger: 5000, latestHorizonLedger: 5000, lastIndexedAt: NOW - 2_000 },
    { network: 'testnet', latestIndexedLedger: 100, latestHorizonLedger: 400, lastIndexedAt: NOW - 30_000 },
  ]);

  assert.equal(aggregated.latestIndexedLedger, 100);
  assert.equal(aggregated.latestHorizonLedger, 400);
  assert.equal(aggregated.lastIndexedAt, NOW - 30_000);

  const report = await buildHealthReport(aggregated, okPool, THRESHOLDS, NOW);
  assert.equal(report.status, 'degraded');
  assert.equal(report.lagLedgers, 300);
  assert.deepEqual(report.networks, [
    {
      network: 'mainnet',
      latestIndexedLedger: 5000,
      latestHorizonLedger: 5000,
      lagLedgers: 0,
      secondsSinceLastIndex: 2,
    },
    {
      network: 'testnet',
      latestIndexedLedger: 100,
      latestHorizonLedger: 400,
      lagLedgers: 300,
      secondsSinceLastIndex: 30,
    },
  ]);
});

test('a network that has never indexed is never averaged away', () => {
  const aggregated = aggregateNetworkStates(NOW, [
    { network: 'mainnet', latestIndexedLedger: 5000, latestHorizonLedger: 5000, lastIndexedAt: NOW - 1_000 },
    { network: 'futurenet', latestIndexedLedger: 0, latestHorizonLedger: 0, lastIndexedAt: null },
  ]);

  // The healthy chain must not paper over one that has produced nothing.
  assert.equal(aggregated.lastIndexedAt, null);
  assert.equal(aggregated.latestIndexedLedger, 0);
  assert.deepEqual(
    aggregated.networks?.map(entry => entry.network),
    ['mainnet', 'futurenet']
  );
});

test('a single-network deployment reports no per-network breakdown', async () => {
  const report = await buildHealthReport(state(), okPool, THRESHOLDS, NOW);

  assert.equal(report.networks, undefined);
});

test('aggregating no networks at all is an idle report, not a crash', () => {
  const aggregated = aggregateNetworkStates(NOW, []);

  assert.equal(aggregated.lastIndexedAt, null);
  assert.equal(aggregated.latestIndexedLedger, 0);
  assert.equal(aggregated.startedAt, NOW);
});

test('debug configuration masks URL credentials and reports live network state', async () => {
  const debug = buildDebugConfiguration(debugConfig, 'testnet', [{
    network: 'testnet',
    horizonUrl: debugConfig.horizonUrl,
    sorobanRpcUrl: debugConfig.sorobanRpcUrl,
    networkPassphrase: 'Test SDF Network ; September 2015',
    cursor: 123,
    eventsCursor: 120,
    latestIndexedLedger: 123,
    latestHorizonLedger: 130,
    watchedContracts: ['Cstatic', 'Cdiscovered', 'Cstatic'],
    registryContractId: 'Cregistry',
    discoveredContracts: ['Cdiscovered', 'Cdiscovered'],
  }]);

  const serialized = JSON.stringify(debug);
  assert.doesNotMatch(serialized, /horizon-secret|database-secret|query-secret|token-path|soroban-secret/);
  assert.equal(debug.config.databaseUrl, 'postgresql://db.example:5432/[redacted]?[redacted]');
  assert.equal(debug.networks[0]?.cursor, 123);
  assert.equal(debug.networks[0]?.eventsCursor, 120);
  assert.deepEqual(debug.networks[0]?.watchedContracts, ['Cdiscovered', 'Cstatic']);
});

test('GET /debug/config returns no-store JSON and rejects writes', async () => {
  const debug: DebugConfiguration = buildDebugConfiguration(debugConfig, 'testnet', []);
  const server = startHealthServer({
    port: 0,
    getState: () => state(),
    getDebugConfiguration: () => debug,
    pool: null,
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/debug/config`;

  try {
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), debug);

    const writeResponse = await fetch(endpoint, { method: 'POST' });
    assert.equal(writeResponse.status, 405);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
});
