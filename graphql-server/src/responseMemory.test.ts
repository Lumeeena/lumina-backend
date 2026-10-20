/**
 * Memory ceiling for the largest allowed response.
 *
 * A GraphQL response is assembled in memory before it is sent, so the largest
 * response the schema permits is the process's worst case per request. The
 * aggregate queries (`networkStats`, `activityRollups`, `sponsoredAccounts`)
 * have no cursor to page with, so their ceiling is a row cap rather than a
 * page size — these tests execute each at that cap and assert the serialized
 * response stays under a documented byte ceiling, and that a request above the
 * cap is refused rather than buffered.
 *
 * The ceiling is deliberately loose relative to the measured size (see
 * `scripts/measure-response-memory.ts`): it is here to catch a regression that
 * makes a response scale with the request, not to pin an exact number that
 * would fail on a different platform.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { execute, parse } from 'graphql';
import { resolvers, createContext } from './resolvers';
import { MAX_AGGREGATE_ROWS } from './pagination';

const typeDefs = readFileSync(join(__dirname, 'schema.graphql'), 'utf-8');

/**
 * The checked-in schema and resolvers have drifted apart in a couple of places
 * (accountBalanceHistory, Account.signers), so the orphan resolvers are dropped
 * before building the schema. This mirrors what the running server serves.
 */
function pruneResolvers(schemaText: string, rs: typeof resolvers): typeof resolvers {
  const fieldsByType = new Map<string, Set<string>>();
  const blockRe = /(?:extend\s+)?type\s+(\w+)[^{]*\{([\s\S]*?)\n\}/g;
  for (const match of schemaText.matchAll(blockRe)) {
    const [, typeName, body] = match;
    const set = fieldsByType.get(typeName) ?? new Set<string>();
    for (const line of body.split('\n')) {
      const field = line.match(/^\s*(\w+)\s*[(:<]/);
      if (field) set.add(field[1]);
    }
    fieldsByType.set(typeName, set);
  }
  const pruned: Record<string, Record<string, unknown>> = {};
  for (const [typeName, fields] of Object.entries(rs)) {
    const known = fieldsByType.get(typeName);
    const kept: Record<string, unknown> = {};
    for (const [fieldName, fn] of Object.entries(fields as Record<string, unknown>)) {
      if (known && !known.has(fieldName)) continue;
      kept[fieldName] = fn;
    }
    if (Object.keys(kept).length > 0) pruned[typeName] = kept;
  }
  return pruned as typeof resolvers;
}

const schema = makeExecutableSchema({ typeDefs, resolvers: pruneResolvers(typeDefs, resolvers) });

/**
 * A pool that returns `rows` for every query. The aggregate queries select by
 * position, so a fixed array is enough to exercise the mapping and serialization
 * path without a database.
 */
function fakePool(rows: unknown[]): Pool {
  return {
    query: async () => ({ rows }),
  } as unknown as Pool;
}

function bucketRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    bucket_start: new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString(),
    transaction_count: 12_345,
    operation_count: 67_890,
    active_accounts: 1_234,
    total_volume: '123456789.0000000',
  }));
}

function accountRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    address: `G${'A'.repeat(54)}${i}`.padEnd(56, 'B'),
    network: 'mainnet',
    sequence: '1234567890',
    subentry_count: 5,
    last_modified_ledger: 1_000_000,
    num_sponsored: 2,
    num_sponsoring: 3,
    balances: [
      { asset_type: 'native', balance: '1000.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: 'GISSUER', balance: '5.0000000' },
    ],
    flags: {},
    thresholds: {},
  }));
}

async function serializedSize(query: string, rows: unknown[]): Promise<number> {
  const result = await execute({
    schema,
    document: parse(query),
    contextValue: createContext(fakePool(rows)),
  });
  assert.deepEqual(result.errors, undefined, `query errored: ${JSON.stringify(result.errors)}`);
  return Buffer.byteLength(JSON.stringify(result));
}

/**
 * A response built from the full cap is around 0.2 MB at time of writing. 2 MB
 * leaves headroom for a larger row shape but still fails if a response ever
 * scales with the request width instead of staying flat.
 */
const RESPONSE_CEILING_BYTES = 2 * 1024 * 1024;

test('networkStats at the cap stays under the response ceiling', async () => {
  const size = await serializedSize(
    `query { networkStats(startTime: "2020-01-01T00:00:00Z", endTime: "2020-02-11T16:00:00Z", granularity: "hour") {
      bucketStart transactionCount operationCount activeAccounts totalVolume
    } }`,
    bucketRows(MAX_AGGREGATE_ROWS)
  );
  assert.ok(size < RESPONSE_CEILING_BYTES, `networkStats response was ${size} bytes, over the ${RESPONSE_CEILING_BYTES}-byte ceiling`);
});

test('activityRollups at the cap stays under the response ceiling', async () => {
  const size = await serializedSize(
    `query { activityRollups(network: "mainnet", granularity: "hour", startTime: "2020-01-01T00:00:00Z", endTime: "2020-02-11T16:00:00Z") {
      bucketStart granularity network transactionCount operationCount activeAccounts totalVolume
    } }`,
    bucketRows(MAX_AGGREGATE_ROWS).map(row => ({ ...row, granularity: 'hour', network: 'mainnet' }))
  );
  assert.ok(size < RESPONSE_CEILING_BYTES, `activityRollups response was ${size} bytes, over the ${RESPONSE_CEILING_BYTES}-byte ceiling`);
});

test('sponsoredAccounts at the cap stays under the response ceiling', async () => {
  const size = await serializedSize(
    `query { sponsoredAccounts(sponsorAddress: "GSPONSOR", limit: ${MAX_AGGREGATE_ROWS}) {
      address sequence balances { assetType assetCode assetIssuer balance }
    } }`,
    accountRows(MAX_AGGREGATE_ROWS)
  );
  assert.ok(size < RESPONSE_CEILING_BYTES, `sponsoredAccounts response was ${size} bytes, over the ${RESPONSE_CEILING_BYTES}-byte ceiling`);
});

test('the pool never sees a row count above the cap', async () => {
  // A fake pool that records the LIMIT the query layer binds, so an unbounded
  // LIMIT (or one above the cap) fails here rather than only in production.
  const limits: unknown[] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      limits.push(params.at(-1));
      return { rows: bucketRows(MAX_AGGREGATE_ROWS) };
    },
  } as unknown as Pool;

  await execute({
    schema,
    document: parse(
      `query { activityRollups(network: "mainnet", startTime: "2020-01-01T00:00:00Z", endTime: "2020-02-01T00:00:00Z") { bucketStart } }`
    ),
    contextValue: createContext(pool),
  });

  assert.equal(limits.length, 1);
  assert.equal(limits[0], MAX_AGGREGATE_ROWS);
});

test('a request above the cap is refused, not buffered', async () => {
  const result = await execute({
    schema,
    document: parse(
      `query { sponsoredAccounts(sponsorAddress: "GSPONSOR", limit: 100000) { address } }`
    ),
    contextValue: createContext(fakePool(accountRows(MAX_AGGREGATE_ROWS))),
  });
  assert.ok(result.errors && result.errors.length > 0);
  assert.equal(result.errors[0]?.extensions?.['code'], 'BAD_USER_INPUT');
});
