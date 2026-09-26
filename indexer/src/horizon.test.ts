import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLatestLedgerSequence, getLedger, getLedgerTransactions, PAGE_LIMIT } from './horizon';
// @ts-expect-error - JSON file imports are enabled at runtime for this test fixture.
import fixtures from './__fixtures__/horizon.json' assert { type: 'json' };

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  let call = 0;
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => {
    const res = responses[call++];
    return {
      ok: res.ok,
      status: res.status ?? 200,
      json: async () => res.body,
    };
  }) as unknown as typeof fetch;
}

test('getLatestLedgerSequence parses recorded Horizon response shape', async () => {
  mockFetchSequence([{ ok: true, body: fixtures.ledgerPage }]);
  const seq = await getLatestLedgerSequence('https://horizon.example.com');
  assert.equal(seq, 52481234);
});

test('getLatestLedgerSequence returns 0 when there are no records', async () => {
  mockFetchSequence([{ ok: true, body: { _embedded: { records: [] } } }]);
  const seq = await getLatestLedgerSequence('https://horizon.example.com');
  assert.equal(seq, 0);
});

test('getLedger parses recorded Horizon response shape', async () => {
  mockFetchSequence([{ ok: true, body: fixtures.ledger }]);
  const ledger = await getLedger('https://horizon.example.com', 52481234);
  assert.equal(ledger.sequence, 52481234);
  assert.equal(ledger.base_fee_in_stroops, 100);
  assert.equal(ledger.successful_transaction_count, 25);
});

test('getLedger throws on a non-OK response', async () => {
  mockFetchSequence([{ ok: false, status: 404, body: {} }]);
  await assert.rejects(() => getLedger('https://horizon.example.com', 999));
});

test('getLedgerTransactions parses recorded Horizon response shape with pagination', async () => {
  const fullPage = Array.from({ length: PAGE_LIMIT }, (_, i) => ({
    ...fixtures.transaction,
    hash: `tx-${i}`,
  }));
  mockFetchSequence([
    { ok: true, body: { _embedded: { records: fullPage }, _links: { next: { href: 'page2' } } } },
    { ok: true, body: { _embedded: { records: [fixtures.transaction] }, _links: {} } },
  ]);
  const txs = await getLedgerTransactions('https://horizon.example.com', 100);
  assert.equal(txs.length, PAGE_LIMIT + 1);
  assert.equal(txs.at(-1)?.hash, fixtures.transaction.hash);
  assert.equal(txs[0].memo, 'hello world');
});

test('getLedgerTransactions stops after a single short page with no next link', async () => {
  mockFetchSequence([
    { ok: true, body: { _embedded: { records: [fixtures.transaction] }, _links: {} } },
  ]);
  const txs = await getLedgerTransactions('https://horizon.example.com', 100);
  assert.equal(txs.length, 1);
});
