/**
 * The trend detector against series whose answer is known: the shapes a
 * healthy service produces, which must pass, and the shapes a leak produces,
 * which must not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTrend, mannKendallP, theilSenSlope, type Sample, type TrendOptions } from './trend';

const MB = 1024 * 1024;
const MINUTE = 60_000;

const memory: TrendOptions = { warmupMs: 5 * MINUTE, windows: 8, aggregate: 'min', minIncrease: 8 * MB, minRelativeIncrease: 0.1, alpha: 0.05 };
const count: TrendOptions = { warmupMs: 5 * MINUTE, windows: 8, aggregate: 'median', minIncrease: 2, minRelativeIncrease: 0, alpha: 0.05 };

/** Deterministic noise, so a failing case fails the same way every run. */
function noise(seed: number): () => number {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648 - 0.5;
  };
}

/** A sample every 10 s for `minutes`, valued by `f(t)`. */
function series(minutes: number, f: (t: number) => number): Sample[] {
  const out: Sample[] = [];
  for (let t = 0; t <= minutes * MINUTE; t += 10_000) out.push({ t, v: f(t) });
  return out;
}

/** A heap that climbs between collections and drops back to `floor(t)` at each one. */
function sawtooth(floor: (t: number) => number, periodMs: number, amplitude: number): (t: number) => number {
  return t => floor(t) + ((t % periodMs) / periodMs) * amplitude;
}

test('a flat, noisy value is stable', () => {
  const r = noise(1);
  const result = detectTrend(series(60, () => 120 * MB + r() * 4 * MB), memory);
  assert.equal(result.verdict, 'stable', result.reason);
});

test('a heap sawing up and down around a flat floor is stable, however large the swing', () => {
  const r = noise(2);
  const result = detectTrend(series(60, sawtooth(() => 90 * MB + r() * MB, 47_000, 60 * MB)), memory);
  assert.equal(result.verdict, 'stable', result.reason);
});

test('a sawtooth whose floor keeps rising is a leak, though no single sample is alarming', () => {
  const r = noise(3);
  // 30 MB/h retained under a 60 MB swing: the peaks hide it, the floor does not.
  const leak = sawtooth(t => 90 * MB + (t / 3_600_000) * 30 * MB + r() * MB, 47_000, 60 * MB);
  const result = detectTrend(series(60, leak), memory);
  assert.equal(result.verdict, 'rising', result.reason);
  assert.ok(result.increasePerHour > 20 * MB && result.increasePerHour < 40 * MB, `${result.increasePerHour / MB} MB/h`);
});

test('one Postgres connection leaked per reconnect is a leak', () => {
  // The bug this exists for: a reconnect every five minutes, one connection
  // left behind each time, on top of a pool that fluctuates with load.
  const r = noise(4);
  const result = detectTrend(series(60, t => 4 + Math.floor(t / (5 * MINUTE)) + Math.round(r() * 2)), count);
  assert.equal(result.verdict, 'rising', result.reason);
});

test('a pool growing to its ceiling and staying there is not a leak', () => {
  const result = detectTrend(series(60, t => Math.min(10, 2 + Math.floor(t / (3 * MINUTE)))), count);
  assert.equal(result.verdict, 'stable', result.reason);
});

test('a cache that fills to its bound part-way through is not a leak', () => {
  const r = noise(5);
  const fill = (t: number) => 80 * MB + Math.min(t, 30 * MINUTE) / (30 * MINUTE) * 40 * MB + r() * MB;
  const result = detectTrend(series(60, fill), memory);
  assert.equal(result.verdict, 'stable', result.reason);
  assert.match(result.reason, /levelled off/);
});

test('growth during warm-up is ignored', () => {
  const result = detectTrend(series(60, t => (t < 5 * MINUTE ? 50 * MB + (t / (5 * MINUTE)) * 70 * MB : 120 * MB)), memory);
  assert.equal(result.verdict, 'stable', result.reason);
});

test('a real but tiny rise is below the threshold', () => {
  const result = detectTrend(series(60, t => 120 * MB + (t / 3_600_000) * 2 * MB), memory);
  assert.equal(result.verdict, 'stable', result.reason);
  assert.match(result.reason, /below/);
});

test('a falling value is stable', () => {
  const result = detectTrend(series(60, t => 200 * MB - (t / 3_600_000) * 50 * MB), memory);
  assert.equal(result.verdict, 'stable', result.reason);
});

test('a run too short to judge says so rather than passing', () => {
  const result = detectTrend(series(6, () => 1), memory);
  assert.equal(result.verdict, 'insufficient-data');
});

test('Mann–Kendall: a strictly increasing sequence is significant, a constant one is not', () => {
  assert.ok(mannKendallP([1, 2, 3, 4, 5, 6, 7, 8]) < 0.001);
  assert.equal(mannKendallP([3, 3, 3, 3, 3, 3]), 1);
  assert.ok(mannKendallP([8, 7, 6, 5, 4, 3, 2, 1]) > 0.99);
});

test('Theil–Sen ignores one wild point that would drag a least-squares line', () => {
  assert.equal(theilSenSlope([0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 300, 4, 5, 6]), 1);
});
