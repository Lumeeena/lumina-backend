/**
 * Structured logging.
 *
 * `pino` has been an indexer dependency since the beginning and was never
 * imported — everything went through `console.log` with values interpolated
 * into strings. That is the difference between grepping for a ledger number and
 * querying for one, and it is part of why a Horizon rate-limiting incident took
 * a live debugging session rather than showing up in a filter.
 *
 * So values are passed as *fields*, never interpolated:
 *
 *     log.warn({ ledger, status: 429 }, 'horizon request throttled')
 *
 * not `console.warn(\`throttled on ledger \${ledger}\`)`.
 */
import pino from 'pino';

/**
 * `LOG_LEVEL` controls verbosity; `LOG_PRETTY=true` switches to human-readable
 * output for local runs. JSON is the default because that is what a log
 * aggregator ingests, and a developer can always opt out.
 */
const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_PRETTY === 'true';

export const logger = pino({
  level,
  base: { service: 'lumina-indexer' },
  // Seconds-since-epoch as a number is what Prometheus and most aggregators
  // expect; pino's default is milliseconds.
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(pretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});

/** A child logger tagged with the subsystem it belongs to. */
export function subsystem(name: string) {
  return logger.child({ subsystem: name });
}

/**
 * Fraction of routine success logs that are emitted. The rest are counted and
 * summarised on the next emitted log, so the signal survives even though the
 * volume does not.
 *
 * Why sample at all: the 5s ledger poll makes routine success the single
 * highest-volume source in the indexer. At ~17k ledgers/day, one info line per
 * ledger (and one per contract-event batch on top) costs real money in a log
 * aggregator and buries the lines that matter — the warnings and errors this
 * module deliberately never samples. `metrics.ts` already carries the
 * ledger/event counters, so the sampled logs are for humans reading a log
 * stream, not for measurement.
 */
export const DEFAULT_LOG_SAMPLE_RATE = 0.01;

/**
 * Reads `LOG_SAMPLE_RATE`, a number between 0 and 1:
 *
 *   unset / empty -> DEFAULT_LOG_SAMPLE_RATE
 *   1             -> log every routine success (sampling off)
 *   0             -> log none of them (warnings and errors still emitted)
 *
 * An unusable value falls back to the default and reports why, rather than
 * throwing: a typo in an environment variable must not stop the indexer from
 * starting.
 */
export function resolveSampleRate(
  raw: string | undefined = process.env.LOG_SAMPLE_RATE,
): { rate: number; warning?: string } {
  if (raw === undefined || raw.trim() === '') return { rate: DEFAULT_LOG_SAMPLE_RATE };

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return {
      rate: DEFAULT_LOG_SAMPLE_RATE,
      warning:
        `LOG_SAMPLE_RATE=${JSON.stringify(raw)} is not a number between 0 and 1; ` +
        `falling back to ${DEFAULT_LOG_SAMPLE_RATE}`,
    };
  }
  return { rate: parsed };
}

/**
 * Decides which routine success logs are emitted.
 *
 * Deliberately its own class, with the randomness injectable, so the decision is
 * unit-testable without depending on `Math.random` or on reading a log stream
 * back.
 */
export class SuccessSampler {
  private suppressed = 0;

  constructor(
    private readonly rate: number,
    private readonly random: () => number = Math.random,
  ) {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new RangeError(`sample rate must be between 0 and 1, got ${rate}`);
    }
  }

  /**
   * Counts one routine success and reports whether to emit it.
   *
   * An emitted log carries `suppressed`, the number of successes dropped since
   * the previous emitted one, so a sampled stream still shows how much work
   * happened rather than implying it did not.
   */
  record(): { emit: boolean; suppressed: number } {
    if (this.rate >= 1) return { emit: true, suppressed: this.takeSuppressed() };
    if (this.rate <= 0) {
      this.suppressed += 1;
      return { emit: false, suppressed: 0 };
    }

    if (this.random() < this.rate) return { emit: true, suppressed: this.takeSuppressed() };

    this.suppressed += 1;
    return { emit: false, suppressed: 0 };
  }

  /** Routine successes dropped since the last emitted one. */
  suppressedCount(): number {
    return this.suppressed;
  }

  private takeSuppressed(): number {
    const count = this.suppressed;
    this.suppressed = 0;
    return count;
  }
}

/** Minimal shape of the pino logger this module writes through. */
export interface LogSink {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * A subsystem logger for the routine success path.
 *
 * `success()` is sampled; `info()`, `warn()` and `error()` are not. That split is
 * the whole point of the type: there is no way to log a warning or an error
 * through the sampled method, so a future call site cannot accidentally start
 * dropping failures to save volume. `indexer/src/logger.test.ts` pins that
 * guarantee.
 */
export interface RoutineLogger {
  success(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  suppressedCount(): number;
}

export function routineLogger(
  name: string,
  options: { rate?: number; random?: () => number; sink?: LogSink } = {},
): RoutineLogger {
  const { rate, warning } = options.rate === undefined
    ? resolveSampleRate()
    : { rate: options.rate, warning: undefined };
  if (warning) logger.warn({ subsystem: name }, warning);

  const sink: LogSink = options.sink ?? logger.child({ subsystem: name });
  const sampler = new SuccessSampler(rate, options.random);

  return {
    success(fields, message) {
      const { emit, suppressed } = sampler.record();
      if (!emit) return;
      sink.info({ ...fields, ...(suppressed > 0 ? { suppressed } : {}) }, message);
    },
    info: (fields, message) => sink.info(fields, message),
    warn: (fields, message) => sink.warn(fields, message),
    error: (fields, message) => sink.error(fields, message),
    suppressedCount: () => sampler.suppressedCount(),
  };
}
