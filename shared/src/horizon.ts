/**
 * The one Horizon client.
 *
 * There used to be two — `indexer/src/horizon.ts` and
 * `graphql-server/src/horizon.ts` — and they had already drifted: the indexer's
 * was throttled and metered, the GraphQL server's was not, so the service with
 * the smaller request budget was the one left exposed to a 429. Every fix had
 * to be written twice and one copy was always forgotten.
 *
 * Both services' behaviour was a requirement, so this file is both: every
 * request is paced by the throttle, bounded by a timeout, retried on a 429
 * (honouring `Retry-After`) or a connection error, and reported to whichever
 * metrics registry the caller injects. The two failure styles the services need
 * — the indexer's ledger walk wants an exception, the GraphQL server's
 * database-then-Horizon fallback wants `null` — are one code path with a mode
 * rather than two implementations.
 *
 * Nothing here imports a service's logger, metrics or configuration: those are
 * injected. That is what lets the same file be compiled into both packages
 * without either service depending on the other.
 */
import { createThrottle, type ThrottleMetrics } from './throttle';

/** Horizon's page size, and the signal that another page exists. */
export const PAGE_LIMIT = 200;

export interface HorizonLedger {
  sequence: number;
  closed_at: string;
  successful_transaction_count: number;
  failed_transaction_count: number;
  operation_count: number;
  base_fee_in_stroops: number;
  base_reserve_in_stroops: number;
}

export interface HorizonTransaction {
  hash: string;
  ledger: number;
  created_at: string;
  source_account: string;
  fee_charged: string;
  operation_count: number;
  successful: boolean;
  memo_type: string;
  memo?: string;
}

export interface HorizonOperation {
  id: string;
  type: string;
  transaction_hash: string;
  created_at: string;
  source_account: string;
  [key: string]: unknown;
}

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
}

export interface HorizonAccount {
  /** Present on newer Horizon versions; `account_id` is the field both use. */
  id?: string;
  account_id: string;
  sequence: string;
  subentry_count: number;
  last_modified_ledger: number;
  num_sponsored: number;
  num_sponsoring: number;
  balances: HorizonBalance[];
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
    /** Absent on Horizon versions that predate clawback support. */
    auth_clawback_enabled?: boolean;
  };
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
}

/** The subset of a ledger tip both services read. */
export interface HorizonLatestLedger {
  sequence: number;
  closed_at: string;
  successful_transaction_count: number;
  failed_transaction_count: number;
  operation_count: number;
}

interface HorizonPage<T> {
  _embedded: { records: T[] };
  _links: { next?: { href: string } };
}

/** The `warn(fields, message)` shape both services' loggers already expose. */
export interface HorizonLogSink {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface HorizonClientOptions {
  /** Label used in error messages and log lines. */
  name?: string;
  /** Base URL for calls that do not pass one explicitly. */
  baseUrl?: string;
  /** Minimum spacing between outbound requests. */
  minIntervalMs?: number;
  /** Attempts per URL, including the first. */
  maxRetries?: number;
  /** First backoff, doubled on each subsequent attempt. */
  baseBackoffMs?: number;
  /** Abort a request that takes longer than this. */
  requestTimeoutMs?: number;
  metrics?: ThrottleMetrics;
  logger?: HorizonLogSink;
  /** Injectable for tests; defaults to `globalThis.fetch` resolved at call time. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Every method takes the base URL of the network it is asking about, because a
 * deployment serves more than one chain: falling back to the primary network's
 * Horizon when the database has nothing for testnet would hand a client mainnet
 * data under a testnet label. Calls that omit it use `baseUrl` from the options,
 * which is the single-network deployment's default.
 */
export interface HorizonClient {
  getLatestLedgerSequence(baseUrl?: string): Promise<number>;
  getLedger(sequence: number, baseUrl?: string): Promise<HorizonLedger>;
  getLedgerTransactions(sequence: number, baseUrl?: string): Promise<HorizonTransaction[]>;
  getLedgerOperations(sequence: number, baseUrl?: string): Promise<HorizonOperation[]>;
  getAccount(address: string, baseUrl?: string): Promise<HorizonAccount | null>;
  getRecentTransactions(limit?: number, baseUrl?: string): Promise<HorizonTransaction[]>;
  getAccountTransactions(
    address: string,
    limit?: number,
    baseUrl?: string
  ): Promise<HorizonTransaction[]>;
  getLatestLedger(baseUrl?: string): Promise<HorizonLatestLedger | null>;
}

const DEFAULT_MIN_INTERVAL_MS = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 300;
/** Generous by default: a 200-record ledger page is not a small response. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export function createHorizonClient(options: HorizonClientOptions = {}): HorizonClient {
  const name = options.name ?? 'horizon';
  const defaultBaseUrl = options.baseUrl;
  const maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const metrics = options.metrics;
  const log = options.logger;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  // Resolved per call rather than captured, so a test that replaces the global
  // still exercises the same client the service built at startup.
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  // Pacing only: this client reports its own metrics, per request attempt,
  // because a retried 429 must show up as two requests and not one.
  const { throttle } = createThrottle({
    name,
    minIntervalMs: options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
  });

  const backoffMs = (attempt: number) => baseBackoffMs * 2 ** (attempt - 1);

  function url(path: string, baseUrl?: string): string {
    const base = baseUrl ?? defaultBaseUrl;
    if (!base) throw new Error(`${name} client has no base URL: pass one or configure baseUrl`);
    return `${base.replace(/\/+$/, '')}${path}`;
  }

  /**
   * Both call styles, one pipeline.
   *
   * `throw` is for the indexer, whose ledger walk must not silently index
   * nothing; `null` is for the GraphQL server's read-through fallback, where a
   * Horizon outage has to degrade to "not indexed yet" rather than fail the
   * query. A 404 is a statement about the ledger or account, not a failure, so
   * neither style retries it.
   */
  async function request<T>(target: string, mode: 'throw'): Promise<T>;
  async function request<T>(target: string, mode: 'null'): Promise<T | null>;
  async function request<T>(target: string, mode: 'throw' | 'null'): Promise<T | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      await throttle();

      const stopTimer = metrics?.requestDuration?.startTimer();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

      let res: Response;
      try {
        res = await doFetch(target, { signal: controller.signal });
      } catch (err) {
        clearTimeout(timeout);
        stopTimer?.();
        metrics?.requestsTotal.inc({ status: 'error' });

        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        log?.warn({ url: target, attempts: attempt }, `${name} request failed to connect`);
        if (mode === 'throw') throw err;
        return null;
      }
      clearTimeout(timeout);
      stopTimer?.();
      metrics?.requestsTotal.inc({ status: String(res.status) });

      if (res.ok) return (await res.json()) as T;

      if (res.status === 404 && mode === 'null') return null;

      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = res.headers?.get?.('Retry-After') ?? null;
        const parsed = retryAfter === null ? Number.NaN : Number(retryAfter);
        // A `Retry-After` that is not a number of seconds (an HTTP date, a
        // proxy's placeholder) is worse than no header at all: obeying it as
        // `NaN` waits zero milliseconds and turns a rate limit into a burst.
        const delay = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : backoffMs(attempt);
        log?.warn({ url: target, attempt, delay }, `${name} rate limit, retrying after a pause`);
        await sleep(delay);
        continue;
      }

      if (mode === 'throw') {
        throw new Error(`${name} request failed (${res.status}): ${target}`);
      }
      log?.warn({ url: target, status: res.status }, `${name} request failed`);
      return null;
    }

    // Unreachable: `maxRetries` is clamped to at least one attempt, and every
    // path above either returns or throws. Present so the return type is honest.
    return null;
  }

  async function fetchAllPages<T>(target: string): Promise<T[]> {
    const records: T[] = [];
    let next: string | undefined = target;
    while (next) {
      // Annotated rather than inferred: `next` is reassigned from `page` below,
      // and the two would otherwise be circular.
      const page: HorizonPage<T> = await request<HorizonPage<T>>(next, 'throw');
      records.push(...page._embedded.records);
      next = page._embedded.records.length === PAGE_LIMIT ? page._links.next?.href : undefined;
    }
    return records;
  }

  return {
    async getLatestLedgerSequence(baseUrl?: string): Promise<number> {
      const page = await request<HorizonPage<HorizonLedger>>(
        url('/ledgers?order=desc&limit=1', baseUrl),
        'throw'
      );
      return page._embedded.records[0]?.sequence ?? 0;
    },

    getLedger(sequence: number, baseUrl?: string): Promise<HorizonLedger> {
      return request<HorizonLedger>(url(`/ledgers/${sequence}`, baseUrl), 'throw');
    },

    getLedgerTransactions(sequence: number, baseUrl?: string): Promise<HorizonTransaction[]> {
      return fetchAllPages<HorizonTransaction>(
        url(`/ledgers/${sequence}/transactions?order=asc&limit=${PAGE_LIMIT}`, baseUrl)
      );
    },

    getLedgerOperations(sequence: number, baseUrl?: string): Promise<HorizonOperation[]> {
      return fetchAllPages<HorizonOperation>(
        url(`/ledgers/${sequence}/operations?order=asc&limit=${PAGE_LIMIT}`, baseUrl)
      );
    },

    /** `null` rather than an exception for accounts that don't exist or were merged away. */
    getAccount(address: string, baseUrl?: string): Promise<HorizonAccount | null> {
      return request<HorizonAccount>(url(`/accounts/${address}`, baseUrl), 'null');
    },

    async getRecentTransactions(limit = 20, baseUrl?: string): Promise<HorizonTransaction[]> {
      const page = await request<HorizonPage<HorizonTransaction>>(
        url(`/transactions?order=desc&limit=${limit}`, baseUrl),
        'null'
      );
      return page?._embedded?.records ?? [];
    },

    async getAccountTransactions(
      address: string,
      limit = 10,
      baseUrl?: string
    ): Promise<HorizonTransaction[]> {
      const page = await request<HorizonPage<HorizonTransaction>>(
        url(`/accounts/${address}/transactions?order=desc&limit=${limit}`, baseUrl),
        'null'
      );
      return page?._embedded?.records ?? [];
    },

    async getLatestLedger(baseUrl?: string): Promise<HorizonLatestLedger | null> {
      const page = await request<HorizonPage<HorizonLatestLedger>>(
        url('/ledgers?order=desc&limit=1', baseUrl),
        'null'
      );
      return page?._embedded?.records?.[0] ?? null;
    },
  };
}
