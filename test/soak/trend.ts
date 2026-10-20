/**
 * Is a resource growing, or just moving?
 *
 * A leak in a long-running service shows up long before it crashes anything,
 * but not as a big number: as a floor that keeps rising. Heap and RSS saw up
 * and down with every garbage collection, a connection pool grows to its
 * ceiling under load, a cache fills to its bound. None of those is a leak, and
 * a check that compared the last sample with the first would call every one of
 * them one. So the series is cut into equal-time windows after a warm-up, each
 * window is reduced to one number — its minimum for a value a GC saws (the
 * floor the collector cannot get below), its median for a count — and the
 * windows are tested for a trend that is:
 *
 * - **significant** — a one-sided Mann–Kendall test on the window values, so a
 *   wobble is not a trend;
 * - **material** — the Theil–Sen estimate of the rise across the run is above a
 *   threshold, so a statistically real kilobyte is not a failure;
 * - **sustained** — still rising materially in the second half of the run, so something
 *   that grew once and stopped (a cache reaching its bound, a pool reaching its
 *   ceiling) is not reported as growing.
 *
 * All three, or the series is stable.
 */

export interface Sample {
  /** Milliseconds since the run started. */
  t: number;
  v: number;
}

export interface TrendOptions {
  /** Samples earlier than this are discarded: start-up growth is growth that stops. */
  warmupMs: number;
  /** How many equal-time windows the rest of the run is cut into. */
  windows: number;
  /** `min` for a value a collector saws up and down, `median` for a count. */
  aggregate: 'min' | 'median';
  /** A rise smaller than this, across the whole run, is not a leak whatever its shape. */
  minIncrease: number;
  /** ...nor one smaller than this fraction of the first window's level. */
  minRelativeIncrease: number;
  /** Mann–Kendall significance required, one-sided. */
  alpha: number;
}

export const DEFAULT_TREND: Omit<TrendOptions, 'aggregate' | 'minIncrease' | 'minRelativeIncrease'> = {
  warmupMs: 0,
  windows: 8,
  alpha: 0.05,
};

export interface TrendResult {
  verdict: 'stable' | 'rising' | 'insufficient-data';
  /** One value per window, in order. */
  levels: number[];
  /** Theil–Sen estimate of the rise from the first window to the last. */
  increase: number;
  /** The same estimate, per hour. */
  increasePerHour: number;
  /** One-sided Mann–Kendall p-value for an upward trend across the windows. */
  p: number;
  /** Whether the second half of the windows is still rising by a material amount. */
  stillRising: boolean;
  /** Why the verdict is what it is, in a sentence. */
  reason: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Median of the pairwise slopes: a line through the bulk of the points that one outlier cannot drag. */
export function theilSenSlope(xs: number[], ys: number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (xs[j] !== xs[i]) slopes.push((ys[j]! - ys[i]!) / (xs[j]! - xs[i]!));
    }
  }
  return slopes.length === 0 ? 0 : median(slopes);
}

/** Standard normal upper-tail probability, via the Abramowitz–Stegun erfc approximation. */
function upperTail(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * Math.exp(-x * x) * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/**
 * One-sided Mann–Kendall p-value for "this sequence increases": the normal
 * approximation with the tie-corrected variance and a continuity correction,
 * which is conservative at the handful of windows used here.
 */
export function mannKendallP(values: number[]): number {
  const n = values.length;
  if (n < 3) return 1;
  let s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) s += Math.sign(values[j]! - values[i]!);
  }
  const ties = new Map<number, number>();
  for (const v of values) ties.set(v, (ties.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const t of ties.values()) tieTerm += t * (t - 1) * (2 * t + 5);
  const variance = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  if (variance === 0) return 1;
  const z = s > 0 ? (s - 1) / Math.sqrt(variance) : s < 0 ? (s + 1) / Math.sqrt(variance) : 0;
  return upperTail(z);
}

export function detectTrend(samples: Sample[], options: TrendOptions): TrendResult {
  const kept = samples.filter(s => s.t >= options.warmupMs).sort((a, b) => a.t - b.t);
  const empty = { levels: [], increase: 0, increasePerHour: 0, p: 1, stillRising: false };
  if (kept.length < options.windows * 3) {
    return { ...empty, verdict: 'insufficient-data', reason: `${kept.length} samples after warm-up; need at least ${options.windows * 3}` };
  }

  const start = kept[0]!.t;
  const span = kept[kept.length - 1]!.t - start;
  const buckets: number[][] = Array.from({ length: options.windows }, () => []);
  for (const s of kept) {
    const index = Math.min(options.windows - 1, Math.floor(((s.t - start) / (span || 1)) * options.windows));
    buckets[index]!.push(s.v);
  }
  if (buckets.some(b => b.length === 0)) {
    return { ...empty, verdict: 'insufficient-data', reason: 'a window has no samples; sampling stopped part-way' };
  }
  const levels = buckets.map(b => (options.aggregate === 'min' ? Math.min(...b) : median(b)));
  const centres = levels.map((_, i) => start + ((i + 0.5) * span) / options.windows);

  const slope = theilSenSlope(centres, levels);
  const increase = slope * (centres[centres.length - 1]! - centres[0]!);
  const increasePerHour = slope * 3_600_000;
  const p = mannKendallP(levels);
  const threshold = Math.max(options.minIncrease, options.minRelativeIncrease * Math.abs(levels[0]!));
  // "Still rising" has to be material too: over a flat second half the slope
  // of the noise is as likely to be slightly positive as not. A steady leak
  // puts about half its rise in the second half, so half the threshold.
  const half = Math.floor(levels.length / 2);
  const secondHalf = centres.slice(half);
  const lateIncrease = theilSenSlope(secondHalf, levels.slice(half)) * (secondHalf[secondHalf.length - 1]! - secondHalf[0]!);
  const stillRising = lateIncrease >= threshold / 2;

  const result = { levels, increase, increasePerHour, p, stillRising };
  if (p >= options.alpha) {
    return { ...result, verdict: 'stable', reason: `no significant upward trend (Mann–Kendall p = ${p.toFixed(3)})` };
  }
  if (increase < threshold) {
    return { ...result, verdict: 'stable', reason: `trend of ${increase.toFixed(1)} is below the ${threshold.toFixed(1)} threshold` };
  }
  if (!stillRising) {
    return { ...result, verdict: 'stable', reason: 'rose and then levelled off: bounded growth, not a leak' };
  }
  return {
    ...result,
    verdict: 'rising',
    reason: `rose ${increase.toFixed(1)} across the run (${increasePerHour.toFixed(1)}/h), still rising at the end (p = ${p.toFixed(4)})`,
  };
}
