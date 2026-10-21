import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLedgerCountDiscrepancies, verifyAndRepairLedgerCounts } from './ledgerIntegrity';

test('reports a transaction row removed from an indexed ledger', () => {
  assert.deepEqual(
    findLedgerCountDiscrepancies(
      { transactions: 4, operations: 9 },
      { transactions: 3, operations: 9 }
    ),
    [{ entity: 'transactions', expected: 4, actual: 3 }]
  );
});

test('reports a missing operation row and ignores matching counts', () => {
  assert.deepEqual(
    findLedgerCountDiscrepancies(
      { transactions: 4, operations: 9 },
      { transactions: 4, operations: 8 }
    ),
    [{ entity: 'operations', expected: 9, actual: 8 }]
  );
  assert.deepEqual(
    findLedgerCountDiscrepancies(
      { transactions: 4, operations: 9 },
      { transactions: 4, operations: 9 }
    ),
    []
  );
});

test('repairs a missing indexed row and verifies the reread counts', async () => {
  let actual = { transactions: 3, operations: 9 };
  let repairAttempts = 0;
  let countReads = 0;

  const result = await verifyAndRepairLedgerCounts(
    { transactions: 4, operations: 9 },
    actual,
    async () => {
      repairAttempts++;
      actual = { transactions: 4, operations: 9 };
      return true;
    },
    async () => {
      countReads++;
      return actual;
    }
  );

  assert.deepEqual(result.detected, [{ entity: 'transactions', expected: 4, actual: 3 }]);
  assert.deepEqual(result.remaining, []);
  assert.equal(result.repairSucceeded, true);
  assert.equal(repairAttempts, 1);
  assert.equal(countReads, 1);
});

test('keeps a mismatch visible when a repair attempt does not reconcile counts', async () => {
  const result = await verifyAndRepairLedgerCounts(
    { transactions: 4, operations: 9 },
    { transactions: 3, operations: 9 },
    async () => false,
    async () => ({ transactions: 3, operations: 9 })
  );

  assert.deepEqual(result.remaining, [{ entity: 'transactions', expected: 4, actual: 3 }]);
  assert.equal(result.repairSucceeded, false);
});