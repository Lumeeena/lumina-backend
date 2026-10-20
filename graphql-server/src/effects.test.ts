import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { buildSchema, graphql, isEnumType, isUnionType } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { EFFECT_TYPES, getEffects, mapEffect, mapEffectDetails, type EffectRow } from './effects';
import { createContext, resolvers } from './resolvers';
import { encodeCursor } from './pagination';

const typeDefs = readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8');
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ACCOUNT = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

function row(overrides: Partial<EffectRow> = {}): EffectRow {
  return {
    id: '0000231454543810561-0000000001',
    paging_token: '231454543810561-1',
    operation_id: '231454543810561',
    ledger: '53890',
    account: ACCOUNT,
    type: 'account_credited',
    type_i: 2,
    created_at: new Date('2026-10-18T10:00:00Z'),
    details: { amount: '10.0000000', asset_type: 'native' },
    network: 'mainnet',
    ...overrides,
  };
}

function fakePool(rows: EffectRow[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
  return { pool: pool as unknown as Pool, calls };
}

// ─── The three lists of effect types must agree ──────────────────────────────

test('EffectType enum lists exactly the Horizon types effects.ts maps', () => {
  const schema = buildSchema(typeDefs);
  const enumType = schema.getType('EffectType');
  assert.ok(isEnumType(enumType));
  const enumValues = enumType.getValues().map(value => value.name).sort();
  const mapped = Object.keys(EFFECT_TYPES).map(type => type.toUpperCase()).sort();
  assert.deepEqual(enumValues, mapped);
});

test('EffectDetails has a member for every detail shape, plus the unrecognized fallback', () => {
  const schema = buildSchema(typeDefs);
  const union = schema.getType('EffectDetails');
  assert.ok(isUnionType(union));
  const members = union.getTypes().map(type => type.name).sort();
  const kinds = [...new Set(Object.values(EFFECT_TYPES).filter((kind): kind is NonNullable<typeof kind> => kind !== null))];
  assert.deepEqual(members, [...kinds, 'UnrecognizedEffectDetails'].sort());
});

// ─── Typed details, from Horizon-shaped fields ───────────────────────────────

test('balance effects collapse the asset triplet to one string', () => {
  assert.deepEqual(mapEffectDetails('account_credited', { amount: '10.0000000', asset_type: 'native' }, ACCOUNT), {
    __typename: 'AccountBalanceEffectDetails',
    amount: '10.0000000',
    asset: 'XLM',
  });
  assert.deepEqual(
    mapEffectDetails(
      'account_debited',
      { amount: '2.5000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER },
      ACCOUNT
    ),
    { __typename: 'AccountBalanceEffectDetails', amount: '2.5000000', asset: `USDC:${ISSUER}` }
  );
  assert.deepEqual(
    mapEffectDetails('contract_credited', { contract: 'CCONTRACT', amount: '1.0000000', asset_type: 'native' }, ACCOUNT),
    { __typename: 'ContractBalanceEffectDetails', contract: 'CCONTRACT', amount: '1.0000000', asset: 'XLM' }
  );
});

test('account effects map their own fields', () => {
  assert.deepEqual(mapEffectDetails('account_created', { starting_balance: '10000.0000000' }, ACCOUNT), {
    __typename: 'AccountCreatedEffectDetails',
    startingBalance: '10000.0000000',
  });
  assert.deepEqual(
    mapEffectDetails('account_thresholds_updated', { low_threshold: 1, med_threshold: 2, high_threshold: 3 }, ACCOUNT),
    { __typename: 'AccountThresholdsEffectDetails', lowThreshold: 1, medThreshold: 2, highThreshold: 3 }
  );
  assert.deepEqual(mapEffectDetails('account_home_domain_updated', { home_domain: 'example.com' }, ACCOUNT), {
    __typename: 'AccountHomeDomainEffectDetails',
    homeDomain: 'example.com',
  });
  // Horizon spells it "revokable"; flags the operation did not touch stay null.
  assert.deepEqual(
    mapEffectDetails('account_flags_updated', { auth_required_flag: true, auth_revokable_flag: false }, ACCOUNT),
    {
      __typename: 'AccountFlagsEffectDetails',
      authRequired: true,
      authRevocable: false,
      authImmutable: null,
      authClawbackEnabled: null,
    }
  );
  assert.deepEqual(mapEffectDetails('sequence_bumped', { new_seq: 300000000000 }, ACCOUNT), {
    __typename: 'SequenceBumpedEffectDetails',
    newSequence: '300000000000',
  });
});

test('signer, trustline and data effects', () => {
  assert.deepEqual(mapEffectDetails('signer_created', { weight: 1, public_key: ACCOUNT, key: '' }, ACCOUNT), {
    __typename: 'SignerEffectDetails',
    publicKey: ACCOUNT,
    key: '',
    weight: 1,
  });
  assert.deepEqual(
    mapEffectDetails(
      'trustline_created',
      { limit: '922337203685.4775807', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER },
      ACCOUNT
    ),
    { __typename: 'TrustlineEffectDetails', asset: `USDC:${ISSUER}`, limit: '922337203685.4775807', liquidityPoolId: null }
  );
  // A pool-share trustline has no CODE:ISSUER; it names the pool instead.
  assert.deepEqual(
    mapEffectDetails('trustline_removed', { limit: '0.0000000', asset_type: 'liquidity_pool_shares', liquidity_pool_id: 'abc' }, ACCOUNT),
    { __typename: 'TrustlineEffectDetails', asset: null, limit: '0.0000000', liquidityPoolId: 'abc' }
  );
  assert.deepEqual(mapEffectDetails('data_created', { name: 'config', value: 'dmFsdWU=' }, ACCOUNT), {
    __typename: 'DataEffectDetails',
    name: 'config',
    value: 'dmFsdWU=',
  });
});

test('trustline authorization: legacy types are filled in from their name', () => {
  // Horizon omits the issuer here: it is the effect's own account.
  assert.deepEqual(
    mapEffectDetails('trustline_authorized', { trustor: ACCOUNT, asset_type: 'credit_alphanum4', asset_code: 'USDC' }, ISSUER),
    {
      __typename: 'TrustlineAuthorizationEffectDetails',
      trustor: ACCOUNT,
      asset: `USDC:${ISSUER}`,
      authorized: true,
      authorizedToMaintainLiabilities: null,
      clawbackEnabled: null,
    }
  );
  assert.equal(
    (mapEffectDetails('trustline_deauthorized', { trustor: ACCOUNT, asset_type: 'credit_alphanum4', asset_code: 'USDC' }, ISSUER) as { authorized: boolean }).authorized,
    false
  );
  assert.equal(
    (mapEffectDetails('trustline_authorized_to_maintain_liabilities', { trustor: ACCOUNT }, ISSUER) as {
      authorizedToMaintainLiabilities: boolean;
    }).authorizedToMaintainLiabilities,
    true
  );
  // trustline_flags_updated reports the flags itself (Horizon spells it "liabilites").
  assert.deepEqual(
    mapEffectDetails(
      'trustline_flags_updated',
      {
        trustor: ACCOUNT,
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: ISSUER,
        authorized_flag: false,
        authorized_to_maintain_liabilites_flag: true,
        clawback_enabled_flag: true,
      },
      ISSUER
    ),
    {
      __typename: 'TrustlineAuthorizationEffectDetails',
      trustor: ACCOUNT,
      asset: `USDC:${ISSUER}`,
      authorized: false,
      authorizedToMaintainLiabilities: true,
      clawbackEnabled: true,
    }
  );
});

test('trade effects carry both sides', () => {
  assert.deepEqual(
    mapEffectDetails(
      'trade',
      {
        seller: ISSUER,
        offer_id: 12345,
        sold_amount: '5.0000000',
        sold_asset_type: 'native',
        bought_amount: '1.0000000',
        bought_asset_type: 'credit_alphanum4',
        bought_asset_code: 'USDC',
        bought_asset_issuer: ISSUER,
      },
      ACCOUNT
    ),
    {
      __typename: 'TradeEffectDetails',
      seller: ISSUER,
      offerId: '12345',
      soldAmount: '5.0000000',
      soldAsset: 'XLM',
      boughtAmount: '1.0000000',
      boughtAsset: `USDC:${ISSUER}`,
    }
  );
});

test('claimable balance and sponsorship effects', () => {
  const predicate = { and: [{ unconditional: true }, { not: { abs_before: '2027-01-01T00:00:00Z' } }] };
  assert.deepEqual(
    mapEffectDetails(
      'claimable_balance_claimant_created',
      { balance_id: '0000abc', asset: 'native', amount: '1.0000000', predicate },
      ACCOUNT
    ),
    {
      __typename: 'ClaimableBalanceEffectDetails',
      balanceId: '0000abc',
      asset: 'XLM',
      amount: '1.0000000',
      predicate: JSON.stringify(predicate),
    }
  );
  assert.deepEqual(mapEffectDetails('trustline_sponsorship_updated', { asset: `USDC:${ISSUER}`, former_sponsor: 'GOLD', new_sponsor: 'GNEW' }, ACCOUNT), {
    __typename: 'SponsorshipEffectDetails',
    sponsor: null,
    formerSponsor: 'GOLD',
    newSponsor: 'GNEW',
    signer: null,
    dataName: null,
    asset: `USDC:${ISSUER}`,
    liquidityPoolId: null,
    balanceId: null,
  });
});

test('liquidity pool effects map the nested pool and reserves', () => {
  const details = mapEffectDetails(
    'liquidity_pool_deposited',
    {
      liquidity_pool: {
        id: 'pool1',
        fee_bp: 30,
        type: 'constant_product',
        total_trustlines: '3',
        total_shares: '100.0000000',
        reserves: [
          { asset: 'native', amount: '50.0000000' },
          { asset: `USDC:${ISSUER}`, amount: '25.0000000' },
        ],
      },
      reserves_deposited: [
        { asset: 'native', amount: '10.0000000' },
        { asset: `USDC:${ISSUER}`, amount: '5.0000000' },
      ],
      shares_received: '7.0710678',
    },
    ACCOUNT
  );
  assert.equal((details as { __typename: string }).__typename, 'LiquidityPoolEffectDetails');
  assert.deepEqual(details, {
    __typename: 'LiquidityPoolEffectDetails',
    liquidityPoolId: 'pool1',
    feeBp: 30,
    totalShares: '100.0000000',
    totalTrustlines: '3',
    reserves: [
      { asset: 'XLM', amount: '50.0000000', claimableBalanceId: null },
      { asset: `USDC:${ISSUER}`, amount: '25.0000000', claimableBalanceId: null },
    ],
    reservesDeposited: [
      { asset: 'XLM', amount: '10.0000000', claimableBalanceId: null },
      { asset: `USDC:${ISSUER}`, amount: '5.0000000', claimableBalanceId: null },
    ],
    reservesReceived: null,
    reservesRevoked: null,
    sharesReceived: '7.0710678',
    sharesRedeemed: null,
    sharesRevoked: null,
    sold: null,
    bought: null,
  });
  // liquidity_pool_removed carries only the id.
  assert.equal(
    (mapEffectDetails('liquidity_pool_removed', { liquidity_pool_id: 'pool1' }, ACCOUNT) as { liquidityPoolId: string }).liquidityPoolId,
    'pool1'
  );
});

test('types without fields have null details; unknown types keep their raw fields', () => {
  for (const type of ['account_removed', 'account_inflation_destination_updated', 'offer_created', 'offer_removed', 'offer_updated']) {
    assert.equal(mapEffectDetails(type, {}, ACCOUNT), null, type);
  }
  assert.deepEqual(mapEffectDetails('some_future_effect', { foo: 1 }, ACCOUNT), {
    __typename: 'UnrecognizedEffectDetails',
    raw: '{"foo":1}',
  });
  // A row whose details column was empty still maps.
  assert.deepEqual(mapEffectDetails('account_credited', null, ACCOUNT), {
    __typename: 'AccountBalanceEffectDetails',
    amount: null,
    asset: null,
  });
});

test('mapEffect exposes the common fields', () => {
  const effect = mapEffect(row());
  assert.equal(effect.id, '0000231454543810561-0000000001');
  assert.equal(effect.ledger, 53890);
  assert.equal(effect.typeId, 2);
  assert.equal(effect.type, 'account_credited');
  assert.equal(effect.operationId, '231454543810561');
  assert.equal(effect.createdAt, '2026-10-18T10:00:00.000Z');
});

// ─── SQL ─────────────────────────────────────────────────────────────────────

test('getEffects binds every value and uses the account indexes ordering', async () => {
  const { pool, calls } = fakePool();
  await getEffects(pool, { network: 'testnet', account: ACCOUNT, limit: 20 });
  assert.equal(
    calls[0].sql,
    'SELECT id, paging_token, operation_id, ledger, account, type, type_i, created_at, details, network FROM effects ' +
      'WHERE network = $1 AND account = $2 ORDER BY ledger DESC, id DESC LIMIT $3'
  );
  assert.deepEqual(calls[0].params, ['testnet', ACCOUNT, 20]);

  const cursor = encodeCursor('effects', [53890, '0000231454543810561-0000000001']);
  await getEffects(pool, { network: 'testnet', account: ACCOUNT, type: 'trade', limit: 5, cursor });
  assert.equal(
    calls[1].sql,
    'SELECT id, paging_token, operation_id, ledger, account, type, type_i, created_at, details, network FROM effects ' +
      'WHERE network = $1 AND account = $2 AND type = $3 AND (ledger, id) < ($4::bigint, $5::text) ' +
      'ORDER BY ledger DESC, id DESC LIMIT $6'
  );
  assert.deepEqual(calls[1].params, ['testnet', ACCOUNT, 'trade', 53890, '0000231454543810561-0000000001', 5]);
});

test('getEffects rejects an empty account and a cursor from another query', async () => {
  const { pool } = fakePool();
  await assert.rejects(getEffects(pool, { network: 'mainnet', account: '  ', limit: 20 }), {
    extensions: { code: 'BAD_USER_INPUT' },
  });
  await assert.rejects(
    getEffects(pool, { network: 'mainnet', account: ACCOUNT, limit: 20, cursor: encodeCursor('operations', [1, 'x']) }),
    { extensions: { code: 'INVALID_CURSOR' } }
  );
});

// ─── Resolver, end to end through the executable schema ──────────────────────

test('effects query: typed details through the union, type filter, cursor round-trip', async () => {
  const rows = [
    row(),
    row({
      id: '0000231454543810561-0000000002',
      type: 'trade',
      type_i: 33,
      details: { seller: ISSUER, offer_id: '9', sold_amount: '1.0000000', sold_asset_type: 'native', bought_amount: '2.0000000', bought_asset_type: 'credit_alphanum4', bought_asset_code: 'USDC', bought_asset_issuer: ISSUER },
    }),
    row({ id: '0000231454543810561-0000000003', type: 'offer_created', type_i: 30, details: {} }),
    row({ id: '0000231454543810561-0000000004', type: 'brand_new_effect', type_i: 999, details: { x: true } }),
  ];
  const { pool, calls } = fakePool(rows);
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const source = `query($account: String!, $type: EffectType, $limit: Int) {
    effects(account: $account, type: $type, limit: $limit) {
      items {
        id type typeId ledger
        details {
          __typename
          ... on AccountBalanceEffectDetails { amount asset }
          ... on TradeEffectDetails { soldAsset boughtAsset boughtAmount }
          ... on UnrecognizedEffectDetails { raw }
        }
      }
      pageInfo { hasNextPage cursor }
    }
  }`;

  const result = await graphql({
    schema,
    source,
    variableValues: { account: ACCOUNT, type: 'ACCOUNT_CREDITED', limit: 4 },
    contextValue: createContext(pool),
  });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  // graphql-js builds results on null-prototype objects; compare them as plain JSON.
  const page = (JSON.parse(JSON.stringify(result.data)) as { effects: { items: { details: unknown }[]; pageInfo: { hasNextPage: boolean; cursor: string } } }).effects;

  // The enum value reaches SQL as Horizon's lower-case name.
  assert.equal(calls[0].params[2], 'account_credited');
  assert.deepEqual(page.items.map(item => item.details), [
    { __typename: 'AccountBalanceEffectDetails', amount: '10.0000000', asset: 'XLM' },
    { __typename: 'TradeEffectDetails', soldAsset: 'XLM', boughtAsset: `USDC:${ISSUER}`, boughtAmount: '2.0000000' },
    null,
    { __typename: 'UnrecognizedEffectDetails', raw: '{"x":true}' },
  ]);
  assert.equal(page.pageInfo.hasNextPage, true);

  // The cursor resumes after the last row on the page.
  const next = await graphql({
    schema,
    source: 'query($account: String!, $cursor: String) { effects(account: $account, cursor: $cursor) { items { id } } }',
    variableValues: { account: ACCOUNT, cursor: page.pageInfo.cursor },
    contextValue: createContext(pool),
  });
  assert.equal(next.errors, undefined, JSON.stringify(next.errors));
  assert.match(calls[1].sql, /\(ledger, id\) < \(\$3::bigint, \$4::text\)/);
  assert.deepEqual(calls[1].params.slice(2, 4), [53890, '0000231454543810561-0000000004']);
});

test('effects query rejects a page size above the maximum', async () => {
  const { pool } = fakePool();
  await assert.rejects(
    resolvers.Query.effects({}, { account: ACCOUNT, limit: 101 }, createContext(pool)),
    { extensions: { code: 'BAD_USER_INPUT' } }
  );
});
