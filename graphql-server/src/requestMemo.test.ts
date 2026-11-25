import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSerialize, memoizeRequestQuery } from './requestMemo';

test('canonicalSerialize ignores object key order but keeps array order', () => {
  const written = canonicalSerialize({ b: 1, a: { d: 2, c: [1, null] } });
  const reordered = canonicalSerialize({ a: { c: [1, null], d: 2 }, b: 1 });

  assert.equal(written, reordered);
  assert.equal(written, '{"a":{"c":[1,null],"d":2},"b":1}');
  assert.notEqual(canonicalSerialize([1, 2]), canonicalSerialize([2, 1]));
});

test('canonicalSerialize keeps the string "null" distinct from the null value', () => {
  assert.equal(canonicalSerialize(null), 'null');
  assert.equal(canonicalSerialize('null'), '"null"');
  assert.notEqual(canonicalSerialize(null), canonicalSerialize('null'));
});

test('identical lookups in one request share one execution and the same promise', async () => {
  const memo = new Map<string, Promise<unknown>>();
  let calls = 0;
  const execute = async () => {
    calls++;
    return 'ledger 42';
  };

  const first = memoizeRequestQuery(memo, 'latestLedger', { network: 'MAINNET' }, execute);
  const second = memoizeRequestQuery(memo, 'latestLedger', { network: 'MAINNET' }, execute);

  // Two panels asking at once get the same in-flight promise, not a second query.
  assert.equal(second, first);
  assert.equal(await first, 'ledger 42');
  assert.equal(await second, 'ledger 42');
  assert.equal(calls, 1);
});

test('argument key order does not create a second execution', async () => {
  const memo = new Map<string, Promise<unknown>>();
  let calls = 0;
  const execute = async () => {
    calls++;
    return calls;
  };

  await memoizeRequestQuery(memo, 'transactions', { first: 10, network: 'TESTNET' }, execute);
  await memoizeRequestQuery(memo, 'transactions', { network: 'TESTNET', first: 10 }, execute);

  assert.equal(calls, 1);
});

test('different arguments or a different query name are never served from one another', async () => {
  const memo = new Map<string, Promise<unknown>>();
  let calls = 0;
  const execute = async () => {
    calls++;
    return calls;
  };

  await memoizeRequestQuery(memo, 'transactions', { network: 'MAINNET' }, execute);
  await memoizeRequestQuery(memo, 'transactions', { network: 'TESTNET' }, execute);
  await memoizeRequestQuery(memo, 'operations', { network: 'MAINNET' }, execute);

  assert.equal(calls, 3);
});

test('without a memo map, every call executes', async () => {
  let calls = 0;
  const execute = async () => {
    calls++;
    return calls;
  };

  await memoizeRequestQuery(undefined, 'latestLedger', {}, execute);
  await memoizeRequestQuery(undefined, 'latestLedger', {}, execute);

  assert.equal(calls, 2);
});

test('a failed lookup fails the same way for the rest of the request, without a retry', async () => {
  const memo = new Map<string, Promise<unknown>>();
  let calls = 0;
  const execute = async () => {
    calls++;
    throw new Error('statement timeout');
  };

  const first = memoizeRequestQuery(memo, 'search', { q: 'x' }, execute);
  const second = memoizeRequestQuery(memo, 'search', { q: 'x' }, execute);

  await assert.rejects(first, /statement timeout/);
  await assert.rejects(second, /statement timeout/);
  assert.equal(calls, 1);
});
