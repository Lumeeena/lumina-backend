import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  getContractStorageEntries,
  getContractStorageKeyHistory,
  mapContractStorageEntry,
  mapContractStorageKeyHistoryEntry,
} from './db';

const CONTRACT = 'CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ';
const KEY_A = 'AAAAZAAAAGQAAAA==';
const KEY_B = 'AAAAZAAAAGgAAAA==';

/** A row as `pg` returns it: BIGINTs are strings, JSONB already parsed. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    contract_id: CONTRACT,
    network: 'mainnet',
    key: KEY_A,
    durability: 'persistent',
    state: 'active',
    value: { count: 42n.toString() },
    value_xdr: 'AAAAEQAAAAE',
    live_until_ledger: '52482000',
    last_modified_ledger: '52481234',
    ...overrides,
  };
}

function fakePool(rows: unknown[]): { pool: Pool; queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, queries };
}

// ── Mapping ────────────────────────────────────────────────────────────────

test('an active entry exposes decoded value, raw XDR and last-changed ledger', () => {
  const result = mapContractStorageEntry(row());
  assert.equal(result.key, KEY_A);
  assert.equal(result.durability, 'PERSISTENT');
  assert.equal(result.state, 'ACTIVE');
  assert.equal(result.value, '{"count":"42"}');
  assert.equal(result.valueXdr, 'AAAAEQAAAAE');
  assert.equal(result.lastModifiedLedger, 52481234);
  assert.equal(result.liveUntilLedger, 52482000);
});

test('an archived entry reports ARCHIVED and no value, rather than a stale one', () => {
  // The archived case is the whole point of the state field: the row survives,
  // but the value is null so a stale read is never presented as current, and a
  // client can tell this apart from a key that was never set (no row at all).
  const result = mapContractStorageEntry(row({ state: 'archived' }));
  assert.equal(result.state, 'ARCHIVED');
  assert.equal(result.value, null);
  assert.equal(result.valueXdr, null);
  // Metadata survives: this is a marked entry, not a deleted one.
  assert.equal(result.key, KEY_A);
  assert.equal(result.lastModifiedLedger, 52481234);
});

test('an entry the RPC reported no TTL for has a null liveUntilLedger', () => {
  const result = mapContractStorageEntry(row({ live_until_ledger: null }));
  assert.equal(result.liveUntilLedger, null);
});

test('an unknown durability or state fails loudly rather than reaching the client', () => {
  assert.throws(() => mapContractStorageEntry(row({ durability: 'volatile' })), /unknown contract storage durability/);
  assert.throws(() => mapContractStorageEntry(row({ state: 'restored' })), /unknown contract storage state/);
});

test('history entries map JSON values, BIGINT ledgers and timestamps', () => {
  assert.deepEqual(mapContractStorageKeyHistoryEntry({
    value: { count: '42' },
    last_modified_ledger: '52481234',
    indexed_at: new Date('2026-05-06T10:22:14Z'),
  }), {
    value: '{"count":"42"}',
    ledger: 52481234,
    createdAt: '2026-05-06T10:22:14.000Z',
  });
});

// ── Query shape ────────────────────────────────────────────────────────────

test('the base query filters by contract and network and orders by the cursor keyset', async () => {
  const { pool, queries } = fakePool([row()]);
  await getContractStorageEntries(pool, { network: 'mainnet', contractId: CONTRACT, limit: 20 });

  const [query] = queries;
  assert.ok(query);
  assert.match(query.sql, /contract_id = \$1/);
  assert.match(query.sql, /network = \$2/);
  assert.match(query.sql, /ORDER BY last_modified_ledger DESC, key DESC/);
  assert.deepEqual(query.params, [CONTRACT, 'mainnet', 20]);
});

test('a durability filter is bound as a parameter and lowercased', async () => {
  const { pool, queries } = fakePool([row()]);
  await getContractStorageEntries(pool, {
    network: 'mainnet',
    contractId: CONTRACT,
    durability: 'PERSISTENT',
    limit: 20,
  });

  const [query] = queries;
  assert.ok(query);
  assert.match(query.sql, /durability = \$3/);
  // The schema enum is upper case, the column is lower case.
  assert.equal(query.params[2], 'persistent');
});

test('storage key history is scoped by network, contract and key and pages newest first', async () => {
  const { pool, queries } = fakePool([{
    value: { version: 2 }, last_modified_ledger: '200', indexed_at: new Date('2026-05-06T10:22:14Z'),
  }]);
  const items = await getContractStorageKeyHistory(pool, {
    network: 'testnet', contractId: CONTRACT, key: KEY_A, limit: 10, cursor: '300',
  });

  assert.equal(items[0]?.ledger, 200);
  assert.match(queries[0]!.sql, /FROM contract_storage_history/);
  assert.match(queries[0]!.sql, /network = \$1 AND contract_id = \$2 AND key = \$3/);
  assert.match(queries[0]!.sql, /last_modified_ledger < \$4::bigint/);
  assert.match(queries[0]!.sql, /ORDER BY last_modified_ledger DESC/);
  assert.deepEqual(queries[0]!.params, ['testnet', CONTRACT, KEY_A, '300', 10]);
});

test('storage key history rejects malformed ledger cursors', async () => {
  const { pool } = fakePool([]);
  await assert.rejects(
    () => getContractStorageKeyHistory(pool, {
      network: 'mainnet', contractId: CONTRACT, key: KEY_A, limit: 10, cursor: 'not-a-ledger',
    }),
    /Invalid cursor: contract storage history cursor/
  );
});

test('a key prefix filter is a literal prefix match, not a wildcard', async () => {
  const { pool, queries } = fakePool([row()]);
  await getContractStorageEntries(pool, {
    network: 'mainnet',
    contractId: CONTRACT,
    keyPrefix: 'AAAAZ',
    limit: 20,
  });

  const [query] = queries;
  assert.ok(query);
  assert.match(query.sql, /key LIKE \$3 ESCAPE/);
  assert.equal(query.params[2], 'AAAAZ%');
});

test('LIKE metacharacters in a key prefix are escaped, not treated as wildcards', async () => {
  // key is base64 XDR: % and _ occur in real keys, and a prefix carrying one
  // must not silently widen the match to every entry.
  const { pool, queries } = fakePool([]);
  await getContractStorageEntries(pool, {
    network: 'mainnet',
    contractId: CONTRACT,
    keyPrefix: 'a_b%c\\d',
    limit: 20,
  });

  const [query] = queries;
  assert.ok(query);
  assert.equal(query.params[2], 'a\\_b\\%c\\\\d%');
});

test('the cursor resolves to its own row within the contract and network', async () => {
  const { pool, queries } = fakePool([]);
  await getContractStorageEntries(pool, {
    network: 'testnet',
    contractId: CONTRACT,
    durability: 'temporary',
    keyPrefix: 'AAAA',
    cursor: KEY_B,
    limit: 10,
  });

  const [query] = queries;
  assert.ok(query);
  assert.match(query.sql, /last_modified_ledger, key\) < \(SELECT last_modified_ledger, key FROM contract_storage_entries WHERE key = \$5 AND contract_id = \$1 AND network = \$2\)/);
  assert.deepEqual(query.params, [CONTRACT, 'testnet', 'temporary', 'AAAA%', KEY_B, 10]);
});

test('the cursor row is scoped to its contract so a key from another contract cannot skip the list', async () => {
  // Key XDR is not globally unique — the same LedgerKey XDR can address a
  // different contract's row only if contract differs — so the subquery carries
  // contract_id as well as network; without it a cross-contract cursor would
  // resolve to no row and return an empty page forever.
  const { pool, queries } = fakePool([]);
  await getContractStorageEntries(pool, { network: 'mainnet', contractId: CONTRACT, cursor: KEY_B, limit: 5 });

  const [query] = queries;
  assert.ok(query);
  assert.match(query.sql, /contract_id = \$1 AND network = \$2/);
});

test('archived entries are included rather than filtered out', async () => {
  // The query must not silently restrict to active rows: a client needs to see
  // an archived entry to know the contract still owns that state.
  const { pool, queries } = fakePool([row({ state: 'archived' })]);
  const items = await getContractStorageEntries(pool, { network: 'mainnet', contractId: CONTRACT, limit: 20 });

  const [query] = queries;
  assert.ok(query);
  assert.doesNotMatch(query.sql, /state\s*=\s*'active'/);
  assert.equal(items[0]?.state, 'ARCHIVED');
});

test('both value forms are returned for the same entry', async () => {
  // #89 asks for both forms at once, so one row must carry the decoded value
  // and the raw XDR together.
  const { pool } = fakePool([row()]);
  const [item] = await getContractStorageEntries(pool, { network: 'mainnet', contractId: CONTRACT, limit: 20 });
  assert.equal(item?.value, '{"count":"42"}');
  assert.equal(item?.valueXdr, 'AAAAEQAAAAE');
});
