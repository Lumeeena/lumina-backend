import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import type { Pool } from 'pg';
import { createContext, resolvers } from './resolvers';
import { resolveNetworks } from './networks';

// index.ts builds exactly this at startup, and makeExecutableSchema throws on a
// resolver for a field the schema does not declare. Twice that was a server
// that could not boot while every test passed: `Query.accountBalanceHistory`
// after its field was dropped from schema.graphql, and `Account.signers`, whose
// field was never added. Nothing else in the unit suite builds the schema.
test('the resolvers and schema.graphql build the executable schema the server starts with', () => {
  const typeDefs = readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8');
  assert.doesNotThrow(() => makeExecutableSchema({ typeDefs, resolvers }));
});

test('ledgerCoverage query distinguishes indexed ranges from missing intervals', async () => {
  const typeDefs = readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8');
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const pool = {
    query: async () => ({ rows: [
      { is_indexed: true, range_start: '100', range_end: '101', indexed_count: '2' },
      { is_indexed: false, range_start: '102', range_end: '103', indexed_count: '0' },
    ] }),
  } as unknown as Pool;

  const result = await graphql({
    schema,
    source: `query {
      ledgerCoverage(startLedger: 100, endLedger: 103) {
        complete
        indexedLedgerCount
        indexedRanges { startLedger endLedger }
        gaps { startLedger endLedger }
      }
    }`,
    contextValue: createContext(pool),
  });

  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data?.ledgerCoverage)), {
    complete: false,
    indexedLedgerCount: 2,
    indexedRanges: [{ startLedger: 100, endLedger: 101 }],
    gaps: [{ startLedger: 102, endLedger: 103 }],
  });
});

test('ledgerCoverage rejects reversed or nonpositive ranges', async () => {
  const typeDefs = readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8');
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const pool = { query: async () => { throw new Error('query should not run'); } } as unknown as Pool;
  const result = await graphql({
    schema,
    source: '{ ledgerCoverage(startLedger: 5, endLedger: 4) { complete } }',
    contextValue: createContext(pool),
  });

  assert.equal(result.data?.ledgerCoverage, undefined);
  assert.equal(result.errors?.[0]?.extensions.code, 'BAD_USER_INPUT');
});


test('every root Query field accepts a network argument', () => {
  const typeDefs = readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8');
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const queryType = schema.getQueryType();
  assert.ok(queryType);

  const missingNetwork = Object.values(queryType.getFields())
    .filter((field) => !field.args.some((arg) => arg.name === 'network'))
    .map((field) => field.name);

  assert.deepEqual(missingNetwork, []);
});

test('extended Query fields forward network: TESTNET through the executable schema', async () => {
  const typeDefs = readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8');
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const registry = resolveNetworks({
    NETWORKS: 'mainnet,testnet',
    MAINNET_HORIZON_URL: 'http://127.0.0.1:1',
    TESTNET_HORIZON_URL: 'http://127.0.0.1:1',
    PRIMARY_NETWORK: 'mainnet',
  });

  const seenNetworks: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM account_signers')) {
        seenNetworks.push(String(params[0]));
        return { rows: [{ key: 'GSIGNER', type: 'ed25519_public_key', weight: params[0] === 'testnet' ? 2 : 1 }] };
      }
      if (sql.includes('JOIN sponsorships')) {
        seenNetworks.push(String(params[1]));
        return {
          rows: [{
            address: 'GSPONSORED',
            network: params[1],
            sequence: params[1] === 'testnet' ? '22' : '11',
            subentry_count: 0,
            last_modified_ledger: 100,
            num_sponsored: 1,
            num_sponsoring: 0,
            balances: [],
            flags: {},
            thresholds: {},
          }],
        };
      }
      if (sql.includes('FROM contract_deployments')) {
        seenNetworks.push(String(params[0]));
        return {
          rows: [{
            contract_id: 'CCONTRACT',
            deployer: 'GDEPLOYER',
            wasm_hash: params[0] === 'testnet' ? 'wasm_testnet' : 'wasm_mainnet',
            deployed_ledger: 100,
            deployed_at: '2026-01-01T00:00:00Z',
          }],
        };
      }
      if (sql.includes('FROM activity_rollups')) {
        seenNetworks.push(String(params[0]));
        return {
          rows: [{
            bucket_start: '2026-01-01T00:00:00Z',
            transaction_count: params[0] === 'testnet' ? 222 : 111,
            operation_count: 10,
            active_accounts: 5,
            total_volume: '100',
          }],
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;

  const ctx = createContext(pool, { registry });

  const queries = [
    '{ accountSigners(network: TESTNET, address: "GACC") { weight } }',
    '{ sponsoredAccounts(network: TESTNET, sponsorAddress: "GSPONSOR", limit: 5) { sequence } }',
    '{ contract(network: TESTNET, contractId: "CCONTRACT") { wasmHash } }',
    '{ contracts(network: TESTNET, limit: 5) { wasmHash } }',
    '{ networkStats(network: TESTNET, startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-01T02:00:00Z") { transactionCount } }',
  ];

  const results = [];
  for (const source of queries) {
    const res = await graphql({ schema, source, contextValue: ctx });
    assert.equal(res.errors, undefined, `unexpected errors for ${source}: ${JSON.stringify(res.errors)}`);
    results.push(res.data);
  }

  assert.deepEqual(seenNetworks, ['testnet', 'testnet', 'testnet', 'testnet', 'testnet']);
  assert.equal((results[0] as any).accountSigners[0].weight, 2);
  assert.equal((results[1] as any).sponsoredAccounts[0].sequence, '22');
  assert.equal((results[2] as any).contract.wasmHash, 'wasm_testnet');
  assert.equal((results[3] as any).contracts[0].wasmHash, 'wasm_testnet');
  assert.equal((results[4] as any).networkStats[0].transactionCount, 222);
});


test('granularity uses the Granularity enum and rejects unsupported values at validation time', async () => {
  const typeDefs = readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8');
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const seenGranularities: string[] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      seenGranularities.push(String(params[1]));
      return {
        rows: [{
          bucket_start: '2026-01-01T00:00:00Z',
          granularity: params[1],
          network: 'mainnet',
          transaction_count: 10,
          operation_count: 20,
          active_accounts: 5,
          total_volume: '50',
        }],
      };
    },
  } as unknown as Pool;

  const ctx = createContext(pool);

  const invalidStats = await graphql({
    schema,
    source: '{ networkStats(startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-02T00:00:00Z", granularity: "week") { bucketStart } }',
    contextValue: ctx,
  });
  assert.ok(invalidStats.errors && invalidStats.errors.length > 0);
  assert.equal(seenGranularities.length, 0);

  const invalidRollups = await graphql({
    schema,
    source: '{ activityRollups(network: "mainnet", startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-02T00:00:00Z", granularity: WEEK) { bucketStart } }',
    contextValue: ctx,
  });
  assert.ok(invalidRollups.errors && invalidRollups.errors.length > 0);
  assert.equal(seenGranularities.length, 0);

  const validDay = await graphql({
    schema,
    source: '{ networkStats(startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-02T00:00:00Z", granularity: DAY) { bucketStart } }',
    contextValue: ctx,
  });
  assert.equal(validDay.errors, undefined);

  const validRollup = await graphql({
    schema,
    source: '{ activityRollups(network: "mainnet", startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-02T00:00:00Z", granularity: HOUR) { granularity } }',
    contextValue: ctx,
  });
  assert.equal(validRollup.errors, undefined);
  assert.equal((validRollup.data as any).activityRollups[0].granularity, 'HOUR');
  assert.deepEqual(seenGranularities, ['day', 'hour']);

  await assert.rejects(
    () => resolvers.Query.networkStats(undefined, {
      startTime: '2026-01-01T00:00:00Z',
      endTime: '2026-01-02T00:00:00Z',
      granularity: 'week',
    }, ctx),
    /Unsupported granularity/i
  );
});


test('sponsoredAccountsPage paginates with opaque cursors and validates limit and cursor', async () => {
  const typeDefs = readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8');
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const allAccounts = ['GA_FIRST', 'GB_SECOND', 'GC_THIRD'].map((address) => ({
    address,
    network: 'mainnet',
    sequence: '1',
    subentry_count: 0,
    last_modified_ledger: 100,
    num_sponsored: 1,
    num_sponsoring: 0,
    balances: [],
    flags: {},
    thresholds: {},
  }));

  const pool = {
    query: async (sql: string, params: unknown[]) => {
      const hasCursor = sql.includes('(a.address) >');
      const after = hasCursor ? String(params[2]) : null;
      const limit = Number(params.at(-1));
      const filtered = after ? allAccounts.filter((a) => a.address > after) : allAccounts;
      return { rows: filtered.slice(0, limit) };
    },
  } as unknown as Pool;

  const ctx = createContext(pool);

  const page1 = await graphql({
    schema,
    source: '{ sponsoredAccountsPage(sponsorAddress: "GSPONSOR", limit: 2) { items { address } pageInfo { hasNextPage hasPreviousPage cursor startCursor endCursor } } }',
    contextValue: ctx,
  });
  assert.equal(page1.errors, undefined);
  const p1 = (page1.data as any).sponsoredAccountsPage;
  assert.deepEqual(p1.items.map((a: { address: string }) => a.address), ['GA_FIRST', 'GB_SECOND']);
  assert.equal(p1.pageInfo.hasNextPage, true);
  assert.equal(p1.pageInfo.hasPreviousPage, false);
  assert.ok(p1.pageInfo.cursor);

  const page2 = await graphql({
    schema,
    source: `{ sponsoredAccountsPage(sponsorAddress: "GSPONSOR", limit: 2, cursor: "${p1.pageInfo.cursor}") { items { address } pageInfo { hasNextPage hasPreviousPage cursor } } }`,
    contextValue: ctx,
  });
  assert.equal(page2.errors, undefined);
  const p2 = (page2.data as any).sponsoredAccountsPage;
  assert.deepEqual(p2.items.map((a: { address: string }) => a.address), ['GC_THIRD']);
  assert.equal(p2.pageInfo.hasNextPage, false);
  assert.equal(p2.pageInfo.hasPreviousPage, true);

  const tooLarge = await graphql({
    schema,
    source: '{ sponsoredAccountsPage(sponsorAddress: "GSPONSOR", limit: 101) { items { address } } }',
    contextValue: ctx,
  });
  assert.equal(tooLarge.errors?.[0]?.extensions.code, 'BAD_USER_INPUT');

  const badCursor = await graphql({
    schema,
    source: '{ sponsoredAccountsPage(sponsorAddress: "GSPONSOR", cursor: "not-a-valid-cursor") { items { address } } }',
    contextValue: ctx,
  });
  assert.equal(badCursor.errors?.[0]?.extensions.code, 'INVALID_CURSOR');
});
