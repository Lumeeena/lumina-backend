/**
 * What the soak test watches, and how each series is judged.
 *
 * Every service already exports Node's process metrics through prom-client
 * (`collectDefaultMetrics`, with a per-service prefix), so the soak reads the
 * same numbers an operator's Prometheus would. Postgres connections are
 * counted from the other side, in `pg_stat_activity`, because a leaked
 * connection is exactly the one the service has stopped knowing about.
 */
import { detectTrend, type Sample, type TrendOptions, type TrendResult } from './trend';

const MB = 1024 * 1024;

/** The prom-client default metrics a leak moves, without the service prefix. */
export const PROCESS_METRICS = {
  rss: 'process_resident_memory_bytes',
  heap: 'nodejs_heap_size_used_bytes',
  handles: 'nodejs_active_handles_total',
  fds: 'process_open_fds',
} as const;

export type ResourceKind = keyof typeof PROCESS_METRICS | 'pgConnections';

/**
 * How much a series has to rise, over the run, before a significant sustained
 * trend counts as a leak. Memory is judged on its floor (the window minimum)
 * because a collector saws it up and down; counts on the window median.
 */
export const THRESHOLDS: Record<ResourceKind, Pick<TrendOptions, 'aggregate' | 'minIncrease' | 'minRelativeIncrease'>> = {
  rss: { aggregate: 'min', minIncrease: 16 * MB, minRelativeIncrease: 0.1 },
  heap: { aggregate: 'min', minIncrease: 8 * MB, minRelativeIncrease: 0.1 },
  handles: { aggregate: 'median', minIncrease: 5, minRelativeIncrease: 0.2 },
  fds: { aggregate: 'median', minIncrease: 5, minRelativeIncrease: 0.2 },
  pgConnections: { aggregate: 'median', minIncrease: 2, minRelativeIncrease: 0 },
};

/** The value of an unlabelled metric in Prometheus text format, or null if it is absent. */
export function metricValue(text: string, name: string): number | null {
  const match = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.eE+-]+)$`, 'm'));
  return match ? Number(match[1]) : null;
}

export interface Target {
  /** Name in the report, e.g. `indexer`. */
  name: string;
  /** Returns the service's /metrics body, or null if it did not answer. */
  scrape: () => Promise<string | null>;
  /** The prefix the service gives its default metrics, e.g. `lumina_indexer_`. */
  prefix: string;
}

export class ResourceSampler {
  readonly series = new Map<string, { target: string; kind: ResourceKind; samples: Sample[] }>();
  /** Scrapes that got no answer: a service that stops answering is a finding too. */
  readonly missed = new Map<string, number>();
  private readonly startedAt = Date.now();

  constructor(
    private readonly targets: Target[],
    private readonly connections?: () => Promise<Record<string, number>>,
    /** Maps a target to the Postgres application_name its connections carry. */
    private readonly applicationOf: (target: string) => string = target => target
  ) {}

  private record(target: string, kind: ResourceKind, t: number, v: number): void {
    const key = `${target}.${kind}`;
    const entry = this.series.get(key) ?? { target, kind, samples: [] };
    entry.samples.push({ t, v });
    this.series.set(key, entry);
  }

  async sample(): Promise<void> {
    const t = Date.now() - this.startedAt;
    await Promise.all(this.targets.map(async target => {
      const text = await target.scrape();
      if (text === null) {
        this.missed.set(target.name, (this.missed.get(target.name) ?? 0) + 1);
        return;
      }
      for (const [kind, metric] of Object.entries(PROCESS_METRICS) as Array<[ResourceKind, string]>) {
        const v = metricValue(text, `${target.prefix}${metric}`);
        if (v !== null) this.record(target.name, kind, t, v);
      }
    }));
    if (this.connections) {
      const counts = await this.connections().catch(() => null);
      if (counts) {
        for (const target of this.targets) this.record(target.name, 'pgConnections', t, counts[this.applicationOf(target.name)] ?? 0);
      }
    }
  }
}

export interface Judgement extends TrendResult {
  series: string;
  first: number;
  last: number;
}

export function judge(sampler: ResourceSampler, warmupMs: number, windows: number): Judgement[] {
  return [...sampler.series.entries()].map(([key, { kind, samples }]) => ({
    series: key,
    first: samples[0]?.v ?? 0,
    last: samples[samples.length - 1]?.v ?? 0,
    ...detectTrend(samples, { warmupMs, windows, alpha: 0.05, ...THRESHOLDS[kind] }),
  }));
}

/** Bytes as MB, counts as they are: for the report. */
export function formatValue(series: string, v: number): string {
  return /\.(rss|heap)$/.test(series) ? `${(v / MB).toFixed(1)} MB` : String(Math.round(v * 10) / 10);
}
