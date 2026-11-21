import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { StrKey } from '@stellar/stellar-sdk';
import { getLookalikeReason, isLookalikeAsset, WELL_KNOWN_ASSETS, flagLookalikeAssets } from './assetIssuer';

const USDC_ISSUER = WELL_KNOWN_ASSETS.find(asset => asset.code === 'USDC')!.issuer;

test('lookalike detection records case and confusable rules', () => {
  assert.equal(getLookalikeReason('USDC', 'GCOUNTERFEIT'), 'issuer_mismatch:USDC');
  assert.equal(getLookalikeReason('USDc', 'GCOUNTERFEIT'), 'case_variant:USDC');
  assert.equal(getLookalikeReason('U5DC', 'GCOUNTERFEIT'), 'confusable_variant:USDC');
  assert.equal(getLookalikeReason('USDC0', 'GCOUNTERFEIT'), 'confusable_variant:USDC');
  assert.equal(isLookalikeAsset('U5DC', 'GCOUNTERFEIT'), true);
});

test('lookalike detection leaves genuine issuers and unrelated codes unflagged', () => {
  assert.equal(getLookalikeReason('USDC', USDC_ISSUER), null);
  assert.equal(getLookalikeReason('EURO', 'GCOUNTERFEIT'), null);
  assert.equal(getLookalikeReason('USDCX', 'GCOUNTERFEIT'), null);
  assert.equal(getLookalikeReason('USDC', 'GCOUNTERFEIT', 'testnet'), null);
});

test('well-known issuers are valid and unique within their network', () => {
  for (const asset of WELL_KNOWN_ASSETS) {
    assert.doesNotThrow(() => StrKey.decodeEd25519PublicKey(asset.issuer));
  }
  const identities = WELL_KNOWN_ASSETS.map(asset => `${asset.network}:${asset.issuer}`);
  assert.equal(new Set(identities).size, identities.length);
});

test('flagLookalikeAssets stores the matching rule with the flag', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT asset_code')) {
        return { rows: [{ asset_code: 'USDC0', asset_issuer: 'GCOUNTERFEIT' }] };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;

  assert.equal(await flagLookalikeAssets(pool, 'mainnet'), 1);
  assert.match(calls[1]!.sql, /lookalike_reason = \$1/);
  assert.deepEqual(calls[1]!.params, ['confusable_variant:USDC', 'USDC0', 'GCOUNTERFEIT', 'mainnet']);
});
