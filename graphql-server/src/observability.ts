/**
 * The GraphQL server's observability wiring: an Apollo plugin that records
 * every operation, and the `/health` report.
 *
 * Health here means "can this process actually serve a query", which is why the
 * check runs a real `SELECT 1` rather than answering 200 because the event loop
 * is turning. A server that is up but cannot reach Postgres answers every query
 * with an error, and a health check that calls that healthy is worse than no
 * health check — it removes the signal while looking like it provides one.
 */
import type { ApolloServerPlugin, GraphQLRequestListener } from '@apollo/server';
import type { Pool } from 'pg';
import {
  dbPoolIdle,
  dbPoolTotal,
  dbPoolWaiting,
  graphqlOperationDuration,
  graphqlOperations,
} from './metrics';
import type { Context } from './resolvers';

/** Records counts and latency per operation name. */
export function metricsPlugin(): ApolloServerPlugin<Context> {
  return {
    async requestDidStart(): Promise<GraphQLRequestListener<Context>> {
      const start = process.hrtime.bigint();

      return {
        async willSendResponse(requestContext) {
          // An unnamed operation is real traffic and has to be counted; the
          // label just cannot be the query text, which would explode
          // cardinality.
          const operation = requestContext.operationName ?? 'anonymous';
          const type = requestContext.operation?.operation ?? 'unknown';
          const failed = (requestContext.errors?.length ?? 0) > 0;

          const seconds = Number(process.hrtime.bigint() - start) / 1e9;
          graphqlOperationDuration.observe({ operation, type }, seconds);
          graphqlOperations.inc({ operation, type, outcome: failed ? 'error' : 'ok' });

        },
      };
    },
  };
}

/**
 * Sample the connection pool.
 *
 * Read on demand rather than on a timer, so the numbers in a scrape are the
 * numbers at scrape time and there is no background interval to leak.
 */
export function samplePool(pool: Pool): void {
  // These are documented pg.Pool properties but not in every @types/pg version.
  const stats = pool as unknown as { totalCount?: number; idleCount?: number; waitingCount?: number };
  dbPoolTotal.set(stats.totalCount ?? 0);
  dbPoolIdle.set(stats.idleCount ?? 0);
  dbPoolWaiting.set(stats.waitingCount ?? 0);
}

export interface ServerHealthReport {
  status: 'ok' | 'degraded';
  /**
   * Service version. A release `v<version>` carries the GraphQL schema this
   * process serves (docs/API_GUIDE.md "API Versioning").
   */
  version?: string;
  uptimeSeconds: number;
  database: 'ok' | 'unreachable';
  listener: 'connected' | 'disconnected' | 'not-configured';
  subscriptions: number;
  checks: { name: string; ok: boolean; detail?: string }[];
}

export interface HealthInputs {
  pool: Pool;
  startedAt: number;
  version?: string;
  listenerConnected?: boolean | null;
  subscriptionCount?: number;
}

export async function buildServerHealth(inputs: HealthInputs, now = Date.now()): Promise<ServerHealthReport> {
  const checks: ServerHealthReport['checks'] = [];

  let database: ServerHealthReport['database'] = 'ok';
  try {
    await inputs.pool.query('SELECT 1');
    checks.push({ name: 'database', ok: true });
  } catch (err) {
    database = 'unreachable';
    checks.push({
      name: 'database',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  let listener: ServerHealthReport['listener'] = 'not-configured';
  if (inputs.listenerConnected !== undefined && inputs.listenerConnected !== null) {
    listener = inputs.listenerConnected ? 'connected' : 'disconnected';
    // Deliberately not fatal: queries still work without the listener, and
    // failing the whole health check would take a serving process out of
    // rotation over a degraded extra. It reconnects on its own.
    checks.push({
      name: 'listener',
      ok: true,
      detail: inputs.listenerConnected ? undefined : 'reconnecting; subscriptions are paused',
    });
  }

  return {
    status: checks.every(check => check.ok) ? 'ok' : 'degraded',
    ...(inputs.version ? { version: inputs.version } : {}),
    uptimeSeconds: Math.round((now - inputs.startedAt) / 1000),
    database,
    listener,
    subscriptions: inputs.subscriptionCount ?? 0,
    checks,
  };
}

export function serverHealthStatusCode(report: ServerHealthReport): number {
  return report.status === 'ok' ? 200 : 503;
}
