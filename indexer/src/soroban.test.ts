import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { nativeToScVal, StrKey, xdr } from '@stellar/stellar-sdk';
import {
  getContractStorageEntries,
  getEvents,
  getLatestLedgerSequence,
  getLedgerEntries,
  parseLedgerKey,
  GET_LEDGER_ENTRIES_MAX_KEYS,
} from './soroban';
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

// ── Contract storage entries ───────────────────────────────────────────────

// Fixtures are built with the SDK's own XDR writers and round-tripped back
// through the parser, so decoding is exercised against the real wire format
// rather than a hand-written string that only happens to parse.
//
// The SDK types the contract address as `Hash`, which is an opaque alias it
// does not let you construct; at runtime it is the decoded Buffer, so that is
// what these helpers pass.
// The SDK types the contract address as `Hash` (an opaque alias with no public
// constructor) while accepting the decoded Buffer at runtime, so the cast is
// confined to this one helper rather than cast at each call site.
type ContractHash = Parameters<typeof xdr.ScAddress.scAddressTypeContract>[0];

function contractScAddress(): { address: xdr.ScAddress; contractId: string } {
  const contractId = StrKey.encodeContract(randomBytes(32));
  return {
    address: xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(contractId) as unknown as ContractHash),
    contractId,
  };
}

function storageKeyXdr(durability: 'persistent' | 'temporary', symbol: string): { xdr: string; contractId: string } {
  const { address, contractId } = contractScAddress();
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: address,
    key: xdr.ScVal.scvSymbol(symbol),
    durability: xdr.ContractDataDurability[durability](),
  }));
  return { xdr: key.toXDR('base64'), contractId };
}

function storageEntryXdr(valueXdr: string): string {
  const { address } = contractScAddress();
  return xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({
    contract: address,
    key: xdr.ScVal.scvSymbol('k'),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.fromXDR(valueXdr, 'base64'),
    ext: new xdr.ExtensionPoint(0),
  })).toXDR('base64');
}

const COUNTER_VALUE_XDR = nativeToScVal(42n).toXDR('base64');

test('parseLedgerKey decodes the contract id and durability from a real LedgerKey', () => {
  const { xdr: persistentXdr, contractId } = storageKeyXdr('persistent', 'counter');
  assert.deepEqual(parseLedgerKey(persistentXdr), { contractId, durability: 'persistent' });

  const { xdr: temporaryXdr, contractId: temporaryContract } = storageKeyXdr('temporary', 'scratch');
  assert.deepEqual(parseLedgerKey(temporaryXdr), { contractId: temporaryContract, durability: 'temporary' });
});

test('parseLedgerKey refuses a key that does not address contract data', () => {
  // A non-contractData key cannot be filtered or fetched back as storage, so it
  // is an error rather than a row with a meaningless contract and durability.
  const configKey = xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({
    configSettingId: xdr.ConfigSettingId.configSettingContractMaxSizeBytes(),
  })).toXDR('base64');

  assert.throws(() => parseLedgerKey(configKey), /non-contract-data ledger key \(configSetting\)/);
});

test('getContractStorageEntries returns the decoded value, raw XDR and last-changed ledger', async () => {
  const { xdr: keyXdr, contractId } = storageKeyXdr('persistent', 'counter');
  const counterValue = nativeToScVal(42n);
  const valueXdr = storageEntryXdr(counterValue.toXDR('base64'));

  mockFetchOnce({
    jsonrpc: '2.0',
    id: 1,
    result: {
      entries: [{ key: keyXdr, xdr: valueXdr, lastModifiedLedgerSeq: 500, liveUntilLedgerSeq: 900 }],
      latestLedger: 501,
    },
  });

  const { entries, latestLedger } = await getContractStorageEntries('https://rpc.example.com', [keyXdr]);
  assert.equal(latestLedger, 501);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry?.contractId, contractId);
  assert.equal(entry?.key, keyXdr);
  assert.equal(entry?.durability, 'persistent');
  // The value comes back decoded, and the raw XDR is preserved alongside it so
  // a consumer has both forms.
  assert.equal(entry?.value, 42n);
  assert.equal(entry?.valueXdr, valueXdr);
  assert.equal(entry?.lastModifiedLedgerSeq, 500);
  assert.equal(entry?.liveUntilLedgerSeq, 900);
});

test('getContractStorageEntries reports no TTL when the RPC omits liveUntilLedgerSeq', async () => {
  const { xdr: keyXdr } = storageKeyXdr('persistent', 'counter');
  mockFetchOnce({
    jsonrpc: '2.0',
    id: 1,
    result: {
      entries: [{ key: keyXdr, xdr: storageEntryXdr(COUNTER_VALUE_XDR), lastModifiedLedgerSeq: 7 }],
      latestLedger: 7,
    },
  });

  const { entries } = await getContractStorageEntries('https://rpc.example.com', [keyXdr]);
  assert.equal(entries[0]?.liveUntilLedgerSeq, null);
});

test('a key the RPC omits is absent from the result, not reported as archived', async () => {
  // Archival is the indexer's inference (a key it previously saw stop coming
  // back); the RPC itself just says nothing. Reporting it as archived here
  // would let a transient omission look like a TTL expiry.
  const { xdr: keyXdr } = storageKeyXdr('persistent', 'counter');
  mockFetchOnce({ jsonrpc: '2.0', id: 1, result: { entries: [], latestLedger: 900 } });

  const { entries, latestLedger } = await getContractStorageEntries('https://rpc.example.com', [keyXdr]);
  assert.deepEqual(entries, []);
  assert.equal(latestLedger, 900);
});

test('a large token amount decodes to a bigint rather than a rounded float', async () => {
  // i128 does not fit a JSON number; the decoded value must stay exact so the
  // indexer can store it as canonical decimal text.
  const { xdr: keyXdr } = storageKeyXdr('persistent', 'balance');
  const huge = nativeToScVal(1208925819614629174706176n).toXDR('base64');
  mockFetchOnce({
    jsonrpc: '2.0',
    id: 1,
    result: { entries: [{ key: keyXdr, xdr: storageEntryXdr(huge), lastModifiedLedgerSeq: 1 }], latestLedger: 1 },
  });

  const { entries } = await getContractStorageEntries('https://rpc.example.com', [keyXdr]);
  assert.equal(entries[0]?.value, 1208925819614629174706176n);
});
