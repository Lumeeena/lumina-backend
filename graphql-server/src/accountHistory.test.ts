import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountHistoryError, parseAsOfLedger } from './accountHistory';

test('parseAsOfLedger accepts a positive ledger sequence', () => {
  assert.equal(parseAsOfLedger(1), 1);
  assert.equal(parseAsOfLedger(52_000_000), 52_000_000);
});

test('parseAsOfLedger rejects zero, negatives and non-integers with a message naming the value', () => {
  for (const bad of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => parseAsOfLedger(bad),
      (err: unknown) =>
        err instanceof AccountHistoryError && /asOfLedger must be a ledger sequence of 1 or more/.test(err.message)
    );
  }
});
