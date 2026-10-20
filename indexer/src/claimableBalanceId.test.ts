import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimableBalanceId, operationIndex } from './claimableBalanceId';

// Real mainnet operations, with the balance ids Horizon reports for them in
// the `claimable_balance_created` effect. The first two are operations 2 and
// 52 of one transaction (test/contract/fixtures/operations.json carries the
// first); the third is from another transaction.
const MAINNET = [
  {
    source: 'GB4NLVHUFFJYUG5PMJRPSOOXGM6GRKNKWJ2BMJQATAZOEG2GZD2PVN27',
    sequence: '266166330288257195',
    operationId: '279341181123747842',
    balanceId: '00000000dd35e5f1aa87257450979d481daa163a12a7c24ac82e7f829af6a47b7f261943',
  },
  {
    source: 'GB4NLVHUFFJYUG5PMJRPSOOXGM6GRKNKWJ2BMJQATAZOEG2GZD2PVN27',
    sequence: '266166330288257195',
    operationId: '279341181123747892',
    balanceId: '00000000a82eee128a743e2c9ea42ee0e3c52176e1dac231d86af2c88d47a9967b4fe2be',
  },
  {
    source: 'GD3ZN2T6QQMKLAGKKMWHHY4FITANVJBTREEJERHTWGWF2GSBPOSHGCLU',
    sequence: '183565459124437118',
    operationId: '279341219778498624',
    balanceId: '0000000072a68b8e27e7aad6fcfaea98d8ffc4a5428d3c4d88c340bca82ad76daf5c35b0',
  },
];

test('claimableBalanceId reproduces the ids Horizon reports', () => {
  for (const { source, sequence, operationId, balanceId } of MAINNET) {
    assert.equal(claimableBalanceId(source, sequence, operationId), balanceId, operationId);
  }
});

test('operationIndex is the 0-based position from the TOID', () => {
  assert.equal(operationIndex('279341181123747842'), 1);
  assert.equal(operationIndex('279341219778498624'), 63);
  // The first operation of a transaction has TOID op index 1.
  assert.equal(operationIndex(String((1n << 32n) | (1n << 12n) | 1n)), 0);
});
