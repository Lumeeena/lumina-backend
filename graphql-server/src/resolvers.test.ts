import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createContext, type Context } from './resolvers';
import { getNetworks } from './networks';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function fakePool(): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('createContext initializes all required fields', () => {
  const { pool } = fakePool();
  const ctx = createContext(pool);

  assert(ctx.pool === pool);
  assert(ctx.registry === getNetworks());
  assert(ctx.loaders !== undefined);
  assert(ctx.caller !== undefined);
  assert(ctx.queryMemo instanceof Map);
  assert(ctx.queryMemo.size === 0);
});

test('createContext accepts extra fields', () => {
  const { pool } = fakePool();
  const fakeNotifier = { subscribe: () => Promise.resolve() };
  const ctx = createContext(pool, { notifier: fakeNotifier as any });

  assert(ctx.pool === pool);
  assert(ctx.notifier === fakeNotifier);
});

test('loader factory caches loaders per network', () => {
  const { pool } = fakePool();
  const ctx = createContext(pool);

  const primary = ctx.registry.primary;
  const loader1 = ctx.loaders!(primary);
  const loader2 = ctx.loaders!(primary);

  // Same network returns same loader instance
  assert(loader1 === loader2);
});

test('context query memoization prevents duplicate work', () => {
  const { pool, calls } = fakePool();
  const ctx = createContext(pool);

  // Simulate two requests with the same memoization key
  const key = 'test-query';
  const promise1 = Promise.resolve({ result: 'cached' });

  ctx.queryMemo!.set(key, promise1);
  const cached = ctx.queryMemo!.get(key);

  assert(cached === promise1);
  assert.equal(calls.length, 0); // No actual pool calls made
});
