import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import type { Pool } from 'pg';
import { createContext, resolvers } from './resolvers';

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
