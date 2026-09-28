import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { Pool as PgPool } from 'pg';
import {
  getAccountFromDb,
  getAccounts,
  getEventsByContract,
  getLedgers,
  getOperations,
  getTransactions,
  mapAccount,
  mapEvent,
  mapLedger,
  mapOperation,
  mapTransaction,
  type AccountOrder,
} from './db';
import { encodeCursor, InvalidCursorError } from './pagination';

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

test('mapLedger converts BIGINT strings and Date to GraphQL shape', () => {
  const result = mapLedger({
    network: 'mainnet',
    sequence: '52481234',
    closed_at: new Date('2026-05-06T10:22:14Z'),
    transaction_count: 5,
    operation_count: 12,
    base_fee: '100',
    base_reserve: '5000000',
  });
  assert.deepEqual(result, {
    network: 'mainnet',
    sequence: 52481234,
    closedAt: '2026-05-06T10:22:14.000Z',
    transactionCount: 5,
    operationCount: 12,
    baseFee: 100,
    baseReserve: 5000000,
  });
});

test('PostgreSQL TIMESTAMPTZ round-trips an offset instant as UTC', { skip: !process.env['TEST_DATABASE_URL'] }, async () => {
  const pool = new PgPool({ connectionString: process.env['TEST_DATABASE_URL'] });
  const client = await pool.connect();
  try {
    await client.query("SET TIME ZONE 'America/Los_Angeles'");
    const { rows } = await client.query<{ value: Date }>(
      'SELECT $1::timestamptz AS value', ['2026-06-14T09:30:00.123+05:30']
    );
    const value = rows[0]?.value;
    assert.ok(value instanceof Date);
    assert.equal(value.toISOString(), '2026-06-14T04:00:00.123Z');
  } finally { client.release(); await pool.end(); }
});

test('mapTransaction keeps feeCharged as a string (no precision loss)', () => {
  const result = mapTransaction({
    network: 'mainnet',
    hash: 'abc',
    ledger: '100',
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GABC',
    fee_charged: '10000000000',
    operation_count: 1,
    successful: true,
    memo_type: 'none',
    memo: null,
  });
  assert.equal(result.ledger, 100);
  assert.equal(result.feeCharged, '10000000000');
});

test('mapOperation collapses asset_type/code/issuer into a single asset string', () => {
  const payment = mapOperation({
    network: 'mainnet',
    id: 'op1',
    type: 'payment',
    transaction_hash: 'tx1',
    ledger: '100',
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GABC',
    details: { from: 'GABC', to: 'GDEF', amount: '100', asset_type: 'native' },
  });
  assert.equal(payment.type, 'PAYMENT');
  assert.equal(payment.asset, 'XLM');
  assert.equal(payment.from, 'GABC');

  const trustline = mapOperation({
    network: 'testnet',
    id: 'op2',
    type: 'change_trust',
    transaction_hash: 'tx2',
    ledger: '100',
    created_at: new Date('2026-01-01T00:00:00Z'),
    source_account: 'GABC',
    details: { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER' },
  });
  assert.equal(trustline.type, 'CHANGE_TRUST');
  assert.equal(trustline.asset, 'USDC:GISSUER');
});

test('mapAccount converts snake_case balances/flags/thresholds to GraphQL shape', () => {
  const result = mapAccount({
    network: 'mainnet',
    address: 'GABC',
    sequence: '1',
    subentry_count: 2,
    last_modified_ledger: 100,
    num_sponsored: 0,
    num_sponsoring: 0,
    balances: [{ asset_type: 'native', balance: '500' }],
    flags: { auth_required: true },
    thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
  });
  assert.equal(result.address, 'GABC');
  assert.deepEqual(result.balances, [{
    assetType: 'native', assetCode: null, assetIssuer: null, balance: '500', limit: null, buyingLiabilities: null, sellingLiabilities: null,
  }]);
  assert.equal(result.flags.authRequired, true);
  assert.equal(result.flags.authRevocable, false);
  assert.equal(result.thresholds.medThreshold, 2);
});

test('mapEvent JSON-encodes the value column for the String scalar', () => {
  const result = mapEvent({
    network: 'mainnet',
    id: 'evt1',
    type: 'contract',
    contract_id: 'CABC',
    ledger: '100',
    created_at: new Date('2026-01-01T00:00:00Z'),
    paging_token: 'tok1',
    topics: ['swap'],
    value: { amount: '10' },
  });
  assert.equal(result.value, '{"amount":"10"}');
});

test('getTransactions maps rows and passes limit/cursor params', async () => {
  const { pool, queries } = fakePool([
    { hash: 'a', ledger: '1', created_at: new Date(), source_account: 'G', fee_charged: '100', operation_count: 1, successful: true, memo_type: null, memo: null },
  ]);
  const items = await getTransactions(pool, 'mainnet', 20, encodeCursor('transactions', [500, 'cursor-hash']));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.hash, 'a');
  // The cursor carries the sort key itself rather than an id to look up, so
  // paging never depends on the row it points at still existing.
  assert.deepEqual(queries[0]?.params, ['mainnet', 500, 'cursor-hash', 20]);
  assert.match(queries[0]?.sql ?? '', /\(ledger, hash\) < \(\$2::bigint, \$3::text\)/);
});

test('getOperations builds WHERE clause only for provided filters', async () => {
  const { pool, queries } = fakePool([]);
  await getOperations(pool, { network: 'mainnet', account: 'GABC', limit: 10 });
  assert.match(queries[0]?.sql ?? '', /WHERE network = \$1 AND source_account = \$2/);
  assert.deepEqual(queries[0]?.params, ['mainnet', 'GABC', 10]);
});

test('getOperations is scoped to one network even with no filters', async () => {
  const { pool, queries } = fakePool([]);
  await getOperations(pool, { network: 'testnet', limit: 10 });
  assert.match(queries[0]?.sql ?? '', /WHERE network = \$1/);
  assert.deepEqual(queries[0]?.params, ['testnet', 10]);
});

test('getAccountFromDb returns null when no row is found', async () => {
  const { pool } = fakePool([]);
  assert.equal(await getAccountFromDb(pool, 'mainnet', 'GABC'), null);
});

test('getEventsByContract filters by contract_id and optional topic', async () => {
  const { pool, queries } = fakePool([]);
  await getEventsByContract(pool, { network: 'mainnet', contractId: 'CABC', topic: 'swap', limit: 5 });
  assert.match(queries[0]?.sql ?? '', /contract_id = \$1/);
  assert.match(queries[0]?.sql ?? '', /network = \$2/);
  assert.match(queries[0]?.sql ?? '', /\$3 = ANY\(topics\)/);
  assert.deepEqual(queries[0]?.params, ['CABC', 'mainnet', 'swap', 5]);
});

test('getLedgers returns the newest ledgers and maps them like ledger(sequence:)', async () => {
  const { pool, queries } = fakePool([
    { network: 'mainnet', sequence: '900', closed_at: new Date('2026-05-06T10:22:14Z'), transaction_count: 5, operation_count: 12, base_fee: '100', base_reserve: '5000000' },
    { network: 'mainnet', sequence: '899', closed_at: new Date('2026-05-06T10:22:13Z'), transaction_count: 4, operation_count: 9, base_fee: '100', base_reserve: '5000000' },
  ]);

  const items = await getLedgers(pool, 'mainnet', 2);

  assert.match(queries[0]?.sql ?? '', /FROM ledgers WHERE network = \$1/);
  assert.match(queries[0]?.sql ?? '', /ORDER BY sequence DESC LIMIT \$2/);
  // Same mapping the single-ledger query uses, so a chart and a detail page
  // cannot disagree about a ledger.
  assert.deepEqual(items[0], mapLedger({
    network: 'mainnet', sequence: '900', closed_at: new Date('2026-05-06T10:22:14Z'),
    transaction_count: 5, operation_count: 12, base_fee: '100', base_reserve: '5000000',
  }));
  assert.deepEqual(items.map(item => item.sequence), [900, 899]);
});

test('getLedgers keysets on the sequence without a row lookup', async () => {
  const { pool, queries } = fakePool([]);

  await getLedgers(pool, 'mainnet', 20, encodeCursor('ledgers', [900]));

  assert.match(queries[0]?.sql ?? '', /\(sequence\) < \(\$2::bigint\)/);
  assert.deepEqual(queries[0]?.params, ['mainnet', 900, 20]);
  assert.ok(!/OFFSET/i.test(queries[0]?.sql ?? ''));
});

test('getLedgers rejects a cursor it could not have issued', async () => {
  const { pool, queries } = fakePool([]);

  await assert.rejects(
    () => getLedgers(pool, 'mainnet', 20, 'not-a-cursor'),
    (err: unknown) => err instanceof InvalidCursorError
  );
  assert.equal(queries.length, 0);
});

// ── Accounts listing ─────────────────────────────────────────────────────────

function accountRow(address: string, lastModifiedLedger = 100) {
  return {
    network: 'mainnet',
    address,
    sequence: '1',
    subentry_count: 0,
    last_modified_ledger: String(lastModifiedLedger),
    num_sponsored: 0,
    num_sponsoring: 0,
    balances: [],
    flags: {},
    thresholds: {},
  };
}

test('accounts list most recently active first by default', async () => {
  const { pool, queries } = fakePool([accountRow('GB', 900), accountRow('GA', 800)]);

  const items = await getAccounts(pool, { network: 'mainnet', limit: 2 });

  assert.match(queries[0]?.sql ?? '', /FROM accounts\s+WHERE network = \$1/);
  // The address tiebreaker is what makes the walk terminate: many accounts share
  // a last-modified ledger, and without it a keyset page can repeat forever.
  assert.match(queries[0]?.sql ?? '', /ORDER BY last_modified_ledger DESC, address ASC/);
  assert.match(queries[0]?.sql ?? '', /LIMIT \$2/);
  assert.deepEqual(items.map(item => item.address), ['GB', 'GA']);
  // Same mapping as the single-account query, so a listing row and
  // account(address:) cannot disagree.
  assert.deepEqual(items[0], await getAccountFromDb(fakePool([accountRow('GB', 900)]).pool, 'mainnet', 'GB'));
  assert.equal(items[0]?.lastModifiedLedger, 900);
});

test('accounts paginate on activity with a bound keyset, not a row lookup', async () => {
  const { pool, queries } = fakePool([]);

  await getAccounts(pool, {
    network: 'mainnet',
    limit: 20,
    cursor: encodeCursor('accounts', [900, 'GABC']),
  });

  assert.match(queries[0]?.sql ?? '', /\(last_modified_ledger, address\) < \(\$2::bigint, \$3::text\)/);
  assert.deepEqual(queries[0]?.params, ['mainnet', 900, 'GABC', 20]);
  assert.ok(!/OFFSET/i.test(queries[0]?.sql ?? ''));
  // No subquery: the cursor carries the sort key, so a cursor survives the row
  // it names being re-indexed.
  assert.ok(!/SELECT/i.test((queries[0]?.sql ?? '').replace(/SELECT \* FROM accounts/, '')));
});

test('accounts can be listed in address order instead', async () => {
  const { pool, queries } = fakePool([]);

  await getAccounts(pool, { network: 'mainnet', orderBy: 'ADDRESS', limit: 5, cursor: encodeCursor('accounts', ['GABC']) });

  assert.match(queries[0]?.sql ?? '', /ORDER BY address ASC/);
  assert.match(queries[0]?.sql ?? '', /\(address\) < \(\$2::text\)/);
  assert.deepEqual(queries[0]?.params, ['mainnet', 'GABC', 5]);
});

test('an activity cursor is rejected by the address ordering', async () => {
  const { pool, queries } = fakePool([]);

  // Two-column versus one: comparing them would silently resume in the wrong
  // place, so it is an error rather than a wrong answer.
  await assert.rejects(
    () => getAccounts(pool, { network: 'mainnet', orderBy: 'ADDRESS', limit: 5, cursor: encodeCursor('accounts', [900, 'GABC']) }),
    (err: unknown) => err instanceof InvalidCursorError
  );
  assert.equal(queries.length, 0);
});

test('an unknown account order falls back to activity rather than reaching SQL', async () => {
  const { pool, queries } = fakePool([]);

  await getAccounts(pool, { network: 'mainnet', orderBy: 'BY_VIBES' as AccountOrder, limit: 5 });

  assert.match(queries[0]?.sql ?? '', /ORDER BY last_modified_ledger DESC, address ASC/);
  assert.ok(!/VIBES/i.test(queries[0]?.sql ?? ''));
});

test('the accounts listing never reaches Horizon', async () => {
  const { pool, queries } = fakePool([]);

  await getAccounts(pool, { network: 'mainnet', limit: 1 });

  // The listing is the indexed table by definition: "indexed accounts only" is a
  // documented property, not a gap to paper over with a network round trip per
  // row.
  assert.equal(queries.length, 1);
  assert.equal(queries[0]?.params.length, 2);
});
