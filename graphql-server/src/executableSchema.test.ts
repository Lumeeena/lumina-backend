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
