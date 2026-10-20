import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import {
  evaluatePredicate,
  getClaimableBalances,
  mapClaimableBalance,
  type ClaimableBalanceRow,
} from './claimableBalances';
import { createContext, resolvers } from './resolvers';
import { encodeCursor } from './pagination';

const CREATED = new Date('2026-01-01T00:00:00Z');
const at = (iso: string) => new Date(iso);
const ALICE = 'GALICE';
const BOB = 'GBOB';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function row(overrides: Partial<ClaimableBalanceRow> = {}): ClaimableBalanceRow {
  return {
    balance_id: '00000000dd35e5f1aa87257450979d481daa163a12a7c24ac82e7f829af6a47b7f261943',
    asset: 'native',
    amount: '10.0000000',
    sponsor: 'GSPONSOR',
    claimants: [
      { destination: ALICE, predicate: { unconditional: true } },
      { destination: BOB, predicate: { abs_before: '2026-02-01T00:00:00Z', abs_before_epoch: '1769904000' } },
    ],
    status: 'unclaimed',
    claimed_by: null,
    claimed_at: null,
    claimed_ledger: null,
    created_ledger: '600',
    created_at: CREATED,
    network: 'mainnet',
    ...overrides,
  };
}

// ─── Predicate evaluation ────────────────────────────────────────────────────

test('unconditional is always claimable', () => {
  assert.equal(evaluatePredicate({ unconditional: true }, CREATED, at('2099-01-01T00:00:00Z')), true);
});

test('abs_before holds strictly before the deadline', () => {
  const p = { abs_before: '2026-02-01T00:00:00Z' };
  assert.equal(evaluatePredicate(p, CREATED, at('2026-01-31T23:59:59Z')), true);
  assert.equal(evaluatePredicate(p, CREATED, at('2026-02-01T00:00:00Z')), false);
  // Horizon also sends the epoch form, which wins when present (it is exact
  // where the RFC 3339 string can be clamped for far-future dates).
  assert.equal(evaluatePredicate({ abs_before: '9999-12-31T23:59:59Z', abs_before_epoch: '1769904000' }, CREATED, at('2026-03-01T00:00:00Z')), false);
});

test('rel_before counts from the creation ledger, not from now', () => {
  const day = { rel_before: '86400' };
  assert.equal(evaluatePredicate(day, CREATED, at('2026-01-01T23:59:59Z')), true);
  assert.equal(evaluatePredicate(day, CREATED, at('2026-01-02T00:00:00Z')), false);
});

test('not, and, or compose, including the "claimable only after" idiom', () => {
  // "not before Feb 1" = claimable from Feb 1 onwards.
  const after = { not: { abs_before: '2026-02-01T00:00:00Z' } };
  assert.equal(evaluatePredicate(after, CREATED, at('2026-01-15T00:00:00Z')), false);
  assert.equal(evaluatePredicate(after, CREATED, at('2026-02-15T00:00:00Z')), true);

  // A window: from Feb 1 until Mar 1.
  const window = { and: [after, { abs_before: '2026-03-01T00:00:00Z' }] };
  assert.equal(evaluatePredicate(window, CREATED, at('2026-01-15T00:00:00Z')), false);
  assert.equal(evaluatePredicate(window, CREATED, at('2026-02-15T00:00:00Z')), true);
  assert.equal(evaluatePredicate(window, CREATED, at('2026-03-15T00:00:00Z')), false);

  const either = { or: [{ abs_before: '2026-01-10T00:00:00Z' }, after] };
  assert.equal(evaluatePredicate(either, CREATED, at('2026-01-05T00:00:00Z')), true);
  assert.equal(evaluatePredicate(either, CREATED, at('2026-01-15T00:00:00Z')), false);
  assert.equal(evaluatePredicate(either, CREATED, at('2026-02-15T00:00:00Z')), true);
});

test('an unreadable predicate is unknown, not guessed', () => {
  for (const p of [null, {}, { abs_before: 'not a date' }, { and: [] }, { not: { mystery: 1 } }, 'x']) {
    assert.equal(evaluatePredicate(p, CREATED, at('2026-01-02T00:00:00Z')), null, JSON.stringify(p));
  }
  // A known false part decides an `and`, a known true part decides an `or`.
  assert.equal(evaluatePredicate({ and: [{ mystery: 1 }, { abs_before: '2025-01-01T00:00:00Z' }] }, CREATED, at('2026-01-02T00:00:00Z')), false);
  assert.equal(evaluatePredicate({ or: [{ mystery: 1 }, { unconditional: true }] }, CREATED, at('2026-01-02T00:00:00Z')), true);
  assert.equal(evaluatePredicate({ and: [{ mystery: 1 }, { unconditional: true }] }, CREATED, at('2026-01-02T00:00:00Z')), null);
});

// ─── Mapping ─────────────────────────────────────────────────────────────────

test('claimableNow is per claimant with a claimant filter, any claimant without', () => {
  const later = at('2026-03-01T00:00:00Z'); // after BOB's deadline
  const forBob = mapClaimableBalance(row(), later, BOB);
  assert.equal(forBob.claimableNow, false);
  assert.deepEqual(
    forBob.claimants.map(c => [c.destination, c.claimableNow]),
    [[ALICE, true], [BOB, false]]
  );
  assert.equal(mapClaimableBalance(row(), later, ALICE).claimableNow, true);
  assert.equal(mapClaimableBalance(row(), later).claimableNow, true);
  // An account that is not a claimant cannot claim it.
  assert.equal(mapClaimableBalance(row(), later, 'GSTRANGER').claimableNow, false);
});

test('a claimed or clawed-back balance is claimable by nobody', () => {
  for (const status of ['claimed', 'clawed_back']) {
    const balance = mapClaimableBalance(row({ status, claimed_at: at('2026-01-05T00:00:00Z'), claimed_ledger: '700' }), at('2026-01-10T00:00:00Z'), ALICE);
    assert.equal(balance.claimableNow, false, status);
    assert.ok(balance.claimants.every(c => c.claimableNow === false), status);
    assert.equal(balance.status, status.toUpperCase());
    assert.equal(balance.claimedLedger, 700);
  }
});

test('mapping uses the API asset spelling and keeps predicates as JSON', () => {
  const balance = mapClaimableBalance(row(), at('2026-01-10T00:00:00Z'));
  assert.equal(balance.asset, 'XLM');
  assert.equal(balance.createdLedger, 600);
  assert.equal(balance.claimants[0]?.predicate, '{"unconditional":true}');
  assert.equal(mapClaimableBalance(row({ asset: `USDC:${ISSUER}` }), at('2026-01-10T00:00:00Z')).asset, `USDC:${ISSUER}`);
});

// ─── SQL ─────────────────────────────────────────────────────────────────────

function fakePool(rows: ClaimableBalanceRow[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
  return { pool: pool as unknown as Pool, calls };
}

const SELECT =
  'SELECT balance_id, asset, amount, sponsor, claimants, status, claimed_by, claimed_at, claimed_ledger, created_ledger, created_at, network FROM claimable_balances ';

test('claimant filter: an indexed EXISTS, unclaimed only, newest first', async () => {
  const { pool, calls } = fakePool();
  await getClaimableBalances(pool, { network: 'mainnet', claimant: ALICE, limit: 20 });
  assert.equal(
    calls[0].sql,
    SELECT +
      'WHERE network = $1 AND EXISTS (SELECT 1 FROM claimable_balance_claimants c WHERE c.destination = $2 ' +
      'AND c.network = claimable_balances.network AND c.balance_id = claimable_balances.balance_id) ' +
      "AND status = 'unclaimed' ORDER BY created_ledger DESC, balance_id DESC LIMIT $3"
  );
  assert.deepEqual(calls[0].params, ['mainnet', ALICE, 20]);
});

test('sponsor and asset filters, XLM as stored, claimed included, cursor', async () => {
  const { pool, calls } = fakePool();
  const cursor = encodeCursor('claimableBalances', [600, '00000000ab']);
  await getClaimableBalances(pool, { network: 'testnet', sponsor: 'GSPONSOR', asset: 'XLM', includeClaimed: true, limit: 5, cursor });
  assert.equal(
    calls[0].sql,
    SELECT +
      'WHERE network = $1 AND sponsor = $2 AND asset = $3 AND (created_ledger, balance_id) < ($4::bigint, $5::text) ' +
      'ORDER BY created_ledger DESC, balance_id DESC LIMIT $6'
  );
  assert.deepEqual(calls[0].params, ['testnet', 'GSPONSOR', 'native', 600, '00000000ab', 5]);
});

test('at least one filter is required, and a foreign cursor is rejected', async () => {
  const { pool } = fakePool();
  await assert.rejects(getClaimableBalances(pool, { network: 'mainnet', limit: 20 }), { extensions: { code: 'BAD_USER_INPUT' } });
  await assert.rejects(getClaimableBalances(pool, { network: 'mainnet', claimant: '  ', limit: 20 }), { extensions: { code: 'BAD_USER_INPUT' } });
  await assert.rejects(
    getClaimableBalances(pool, { network: 'mainnet', claimant: ALICE, limit: 20, cursor: encodeCursor('trades', ['x', 'y']) }),
    { extensions: { code: 'INVALID_CURSOR' } }
  );
});

// ─── End to end through the executable schema ────────────────────────────────

test('claimableBalances query: evaluated claimability, status, page info', async () => {
  const rows = [
    row({
      balance_id: '00000000aa',
      created_ledger: '700',
      claimants: [
        { destination: ALICE, predicate: { not: { abs_before: '2099-01-01T00:00:00Z' } } }, // not yet
        { destination: BOB, predicate: { unconditional: true } },
      ],
    }),
    row({ balance_id: '00000000bb', created_ledger: '600', claimants: [{ destination: ALICE, predicate: { unconditional: true } }] }),
  ];
  const { pool, calls } = fakePool(rows);
  const schema = makeExecutableSchema({ typeDefs: readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8'), resolvers });
  const before = Date.now();
  const result = await graphql({
    schema,
    source: `{
      claimableBalances(claimant: "${ALICE}", limit: 2) {
        evaluatedAt
        items { id asset status claimableNow createdLedger claimants { destination claimableNow predicate } }
        pageInfo { hasNextPage cursor }
      }
    }`,
    contextValue: createContext(pool),
  });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const page = JSON.parse(JSON.stringify(result.data)).claimableBalances;

  assert.deepEqual(
    page.items.map((b: { id: string; claimableNow: boolean; status: string; asset: string }) => [b.id, b.claimableNow, b.status, b.asset]),
    [
      ['00000000aa', false, 'UNCLAIMED', 'XLM'], // BOB could, ALICE cannot yet
      ['00000000bb', true, 'UNCLAIMED', 'XLM'],
    ]
  );
  assert.deepEqual(page.items[0].claimants.map((c: { claimableNow: boolean }) => c.claimableNow), [false, true]);
  assert.ok(Date.parse(page.evaluatedAt) >= before);
  assert.equal(page.pageInfo.hasNextPage, true);
  assert.deepEqual(calls[0].params, ['mainnet', ALICE, 2]);

  await graphql({
    schema,
    source: `query($c: String) { claimableBalances(claimant: "${ALICE}", cursor: $c) { items { id } } }`,
    variableValues: { c: page.pageInfo.cursor },
    contextValue: createContext(pool),
  });
  assert.deepEqual(calls[1].params.slice(2, 4), [600, '00000000bb']);
});
