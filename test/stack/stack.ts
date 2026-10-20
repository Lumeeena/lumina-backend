/**
 * The whole stack, running: Postgres, the indexer, the GraphQL server, and
 * stand-ins for Horizon and Soroban RPC that can be made to fail.
 *
 * The services are the built `dist/` of each workspace, started as separate
 * processes under the restart policy the deployment uses (supervisor.ts), so
 * what fails and what recovers is the code that ships. Postgres is real — the
 * database named by TEST_DATABASE_URL, where each stack creates and later drops
 * a database of its own — and the services reach it through a fault proxy.
 * The harness watches the database directly, never through the proxy, so it
 * can still see what the services cannot.
 */
import { mkdirSync, readFileSync, existsSync } from 'fs';
import { createServer } from 'net';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { StrKey } from '@stellar/stellar-sdk';
import { FakeHorizon, type FakeHorizonOptions } from './fakeHorizon';
import { FakeSorobanRpc } from './fakeSorobanRpc';
import { TcpFaultProxy } from './faultProxy';
import { SupervisedService } from './supervisor';

export const REPO_ROOT = resolve(__dirname, '..', '..');
const NETWORK = 'mainnet';

export interface StackOptions {
  /** Labels the database and the log directory. */
  name: string;
  chain?: Partial<FakeHorizonOptions>;
  indexerEnv?: Record<string, string>;
  graphqlEnv?: Record<string, string>;
  /** Where service logs go; defaults to test/.artifacts/<name>. */
  artifactsDir?: string;
}

export function adminDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL is not set; it must name a Postgres the stack can create databases on');
  return url;
}

/**
 * Applies db/schema.sql the way psql does. A multi-statement query is one
 * implicit transaction, which `CREATE INDEX CONCURRENTLY` refuses to run in,
 * so those statements are lifted out and run on their own afterwards.
 */
export async function applySchema(pool: Pool): Promise<void> {
  const sql = readFileSync(join(REPO_ROOT, 'db', 'schema.sql'), 'utf8');
  const concurrent = sql.match(/^CREATE INDEX CONCURRENTLY[^;]*;/gm) ?? [];
  await pool.query(concurrent.reduce((rest, statement) => rest.replace(statement, ''), sql));
  for (const statement of concurrent) await pool.query(statement);
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!address || typeof address !== 'object') throw new Error('could not allocate a port');
  return address.port;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/** Polls `check` until it returns true. Resolves to the time it took; rejects with `what` on timeout. */
export async function waitFor(
  what: string,
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 250
): Promise<number> {
  const started = Date.now();
  for (;;) {
    try {
      if (await check()) return Date.now() - started;
    } catch {
      // A check that throws has not passed yet; the dependency may still be down.
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

export interface HttpResult {
  status: number | null;
  body: unknown;
  error?: string;
}

export async function httpJson(url: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<HttpResult> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON (a metrics page, an HTML error); keep the text.
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: null, body: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A websocket subscriber that behaves like a real client: it reconnects when
 * the connection drops, and counts what it receives. Speaks the
 * graphql-transport-ws protocol the server uses (graphql-ws) directly over `ws`.
 */
export class SubscriptionProbe {
  received = 0;
  lastReceivedAt = 0;
  disconnects = 0;
  private socket: WebSocket | null = null;
  private closed = false;

  constructor(private readonly url: string, private readonly query: string) {}

  start(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.url, 'graphql-transport-ws');
    this.socket = socket;
    let opened = false;
    socket.on('open', () => {
      opened = true;
      socket.send(JSON.stringify({ type: 'connection_init' }));
    });
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as { type: string };
      if (message.type === 'connection_ack') {
        socket.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: this.query } }));
      } else if (message.type === 'next') {
        this.received++;
        this.lastReceivedAt = Date.now();
      } else if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closed) return;
      // A refused connect is a retry, not a lost subscription.
      if (opened) this.disconnects++;
      setTimeout(() => this.start(), 1_000);
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.terminate();
    this.socket = null;
  }
}

export class Stack {
  readonly horizon: FakeHorizon;
  readonly rpc: FakeSorobanRpc;
  readonly proxy: TcpFaultProxy;
  readonly observer: Pool;
  readonly indexer: SupervisedService;
  readonly graphql: SupervisedService;
  readonly startedAt = Date.now();

  private constructor(
    readonly name: string,
    readonly database: string,
    readonly artifactsDir: string,
    readonly indexerHealthPort: number,
    readonly graphqlPort: number,
    parts: {
      horizon: FakeHorizon;
      rpc: FakeSorobanRpc;
      proxy: TcpFaultProxy;
      observer: Pool;
      indexer: SupervisedService;
      graphql: SupervisedService;
    }
  ) {
    this.horizon = parts.horizon;
    this.rpc = parts.rpc;
    this.proxy = parts.proxy;
    this.observer = parts.observer;
    this.indexer = parts.indexer;
    this.graphql = parts.graphql;
  }

  static async start(options: StackOptions): Promise<Stack> {
    for (const workspace of ['indexer', 'graphql-server']) {
      if (!existsSync(join(REPO_ROOT, workspace, 'dist', 'index.js'))) {
        throw new Error(`${workspace}/dist/index.js is missing; run "npm run build" first`);
      }
    }
    const admin = new URL(adminDatabaseUrl());
    const database = `lumina_${options.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${process.pid}`;
    const artifactsDir = options.artifactsDir ?? join(REPO_ROOT, 'test', '.artifacts', options.name);
    mkdirSync(artifactsDir, { recursive: true });

    const adminPool = new Pool({ connectionString: admin.toString(), max: 1 });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await adminPool.query(`CREATE DATABASE ${database}`);
    } finally {
      await adminPool.end();
    }
    const direct = new URL(admin.toString());
    direct.pathname = `/${database}`;
    const observer = new Pool({ connectionString: direct.toString(), max: 4, application_name: 'lumina-harness' });
    await applySchema(observer);

    const horizon = new FakeHorizon({ ledgerIntervalMs: 1_000, ...options.chain });
    await horizon.listen();
    const contractId = StrKey.encodeContract(createHash('sha256').update('lumina-fake-contract').digest());
    const rpc = new FakeSorobanRpc(horizon, contractId);
    await rpc.listen();
    const proxy = new TcpFaultProxy(admin.hostname, Number(admin.port || 5432));
    await proxy.listen();

    const viaProxy = (application: string) => {
      const url = new URL(direct.toString());
      url.hostname = '127.0.0.1';
      url.port = String(proxy.port);
      url.searchParams.set('application_name', application);
      return url.toString();
    };
    const indexerHealthPort = await freePort();
    const graphqlPort = await freePort();

    const indexer = new SupervisedService({
      name: 'indexer',
      command: process.execPath,
      args: ['dist/index.js'],
      cwd: join(REPO_ROOT, 'indexer'),
      logFile: join(artifactsDir, 'indexer.log'),
      env: {
        DATABASE_URL: viaProxy('lumina-indexer'),
        HORIZON_URL: horizon.url,
        SOROBAN_RPC_URL: rpc.url,
        INDEXED_CONTRACT_IDS: contractId,
        START_LEDGER: String(horizon.options.startLedger),
        POLL_INTERVAL_MS: '500',
        HEALTH_PORT: String(indexerHealthPort),
        HORIZON_MIN_REQUEST_INTERVAL_MS: '5',
        HORIZON_REQUEST_TIMEOUT_MS: '3000',
        SOROBAN_MIN_REQUEST_INTERVAL_MS: '5',
        LOG_LEVEL: 'info',
        ...options.indexerEnv,
      },
    });
    const graphql = new SupervisedService({
      name: 'graphql',
      command: process.execPath,
      args: ['dist/index.js'],
      cwd: join(REPO_ROOT, 'graphql-server'),
      logFile: join(artifactsDir, 'graphql.log'),
      env: {
        DATABASE_URL: viaProxy('lumina-graphql'),
        PORT: String(graphqlPort),
        HORIZON_URL: horizon.url,
        HORIZON_REQUEST_TIMEOUT_MS: '3000',
        LOG_LEVEL: 'info',
        ...options.graphqlEnv,
      },
    });

    const stack = new Stack(options.name, database, artifactsDir, indexerHealthPort, graphqlPort, {
      horizon, rpc, proxy, observer, indexer, graphql,
    });
    indexer.start();
    graphql.start();
    return stack;
  }

  get graphqlUrl(): string {
    return `http://127.0.0.1:${this.graphqlPort}`;
  }

  // ─── Observations, made directly against Postgres ───────────────────────────

  async ledgers(): Promise<{ count: number; min: number; max: number; gaps: number }> {
    const { rows: [row] } = await this.observer.query<{ count: string; min: string | null; max: string | null }>(
      'SELECT count(*) AS count, min(sequence) AS min, max(sequence) AS max FROM ledgers WHERE network = $1',
      [NETWORK]
    );
    const count = Number(row!.count);
    const min = Number(row!.min ?? 0);
    const max = Number(row!.max ?? 0);
    return { count, min, max, gaps: count === 0 ? 0 : max - min + 1 - count };
  }

  /** Ledgers recorded as failed or queued for retry — work the indexer still owes. */
  async owedLedgers(): Promise<number> {
    const { rows: [row] } = await this.observer.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM ledger_retry_queue WHERE network = $1)
            + (SELECT count(*) FROM failed_ledgers WHERE network = $1) AS n`,
      [NETWORK]
    );
    return Number(row!.n);
  }

  /** Open backends per application_name, for this stack's database only. */
  async connections(): Promise<Record<string, number>> {
    const { rows } = await this.observer.query<{ application_name: string; n: string }>(
      `SELECT application_name, count(*) AS n FROM pg_stat_activity
        WHERE datname = $1 AND application_name LIKE 'lumina-%' AND application_name <> 'lumina-harness'
        GROUP BY application_name ORDER BY application_name`,
      [this.database]
    );
    return Object.fromEntries(rows.map(r => [r.application_name, Number(r.n)]));
  }

  /**
   * Terminates the services' backends, as a Postgres restart or failover would.
   * `sparingLeader` leaves the connection holding the indexer's leader lock, so
   * the pools and the LISTEN connection reconnect without the indexer exiting.
   * Returns how many were terminated.
   */
  async terminateBackends(options: { sparingLeader?: boolean } = {}): Promise<number> {
    const { rows } = await this.observer.query<{ pid: number }>(
      `SELECT pg_terminate_backend(pid) AS terminated, pid FROM pg_stat_activity
        WHERE datname = $1 AND application_name LIKE 'lumina-%' AND application_name <> 'lumina-harness'
          AND ($2 = false OR pid NOT IN (SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted))`,
      [this.database, options.sparingLeader ?? false]
    );
    return rows.length;
  }

  /** True once the indexer has an open transaction, i.e. is in the middle of writing a ledger. */
  async indexerInTransaction(): Promise<boolean> {
    const { rows } = await this.observer.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = $1 AND application_name = 'lumina-indexer' AND xact_start IS NOT NULL LIMIT 1`,
      [this.database]
    );
    return rows.length > 0;
  }

  // ─── The services' own view ─────────────────────────────────────────────────

  indexerHealth(): Promise<HttpResult> {
    return httpJson(`http://127.0.0.1:${this.indexerHealthPort}/health`);
  }

  graphqlHealth(): Promise<HttpResult> {
    return httpJson(`${this.graphqlUrl}/health`);
  }

  query(query: string, variables: Record<string, unknown> = {}): Promise<HttpResult> {
    return httpJson(`${this.graphqlUrl}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  }

  metrics(service: 'indexer' | 'graphql'): Promise<HttpResult> {
    return httpJson(
      service === 'indexer' ? `http://127.0.0.1:${this.indexerHealthPort}/metrics` : `${this.graphqlUrl}/metrics`
    );
  }

  subscribe(query: string): SubscriptionProbe {
    const probe = new SubscriptionProbe(`ws://127.0.0.1:${this.graphqlPort}/graphql`, query);
    probe.start();
    return probe;
  }

  /** The newest ledger the GraphQL API serves, or null if it cannot answer. */
  async servedTip(): Promise<number | null> {
    const result = await this.query('{ ledgers(limit: 1) { items { sequence } } }');
    const body = result.body as { data?: { ledgers?: { items?: Array<{ sequence: number }> } } } | null;
    return body?.data?.ledgers?.items?.[0]?.sequence ?? null;
  }

  /** Ready: both services answer, and the indexer is within `lag` ledgers of the chain. */
  async waitUntilCaughtUp(timeoutMs: number, lag = 3): Promise<number> {
    return waitFor(
      `the stack to catch up to within ${lag} ledgers of the chain`,
      async () => {
        const [{ max, gaps }, served] = await Promise.all([this.ledgers(), this.servedTip()]);
        return max >= this.horizon.tip() - lag && gaps === 0 && served !== null && served >= max - lag;
      },
      timeoutMs
    );
  }

  async stop(): Promise<void> {
    await Promise.allSettled([this.indexer.stop(), this.graphql.stop()]);
    await Promise.allSettled([this.proxy.close(), this.horizon.close(), this.rpc.close()]);
    await this.observer.end();
    const adminPool = new Pool({ connectionString: adminDatabaseUrl(), max: 1 });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${this.database} WITH (FORCE)`);
    } finally {
      await adminPool.end();
    }
  }
}
