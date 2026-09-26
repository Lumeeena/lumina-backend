import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEvents, getLatestLedgerSequence, getLedgerEntries, GET_LEDGER_ENTRIES_MAX_KEYS, GET_EVENTS_MAX_CONTRACT_IDS } from './soroban';
import { registry } from './metrics';

// Real XDR fixtures: ScSymbol("swap") and ScMap({ amount: "1000" }), generated via
// @stellar/stellar-sdk's nativeToScVal so decoding is exercised against real wire format.
const SWAP_TOPIC_XDR = 'AAAADwAAAARzd2Fw';
const AMOUNT_VALUE_XDR = 'AAAAEQAAAAEAAAABAAAADgAAAAZhbW91bnQAAAAAAA4AAAAEMTAwMA==';

function mockFetchOnce(body: unknown, ok = true) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  })) as unknown as typeof fetch;
}

test('getEvents returns latestLedger=startLedger without making a request when no contract IDs are given', async () => {
  let called = false;
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => {
    called = true;
    throw new Error('should not be called');
  }) as unknown as typeof fetch;
  const result = await getEvents('https://rpc.example.com', [], 100, 5000);
  assert.deepEqual(result, { events: [], latestLedger: 100, truncated: false });
  assert.equal(called, false);
});

test('getEvents decodes ScVal topics and values from a real RPC response shape', async () => {
  mockFetchOnce({
    jsonrpc: '2.0',
    id: 1,
    result: {
      latestLedger: 105,
      events: [
        {
          type: 'contract',
          ledger: 100,
          ledgerClosedAt: '2026-01-01T00:00:00Z',
          contractId: 'CABC',
          id: 'evt1',
          pagingToken: 'token1',
          topic: [SWAP_TOPIC_XDR],
          value: AMOUNT_VALUE_XDR,
        },
      ],
    },
  });

  const { events, latestLedger } = await getEvents('https://rpc.example.com', ['CABC'], 100, 5000);
  assert.equal(latestLedger, 105);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'evt1');
  assert.equal(events[0].contractId, 'CABC');
  assert.equal(events[0].ledger, 100);
  assert.deepEqual(events[0].topics, ['"swap"']);
  assert.deepEqual(events[0].value, { amount: '1000' });
});

test('getEvents returns [] events (but a real latestLedger) when the RPC result has none', async () => {
  mockFetchOnce({ jsonrpc: '2.0', id: 1, result: { latestLedger: 105 } });
  const { events, latestLedger } = await getEvents('https://rpc.example.com', ['CABC'], 100, 5000);
  assert.deepEqual(events, []);
  assert.equal(latestLedger, 105);
});

test('getEvents throws on a JSON-RPC error response', async () => {
  mockFetchOnce({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'start ledger too old' } });
  await assert.rejects(() => getEvents('https://rpc.example.com', ['CABC'], 100, 5000), /start ledger too old/);
});

test('getEvents throws on a non-OK HTTP response', async () => {
  mockFetchOnce({}, false);
  await assert.rejects(() => getEvents('https://rpc.example.com', ['CABC'], 100, 5000));
});

test('getLatestLedgerSequence returns the sequence from a real getLatestLedger response shape', async () => {
  mockFetchOnce({
    jsonrpc: '2.0',
    id: 1,
    result: { id: 'abc123', protocolVersion: 27, sequence: 4081327 },
  });
  const sequence = await getLatestLedgerSequence('https://rpc.example.com');
  assert.equal(sequence, 4081327);
});

test('getLedgerEntries chunks requests to the RPC key limit and aggregates results', async () => {
  const requests: string[][] = [];
  (global as unknown as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request.params.keys);
    return {
      ok: true,
      json: async () => ({ result: {
        entries: request.params.keys.map((key: string) => ({ key, xdr: `value:${key}`, lastModifiedLedgerSeq: 12 })),
        latestLedger: requests.length === 1 ? 10 : 13,
      } }),
    } as Response;
  }) as typeof fetch;
  const keys = Array.from({ length: GET_LEDGER_ENTRIES_MAX_KEYS + 1 }, (_, index) => `key-${index}`);
  const result = await getLedgerEntries('https://rpc.example.com', keys);
  assert.deepEqual(requests.map(batch => batch.length), [GET_LEDGER_ENTRIES_MAX_KEYS, 1]);
  assert.deepEqual(result.entries.map(entry => entry.key), keys);
  assert.equal(result.latestLedger, 13);
  const metric = await registry.getSingleMetric('lumina_soroban_requests_total')?.get();
  assert.ok(metric?.values.some(value => value.labels['method'] === 'getLedgerEntries' && value.value >= 2));
});

test('getLedgerEntries makes no RPC calls for an empty key list', async () => {
  let called = false;
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => { called = true; throw new Error('unexpected RPC'); }) as typeof fetch;
  assert.deepEqual(await getLedgerEntries('https://rpc.example.com', []), { entries: [], latestLedger: 0 });
  assert.equal(called, false);
});

test('getEvents splits a long contract id list across calls of GET_EVENTS_MAX_CONTRACT_IDS and dedupes', async () => {
  const seen: string[][] = [];
  (global as unknown as { fetch: typeof fetch }).fetch = (async (_u: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    seen.push(body.params.filters[0].contractIds);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { latestLedger: 200 } }) };
  }) as unknown as typeof fetch;
  const ids = Array.from({ length: 12 }, (_, i) => `C${i}`);
  const { latestLedger } = await getEvents('https://rpc.example.com', [...ids, ...ids], 100, 5000);
  assert.equal(latestLedger, 200);
  assert.deepEqual(seen.map(c => c.length), [5, 5, 2]);
  assert.deepEqual(seen.flat(), ids);
  assert.ok(seen.every(c => c.length <= GET_EVENTS_MAX_CONTRACT_IDS));
});
