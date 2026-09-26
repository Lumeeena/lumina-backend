import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOG_SAMPLE_RATE,
  SuccessSampler,
  resolveSampleRate,
  routineLogger,
  type LogSink,
} from './logger';

/** Records what a logger would have written, so tests can assert on it. */
function recordingSink(): LogSink & { entries: Array<{ level: string; fields: Record<string, unknown>; message: string }> } {
  const entries: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  return {
    entries,
    info: (fields, message) => entries.push({ level: 'info', fields, message }),
    warn: (fields, message) => entries.push({ level: 'warn', fields, message }),
    error: (fields, message) => entries.push({ level: 'error', fields, message }),
  };
}

test('resolveSampleRate defaults when unset or empty', () => {
  assert.equal(resolveSampleRate(undefined).rate, DEFAULT_LOG_SAMPLE_RATE);
  assert.equal(resolveSampleRate('').rate, DEFAULT_LOG_SAMPLE_RATE);
  assert.equal(resolveSampleRate('   ').rate, DEFAULT_LOG_SAMPLE_RATE);
});

test('resolveSampleRate accepts the full 0..1 range', () => {
  assert.equal(resolveSampleRate('0').rate, 0);
  assert.equal(resolveSampleRate('1').rate, 1);
  assert.equal(resolveSampleRate('0.25').rate, 0.25);
});

test('resolveSampleRate falls back with a warning instead of throwing on a typo', () => {
  for (const bad of ['-0.1', '1.5', 'nope', 'NaN']) {
    const { rate, warning } = resolveSampleRate(bad);
    assert.equal(rate, DEFAULT_LOG_SAMPLE_RATE, `input ${bad}`);
    assert.ok(warning, `expected a warning for ${bad}`);
  }
});

test('SuccessSampler rejects an out-of-range rate', () => {
  assert.throws(() => new SuccessSampler(1.1), RangeError);
  assert.throws(() => new SuccessSampler(-1), RangeError);
});

test('rate 1 logs every routine success', () => {
  const sink = recordingSink();
  const routine = routineLogger('t', { rate: 1, random: () => 0.99, sink });

  for (let i = 0; i < 5; i++) routine.success({ ledger: i }, 'ledger indexed');

  assert.equal(sink.entries.length, 5);
  assert.equal(sink.entries.every((entry) => entry.level === 'info'), true);
});

test('rate 0 suppresses every routine success', () => {
  const sink = recordingSink();
  const routine = routineLogger('t', { rate: 0, sink });

  for (let i = 0; i < 50; i++) routine.success({ ledger: i }, 'ledger indexed');

  assert.equal(sink.entries.length, 0);
  assert.equal(routine.suppressedCount(), 50);
});

test('a sampled true emits and reports how many were dropped', () => {
  const sink = recordingSink();
  // 0.9 >= rate 0.1 -> drop, drop, then 0.05 < 0.1 -> emit
  const draws = [0.9, 0.9, 0.05];
  let call = 0;
  const routine = routineLogger('t', { rate: 0.1, random: () => draws[call++], sink });

  routine.success({ ledger: 1 }, 'ledger indexed');
  routine.success({ ledger: 2 }, 'ledger indexed');
  routine.success({ ledger: 3 }, 'ledger indexed');

  assert.equal(sink.entries.length, 1);
  assert.equal(sink.entries[0].fields.ledger, 3);
  assert.equal(sink.entries[0].fields.suppressed, 2, 'the emitted line carries the two dropped ledgers');
  assert.equal(routine.suppressedCount(), 0, 'the counter resets once it has been reported');
});

test('an emitted line omits `suppressed` when nothing was dropped', () => {
  const sink = recordingSink();
  const routine = routineLogger('t', { rate: 1, sink });

  routine.success({ ledger: 1 }, 'ledger indexed');

  assert.equal('suppressed' in sink.entries[0].fields, false);
});

test('warnings and errors are never sampled, even at rate 0', () => {
  const sink = recordingSink();
  const routine = routineLogger('t', { rate: 0, sink });

  for (let i = 0; i < 25; i++) routine.success({ ledger: i }, 'ledger indexed');
  routine.warn({ ledger: 25 }, 'ledger failed, retrying');
  routine.error({ ledger: 26 }, 'giving up on ledger');
  routine.info({ ledger: 27 }, 'starting from latest ledger');

  const levels = sink.entries.map((entry) => entry.level);
  assert.deepEqual(levels, ['warn', 'error', 'info']);
  assert.equal(sink.entries[0].fields.ledger, 25);
  assert.equal(sink.entries[1].fields.ledger, 26);
});

test('sampling decisions are independent per logger', () => {
  const noisy = recordingSink();
  const quiet = recordingSink();
  const a = routineLogger('a', { rate: 1, sink: noisy });
  const b = routineLogger('b', { rate: 0, sink: quiet });

  a.success({ n: 1 }, 'ledger indexed');
  b.success({ n: 1 }, 'ledger indexed');

  assert.equal(noisy.entries.length, 1);
  assert.equal(quiet.entries.length, 0);
});

test('the default rate is low enough to cut steady-state volume', () => {
  // 1% of ~17k ledgers/day is ~170 lines instead of ~17k.
  assert.ok(DEFAULT_LOG_SAMPLE_RATE > 0 && DEFAULT_LOG_SAMPLE_RATE < 0.05);
});
