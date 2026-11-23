import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createContext, resolvers } from './resolvers';
import { ANONYMOUS_CALLER, type ApiCaller } from './auth';

function createMockPool(): Pool {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    on: () => {},
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {}, on: () => {} }),
  } as unknown as Pool;
}

test('createContext initializes context with pool, default anonymous caller, and queryMemo', () => {
  const pool = createMockPool();
  const ctx = createContext(pool);

  assert.equal(ctx.pool, pool);
  assert.deepEqual(ctx.caller, ANONYMOUS_CALLER);
  assert.ok(ctx.registry, 'registry should be initialized');
  assert.ok(ctx.registry.primary, 'primary network should be defined');
  assert.ok(ctx.queryMemo instanceof Map, 'queryMemo should be an instantiated Map');
  assert.equal(typeof ctx.loaders, 'function', 'loaders factory should be a function');
});

test('createContext accepts extra overrides', () => {
  const pool = createMockPool();
  const customCaller: ApiCaller = {
    kind: 'api-key',
    keyId: 101,
    label: 'ci-test-key',
    rateLimit: 1000,
  };
  const customMemo = new Map<string, Promise<unknown>>();

  const ctx = createContext(pool, {
    caller: customCaller,
    queryMemo: customMemo,
  });

  assert.deepEqual(ctx.caller, customCaller);
  assert.equal(ctx.queryMemo, customMemo);
});

test('loaders factory returns memoized loader instances per network', () => {
  const pool = createMockPool();
  const ctx = createContext(pool);

  assert.ok(ctx.loaders);
  const primaryNetwork = ctx.registry.primary;
  const loaders1 = ctx.loaders(primaryNetwork);
  const loaders2 = ctx.loaders(primaryNetwork);

  assert.equal(loaders1, loaders2, 'repeated calls with same network must return identical loader instance');
  assert.ok(loaders1.account, 'account loader should exist');
  assert.ok(loaders1.transaction, 'transaction loader should exist');
  assert.ok(loaders1.ledger, 'ledger loader should exist');
});

test('resolvers definition provides standard root fields and type resolvers', () => {
  assert.ok(resolvers.Query, 'Query root must be defined');
  assert.ok(resolvers.Subscription, 'Subscription root must be defined');
  assert.equal(typeof resolvers.Query.transactions, 'function');
  assert.equal(typeof resolvers.Query.ledgers, 'function');
  assert.equal(typeof resolvers.Query.accounts, 'function');
  assert.equal(typeof resolvers.Query.operations, 'function');
  assert.equal(typeof resolvers.Query.indexerStatus, 'function');
});

test('resolvers.Query.indexerStatus returns database status from context', async () => {
  const pool = createMockPool();
  const ctx = createContext(pool);

  const status = await resolvers.Query.indexerStatus(undefined, {}, ctx);
  assert.ok(status, 'indexerStatus should resolve');
  assert.equal(typeof status.stale, 'boolean');
});
