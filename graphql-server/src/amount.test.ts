import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AMOUNT_DECIMALS, STROOPS_PER_UNIT, StellarAmount } from './amount';

test('an amount is stored as stroops, so no double ever touches it', () => {
  // The largest amount the protocol allows is under 2^63 stroops, which is past
  // what a double represents exactly. One stroop either side of that boundary
  // must still be distinguishable.
  const huge = '922337203685.4775807';
  const a = StellarAmount.from(huge);
  const b = StellarAmount.from('922337203685.4775806');
  assert.equal(a.toFixed(), huge);
  assert.ok(!a.equals(b));
  assert.equal(a.minus(b).toFixed(), '0.0000001');
});

test('parsing keeps every decimal place the ledger allows', () => {
  assert.equal(StellarAmount.from('0.0000001').toFixed(), '0.0000001');
  assert.equal(StellarAmount.from('1.2345678').toFixed(), '1.2345678');
  assert.equal(StellarAmount.from('-1.2345678').toFixed(), '-1.2345678');
  assert.equal(StellarAmount.from('0').toFixed(), '0');
  assert.equal(StellarAmount.from('0.0').toFixed(), '0');
  assert.equal(StellarAmount.from('+7').toFixed(), '7');
});

test('trailing zeros are trimmed and a bare integer keeps no decimal point', () => {
  assert.equal(StellarAmount.from('5.0000000').toFixed(), '5');
  assert.equal(StellarAmount.from('5.1000000').toFixed(), '5.1');
  assert.equal(StellarAmount.from('0.0000000').toFixed(), '0');
  assert.equal(StellarAmount.from('-5.0000000').toFixed(), '-5');
});

test('an amount with more precision than the ledger allows is rejected', () => {
  assert.throws(() => StellarAmount.from('1.00000001'), /more than 7 decimal places/);
});

test('exponent notation and other unparseable text are rejected rather than coerced', () => {
  // Accepting these silently would be a rounding bug wearing a parsing costume.
  assert.throws(() => StellarAmount.from('1e-7'), /Invalid Stellar amount/);
  assert.throws(() => StellarAmount.from('abc'), /Invalid Stellar amount/);
  assert.throws(() => StellarAmount.from(''), /Invalid Stellar amount/);
  assert.throws(() => StellarAmount.from('1,000'), /Invalid Stellar amount/);
});

test('a JS number is rejected because it has already lost precision', () => {
  assert.throws(() => StellarAmount.from(0.5 as unknown as string), /Invalid Stellar amount/);
  // 2^53 + 1, the first integer a double cannot name. Written as an expression
  // rather than a literal because the literal itself is the thing being warned
  // about — and that warning is exactly the reason numbers are not accepted.
  const pastDoublePrecision = 2 ** 53 + 1;
  assert.throws(() => StellarAmount.from(pastDoublePrecision as unknown as string), /Invalid Stellar amount/);
  assert.equal(StellarAmount.from(5n).toFixed(), '0.0000005');
});

test('plus and minus are exact across many operations', () => {
  // A replay adds and subtracts hundreds of times; a rounding error would creep
  // in early and be invisible in the final balance.
  let balance = StellarAmount.from('1000.0000000');
  for (let i = 0; i < 500; i++) {
    balance = balance.plus(StellarAmount.from('0.0000001')).minus(StellarAmount.from('0.0000003'));
  }
  assert.equal(balance.toFixed(), '999.9999');
});

test('the exposed scale matches the ledger, not a guess', () => {
  assert.equal(AMOUNT_DECIMALS, 7);
  assert.equal(STROOPS_PER_UNIT, 10_000_000n);
  assert.equal(StellarAmount.from('1').toFixed(), '1');
  assert.equal(StellarAmount.from(String(STROOPS_PER_UNIT)).toFixed(), '10000000');
  assert.equal(String(StellarAmount.from('3.1400000')), '3.14');
});

test('sign is reported from the stroop count', () => {
  assert.equal(StellarAmount.from('0.0000001').isPositive(), true);
  assert.equal(StellarAmount.from('-0.0000001').isPositive(), false);
  assert.equal(StellarAmount.ZERO.isPositive(), false);
});
