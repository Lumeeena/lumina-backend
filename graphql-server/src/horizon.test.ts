import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAccount, getRecentTransactions } from './horizon';

function mockFetchSequence(responses: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>) {
  let call = 0;
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => {
    const res = responses[call++];
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: { get: (name: string) => res.headers?.[name] ?? null },
      json: async () => res.body ?? {},
    };
  }) as unknown as typeof fetch;
}

test('getAccount returns null immediately on 404, without retrying', async () => {
  let calls = 0;
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => {
    calls++;
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  }) as unknown as typeof fetch;
  const result = await getAccount('GABC');
  assert.equal(result, null);
  assert.equal(calls, 1);
});

test('getAccount retries on 429 and succeeds once the rate limit clears', async () => {
  mockFetchSequence([
    { status: 429, headers: { 'Retry-After': '0' } },
    { status: 200, body: { account_id: 'GABC', sequence: '1' } },
  ]);
  const result = await getAccount('GABC');
  assert.deepEqual(result, { account_id: 'GABC', sequence: '1' });
});

test('getAccount gives up and returns null after exhausting retries on repeated 429s', async () => {
  mockFetchSequence([
    { status: 429, headers: { 'Retry-After': '0' } },
    { status: 429, headers: { 'Retry-After': '0' } },
    { status: 429, headers: { 'Retry-After': '0' } },
  ]);
  const result = await getAccount('GABC');
  assert.equal(result, null);
});

test('a per-network base URL routes the request to that Horizon, not the default', async () => {
  // Falling back to the default host for another network would serve the wrong
  // chain under the requested label, so the URL of the request is what is pinned.
  const requested: string[] = [];
  (global as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    requested.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ account_id: 'GABC' }) };
  }) as unknown as typeof fetch;

  await getAccount('GABC', 'https://horizon-testnet.example');

  assert.equal(requested.length, 1);
  assert.ok(requested[0].startsWith('https://horizon-testnet.example'), requested[0]);
  assert.ok(!requested[0].includes('horizon.stellar.org'), requested[0]);
});

test('requests are spaced by the throttle, so the fallback cannot burst Horizon', async () => {
  const times: number[] = [];
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => {
    times.push(Date.now());
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ _embedded: { records: [] } }),
    };
  }) as unknown as typeof fetch;

  await getRecentTransactions();
  await getRecentTransactions();
  await getRecentTransactions();

  assert.equal(times.length, 3);
  assert.ok(
    times[1] - times[0] >= 80,
    `expected requests to be at least 80ms apart, got ${times[1] - times[0]}ms`
  );
  assert.ok(
    times[2] - times[1] >= 80,
    `expected requests to be at least 80ms apart, got ${times[2] - times[1]}ms`
  );
});
