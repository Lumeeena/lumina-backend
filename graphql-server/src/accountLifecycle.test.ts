import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildASTSchema, graphql, Kind, parse } from 'graphql';
import { Pool } from 'pg';
import { getAccountLifecycle, mapOperation, type OperationRow } from './db';
import { encodeCursor, InvalidCursorError } from './pagination';
import { createContext, resolvers } from './resolvers';

function row(type: string, details: Record<string, unknown>): OperationRow {
  return { id: '10', network: 'mainnet', type, details, ledger: '100',
    source_account: type === 'create_account' ? 'GFUNDER' : 'GSUBJECT',
    transaction_hash: 'tx', created_at: new Date('2026-01-01T00:00:00Z') };
}

test('creation and merge decode Horizon fields without conflating payment fields', () => {
  const creation = mapOperation(row('create_account', {
    account: 'GSUBJECT', funder: 'GFUNDER', starting_balance: '900719925.4740993',
  }));
  assert.equal(creation.createdAccount, 'GSUBJECT');
  assert.equal(creation.funder, 'GFUNDER');
  assert.equal(creation.startingBalance, '900719925.4740993');
  assert.equal(creation.mergeDestination, null);
  const merge = mapOperation(row('account_merge', { account: 'GSUBJECT', into: 'GRECIPIENT' }));
  assert.equal(merge.mergeDestination, 'GRECIPIENT');
  assert.equal(merge.createdAccount, null);
  assert.equal(merge.amount, null);
  assert.equal(mapOperation(row('payment', { account: 'GOTHER', into: 'GOTHER' })).mergeDestination, null);
  assert.equal(mapOperation(row('create_account', { starting_balance: '0.0000000' })).startingBalance, '0.0000000');
  assert.equal(mapOperation(row('account_merge', {})).mergeDestination, null);
});

test('lifecycle query binds address/network and resumes with an opaque tuple cursor', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params }); return { rows: [] };
  } } as unknown as Pool;
  const address = "G'; DROP TABLE operations; --";
  await getAccountLifecycle(pool, 'testnet', address, 2, encodeCursor('accountLifecycle', [100, '10']));
  const { sql, params } = calls[0]!;
  assert.match(sql, /WHERE network = \$1 AND type IN \('create_account', 'account_merge'\)/);
  assert.match(sql, /details @> \$2::jsonb AND \(ledger, id\) < \(\$3::bigint, \$4::text\)/);
  assert.match(sql, /ORDER BY ledger DESC, id DESC LIMIT \$5/);
  assert.ok(!sql.includes(address));
  assert.deepEqual(params, ['testnet', JSON.stringify({ account: address }), 100, '10', 2]);
  await assert.rejects(getAccountLifecycle(pool, 'mainnet', 'G', 2, 'bad'), InvalidCursorError);
  await assert.rejects(getAccountLifecycle(pool, 'mainnet', 'G', 2, encodeCursor('operations', [100, '10'])), InvalidCursorError);
  assert.equal(calls.length, 1);
});

test('lifecycle GraphQL schema slice exposes fields, cursors, and page-size validation', async () => {
  const pool = { query: async () => ({ rows: [row('create_account', {
    account: 'GSUBJECT', funder: 'GFUNDER', starting_balance: '2.0000000',
  })] }) } as unknown as Pool;
  // Validate the actual lifecycle SDL independently of unrelated API fields.
  const document = parse(readFileSync(join(__dirname, 'schema.graphql'), 'utf8'));
  const names = new Set(['Query', 'Operation', 'OperationPage', 'PageInfo', 'TotalCount', 'CountPrecision', 'OperationType', 'Network']);
  const schema = buildASTSchema({ ...document, definitions: document.definitions
    .filter(def => 'name' in def && def.name && names.has(def.name.value))
    // New Query fields are added through `extend type Query`; an unfiltered
    // extension would pull in every type outside this slice.
    .filter(def => !(def.kind === Kind.OBJECT_TYPE_EXTENSION && 'name' in def && def.name?.value === 'Query'))
    .map(def => {
      if (def.kind !== Kind.OBJECT_TYPE_DEFINITION) return def;
      if (def.name.value === 'Query') return { ...def, fields: def.fields?.filter(field => field.name.value === 'accountLifecycle') };
      if (def.name.value === 'Operation') return { ...def, fields: def.fields?.filter(field => !['account', 'transaction'].includes(field.name.value)) };
      return def;
    }) });
  const result = await graphql({ schema,
    source: '{ accountLifecycle(address: "GSUBJECT", limit: 1) { items { type createdAccount funder startingBalance mergeDestination } pageInfo { cursor hasNextPage } } }',
    rootValue: { accountLifecycle: (args: { address: string; limit: number }) =>
      resolvers.Query.accountLifecycle({}, args, createContext(pool)) },
  });
  assert.equal(result.errors, undefined);
  const page = result.data?.accountLifecycle as { items: Record<string, unknown>[]; pageInfo: { cursor: string; hasNextPage: boolean } };
  assert.equal(page.items[0]?.createdAccount, 'GSUBJECT');
  assert.equal(page.items[0]?.funder, 'GFUNDER');
  assert.equal(page.items[0]?.startingBalance, '2.0000000');
  assert.equal(page.pageInfo.cursor, encodeCursor('accountLifecycle', [100, '10']));
  assert.equal(page.pageInfo.hasNextPage, true);
  await assert.rejects(resolvers.Query.accountLifecycle({}, { address: 'G', limit: 101 }, createContext(pool)), /maximum/);
});

test('live Postgres: lifecycle history survives merge, paginates, and isolates networks',
  { skip: !process.env['TEST_DATABASE_URL'] }, async () => {
    const pool = new Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
    const client = await pool.connect();
    try {
      // Session-local table: no writes to deployment tables, no account snapshot required.
      await client.query(`CREATE TEMP TABLE operations (
        id text, network text, type text, transaction_hash text, ledger bigint,
        created_at timestamptz, source_account text, details jsonb
      )`);
      const fixtures = [
        { ...row('create_account', { account: 'GSUBJECT', funder: 'GFUNDER', starting_balance: '2.0000000' }), id: '1' },
        { ...row('account_merge', { account: 'GSUBJECT', into: 'GRECIPIENT' }), id: '2' },
        { ...row('create_account', { account: 'GSUBJECT', funder: 'GNEW', starting_balance: '0.0000000' }), id: '3' },
        { ...row('create_account', { account: 'GOTHER', funder: 'GSUBJECT' }), id: '4' },
        { ...row('payment', { account: 'GSUBJECT' }), id: '5' },
        { ...row('account_merge', { account: 'GOTHER', into: 'GSUBJECT' }), id: '6' },
        { ...row('account_merge', { account: 'GSUBJECT', into: 'GTESTNET' }), network: 'testnet', id: '2' },
      ];
      for (const op of fixtures) {
        await client.query('INSERT INTO operations VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [op.id, op.network, op.type, op.transaction_hash, op.ledger, op.created_at, op.source_account, op.details]);
      }
      const db = client as unknown as Pool;
      const first = await getAccountLifecycle(db, 'mainnet', 'GSUBJECT', 2);
      assert.deepEqual(first.map(op => op.id), ['3', '2']);
      assert.equal(first[0]?.createdAccount, 'GSUBJECT');
      assert.equal(first[0]?.startingBalance, '0.0000000');
      assert.equal(first[1]?.mergeDestination, 'GRECIPIENT');
      const second = await getAccountLifecycle(db, 'mainnet', 'GSUBJECT', 2, encodeCursor('accountLifecycle', [100, '2']));
      assert.deepEqual(second.map(op => op.id), ['1']);
      assert.equal(second[0]?.funder, 'GFUNDER');
      assert.deepEqual(await getAccountLifecycle(db, 'mainnet', 'GSUBJECT', 2, encodeCursor('accountLifecycle', [100, '1'])), []);
      assert.equal((await getAccountLifecycle(db, 'testnet', 'GSUBJECT', 2))[0]?.mergeDestination, 'GTESTNET');
      assert.deepEqual(await getAccountLifecycle(db, 'mainnet', 'GUNKNOWN', 2), []);
    } finally { client.release(); await pool.end(); }
  });
