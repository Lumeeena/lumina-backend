/**
 * `indexerStatus` is the query a client uses to say "this may be stale" out
 * loud, so what matters here is that it answers rather than throws in exactly
 * the situations it exists for — the indexer stopped, Horizon is unreachable —
 * and that both sides of the comparison are read for the requested network.
 *
 * Horizon and the database are injected so the test needs neither.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { getIndexerStatus, STALE_AFTER_LEDGERS } from './freshness';
import type { NetworkConfig } from './networks';

const MAINNET: NetworkConfig = {
  name: 'mainnet',
  horizonUrl: 'https://horizon.example',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
};

const NOW = 1_700_000_000_000;

function poolWithTip(sequence: number | null, indexedAt: Date | null = null): Pool {
  return {
    query: async () => ({ rows: [{ sequence: sequence === null ? null : String(sequence), indexed_at: indexedAt }] }),
  } as unknown as Pool;
}

test('a caught-up indexer reports no lag and is not stale', async () => {
  const report = await getIndexerStatus(poolWithTip(990, new Date(NOW - 2_000)), MAINNET, {
    readHorizonLedger: async () => ({ sequence: 995 }),
    now: () => NOW,
  });

  assert.equal(report.network, 'MAINNET');
  assert.equal(report.latestIndexedLedger, 990);
  assert.equal(report.horizonLedger, 995);
  assert.equal(report.lagLedgers, 5);
  assert.equal(report.stale, false);
  assert.equal(report.checkedAt, new Date(NOW).toISOString());
});

test('lag beyond the threshold marks the data stale', async () => {
  const report = await getIndexerStatus(poolWithTip(900), MAINNET, {
    readHorizonLedger: async () => ({ sequence: 900 + STALE_AFTER_LEDGERS + 1 }),
    now: () => NOW,
  });

  assert.equal(report.lagLedgers, STALE_AFTER_LEDGERS + 1);
  assert.equal(report.stale, true);
});

test('lag exactly at the threshold is still current', async () => {
  // The indexer legitimately trails by a ledger or two, and the threshold is
  // inclusive: stale means *beyond* it.
  const report = await getIndexerStatus(poolWithTip(900), MAINNET, {
    readHorizonLedger: async () => ({ sequence: 900 + STALE_AFTER_LEDGERS }),
    now: () => NOW,
  });

  assert.equal(report.stale, false);
});

test('an unreachable Horizon is an answer, not an error', async () => {
  const report = await getIndexerStatus(poolWithTip(900), MAINNET, {
    readHorizonLedger: async () => {
      throw new Error('connection refused');
    },
    now: () => NOW,
  });

  assert.equal(report.latestIndexedLedger, 900);
  assert.equal(report.horizonLedger, null);
  assert.equal(report.lagLedgers, null);
  assert.equal(report.stale, true);
});

test('an unreachable database is an answer, not an error', async () => {
  const failing = {
    query: async () => {
      throw new Error('connection refused');
    },
  } as unknown as Pool;

  const report = await getIndexerStatus(failing, MAINNET, {
    readHorizonLedger: async () => ({ sequence: 900 }),
    now: () => NOW,
  });

  assert.equal(report.latestIndexedLedger, null);
  assert.equal(report.latestIndexedAt, null);
  assert.equal(report.horizonLedger, 900);
  assert.equal(report.lagLedgers, null);
  assert.equal(report.stale, true);
});

test('an index that has never written anything is stale', async () => {
  const report = await getIndexerStatus(poolWithTip(null), MAINNET, {
    readHorizonLedger: async () => ({ sequence: 1_000 }),
    now: () => NOW,
  });

  assert.equal(report.latestIndexedLedger, null);
  assert.equal(report.lagLedgers, null);
  assert.equal(report.stale, true);
});

test('the Horizon tip is read from the requested network endpoint', async () => {
  // Both numbers describe one chain: reading mainnet's tip against testnet's
  // index would report a lag of half a million ledgers that does not exist.
  const seen: string[] = [];
  const network: NetworkConfig = {
    name: 'testnet',
    horizonUrl: 'https://horizon-testnet.example',
    networkPassphrase: 'Test SDF Network ; September 2015',
  };

  await getIndexerStatus(poolWithTip(100), network, {
    readHorizonLedger: async baseUrl => {
      seen.push(baseUrl);
      return { sequence: 101 };
    },
    now: () => NOW,
  });

  assert.deepEqual(seen, ['https://horizon-testnet.example']);
});
