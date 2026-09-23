/**
 * The indexer's HTTP surface: `/health`, `/ready` and `/metrics`.
 *
 * The indexer is a polling loop with no server of its own, which meant nothing
 * outside the process could tell a working one from a wedged one — Docker's
 * healthcheck could only observe that PID 1 had not exited. A loop that is
 * running but no longer making progress is the failure that actually happens,
 * and it looks identical to a healthy one from the outside.
 *
 * So health here is defined as *progress*, not liveness: the check fails when
 * no ledger has been indexed for longer than a threshold, or when lag exceeds
 * one. Those are the two conditions worth paging on.
 */
import { createServer, type Server } from 'http';
import type { Pool } from 'pg';
import { metricsContentType, renderMetrics } from './metrics';
import { subsystem } from './logger';

const log = subsystem('health');

export interface HealthThresholds {
  /**
   * Seconds without a successfully indexed ledger before the service reports
   * unhealthy. Defaults to 60s — comfortably more than Stellar's ~5s ledger
   * close time plus a slow Horizon page, so it does not flap.
   */
  maxSecondsSinceIndex: number;
  /** Ledgers behind Horizon before reporting unhealthy. */
  maxLagLedgers: number;
  /**
   * Seconds after startup within which the service tolerates having never
   * indexed anything. Defaults to 300s (5 minutes) — long enough for a real
   * cold start, but prevents a misconfigured service from reporting healthy
   * indefinitely. Once this window closes and the indexer still has not
   * indexed anything, the service reports degraded.
   */
  startToleranceSeconds: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  maxSecondsSinceIndex: Number(process.env.HEALTH_MAX_SECONDS_SINCE_INDEX ?? 60),
  maxLagLedgers: Number(process.env.HEALTH_MAX_LAG_LEDGERS ?? 20),
  startToleranceSeconds: Number(process.env.HEALTH_START_TOLERANCE_SECONDS ?? 300),
};

export interface IndexerState {
  latestIndexedLedger: number;
  latestHorizonLedger: number;
  /** Unix ms of the last successful index, or null if none yet. */
  lastIndexedAt: number | null;
  startedAt: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'starting';
  uptimeSeconds: number;
  latestIndexedLedger: number;
  latestHorizonLedger: number;
  lagLedgers: number;
  secondsSinceLastIndex: number | null;
  database: 'ok' | 'unreachable';
  checks: { name: string; ok: boolean; detail?: string }[];
}

/**
 * Build a health report from live state.
 *
 * Before the first ledger lands the status is `starting` rather than
 * `degraded`: a service that has not finished booting is not broken, and
 * reporting it as broken teaches people to ignore the signal.
 */
export async function buildHealthReport(
  state: IndexerState,
  pool: Pool | null,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
  now: number = Date.now()
): Promise<HealthReport> {
  const checks: HealthReport['checks'] = [];

  let database: HealthReport['database'] = 'ok';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      checks.push({ name: 'database', ok: true });
    } catch (err) {
      database = 'unreachable';
      checks.push({
        name: 'database',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const secondsSinceLastIndex =
    state.lastIndexedAt === null ? null : (now - state.lastIndexedAt) / 1000;

  const lagLedgers = Math.max(0, state.latestHorizonLedger - state.latestIndexedLedger);

  const uptimeSeconds = (now - state.startedAt) / 1000;
  const startingTolerance = uptimeSeconds <= thresholds.startToleranceSeconds;
  const starting = state.lastIndexedAt === null && startingTolerance;
  const neverIndexedButExpired = state.lastIndexedAt === null && !startingTolerance;

  const freshnessOk =
    secondsSinceLastIndex === null ? !neverIndexedButExpired : secondsSinceLastIndex <= thresholds.maxSecondsSinceIndex;
  checks.push({
    name: 'indexing-freshness',
    ok: freshnessOk,
    detail: freshnessOk
      ? undefined
      : neverIndexedButExpired
        ? `no ledger indexed for ${Math.round(uptimeSeconds)}s; start tolerance window closed after ${thresholds.startToleranceSeconds}s`
        : `no ledger indexed for ${Math.round(secondsSinceLastIndex!)}s (threshold ${thresholds.maxSecondsSinceIndex}s)`,
  });

  // Lag is meaningless before the first ledger lands — at boot the indexer is
  // "behind" by the entire chain — so the check is reported but not counted
  // while starting.
  const lagOk = starting || lagLedgers <= thresholds.maxLagLedgers;
  checks.push({
    name: 'indexing-lag',
    ok: lagOk,
    detail: lagOk ? undefined : `${lagLedgers} ledgers behind (threshold ${thresholds.maxLagLedgers})`,
  });

  // A failing check outranks `starting`. A service that cannot reach its
  // database will never finish starting, and reporting it as merely booting
  // leaves an orchestrator waiting on a fault instead of surfacing it.
  const failing = checks.some(check => !check.ok);
  const status: HealthReport['status'] = failing ? 'degraded' : starting ? 'starting' : 'ok';

  return {
    status,
    uptimeSeconds: Math.round(uptimeSeconds),
    latestIndexedLedger: state.latestIndexedLedger,
    latestHorizonLedger: state.latestHorizonLedger,
    lagLedgers,
    secondsSinceLastIndex,
    database,
    checks,
  };
}

/**
 * HTTP status for a report.
 *
 * `starting` answers 200 so an orchestrator does not kill a service that is
 * still catching up on first boot; `/ready` is the endpoint that distinguishes
 * them, which is the split Kubernetes expects between liveness and readiness.
 */
export function healthStatusCode(report: HealthReport): number {
  return report.status === 'degraded' ? 503 : 200;
}

export interface HealthServerOptions {
  port: number;
  getState: () => IndexerState;
  pool: Pool | null;
  thresholds?: HealthThresholds;
}

export function startHealthServer(options: HealthServerOptions): Server {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (url === '/metrics') {
      renderMetrics()
        .then(body => {
          res.writeHead(200, { 'Content-Type': metricsContentType() });
          res.end(body);
        })
        .catch(err => {
          log.error({ err: err instanceof Error ? err.message : err }, 'failed to render metrics');
          res.writeHead(500).end('metrics unavailable');
        });
      return;
    }

    if (url === '/health' || url === '/ready') {
      buildHealthReport(options.getState(), options.pool, options.thresholds)
        .then(report => {
          // /ready is stricter: it refuses traffic until the first ledger has
          // landed, where /health tolerates a service still starting up.
          const code =
            url === '/ready' && report.status !== 'ok' ? 503 : healthStatusCode(report);
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(report, null, 2));
        })
        .catch(err => {
          log.error({ err: err instanceof Error ? err.message : err }, 'health check failed');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'degraded', error: 'health check failed' }));
        });
      return;
    }

    res.writeHead(404).end('not found');
  });

  server.listen(options.port, () => {
    log.info({ port: options.port }, 'health and metrics server listening');
  });

  return server;
}
