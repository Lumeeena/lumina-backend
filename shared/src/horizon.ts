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
import {
  ACCOUNT_SPEC,
  HorizonResponseError,
  LEDGER_SPEC,
  OPERATION_SPEC,
  RAW_RESPONSE_LIMIT,
  ShapeProblem,
  TRADE_SPEC,
  TRANSACTION_SPEC,
  checkPage,
  checkRecord,
  type RecordSpec,
} from './validate';

/**
 * Horizon's page size, and the signal that another page exists.
 * See `docs/HORIZON_CONTRACT.md` for full field dependencies and contract details.
 */
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

export interface HorizonTradePrice {
  n: number | string;
  d: number | string;
}

export interface HorizonTrade {
  id: string;
  paging_token: string;
  ledger_close_time: string;
  trade_type?: string;
  base_offer_id?: string;
  base_account: string;
  base_amount: string;
  base_asset_type: string;
  base_asset_code?: string;
  base_asset_issuer?: string;
  counter_offer_id?: string;
  counter_account?: string;
  counter_amount: string;
  counter_asset_type: string;
  counter_asset_code?: string;
  counter_asset_issuer?: string;
  base_is_seller?: boolean;
  price?: HorizonTradePrice;
}

export interface HorizonTradesFilter {
  cursor?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  base_asset_type?: string;
  base_asset_code?: string;
  base_asset_issuer?: string;
  counter_asset_type?: string;
  counter_asset_code?: string;
  counter_asset_issuer?: string;
  offer_id?: string;
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
  baseUrl?: HorizonEndpoint;
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
  /**
   * Check each response against the field list the caller reads, before any
   * record reaches the caller. Off by default so the GraphQL server, which
   * reads a handful of fields and falls back to `null`, pays nothing for it.
   * The indexer turns it on: a malformed response there must stop the write,
   * not surface as an `undefined` inside an INSERT.
   */
  validateResponses?: boolean;
  /** Injectable for tests; defaults to `globalThis.fetch` resolved at call time. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export type HorizonEndpoint = string | readonly string[];

export class HorizonUnavailableError extends Error {
  readonly endpoints: string[];

  constructor(endpoints: string[], cause?: unknown) {
    super(`all Horizon endpoints are unavailable: ${endpoints.join(', ')}`);
    this.name = 'HorizonUnavailableError';
    this.endpoints = endpoints;
    this.cause = cause;
  }
}

/**
 * Every method takes the base URL of the network it is asking about, because a
 * deployment serves more than one chain: falling back to the primary network's
 * Horizon when the database has nothing for testnet would hand a client mainnet
 * data under a testnet label. Calls that omit it use `baseUrl` from the options,
 * which is the single-network deployment's default.
 */
export interface HorizonClient {
  getLatestLedgerSequence(baseUrl?: HorizonEndpoint): Promise<number>;
  getLedger(sequence: number, baseUrl?: HorizonEndpoint): Promise<HorizonLedger>;
  getLedgerTransactions(sequence: number, baseUrl?: HorizonEndpoint): Promise<HorizonTransaction[]>;
  getLedgerOperations(sequence: number, baseUrl?: HorizonEndpoint): Promise<HorizonOperation[]>;
  getAccount(address: string, baseUrl?: HorizonEndpoint): Promise<HorizonAccount | null>;
  /**
   * Account fetch for callers that must tell "does not exist" apart from
   * "Horizon is down": a 404 returns `null`, but a transient failure (429,
   * 5xx, connect error) throws. The indexer's refresh queue treats a
   * rejection as "retry later" and a `null` as "account is gone", so a
   * swallowed outage would complete the refresh and drop it.
   */
  getAccountOrThrow(address: string, baseUrl?: HorizonEndpoint): Promise<HorizonAccount | null>;
  getRecentTransactions(limit?: number, baseUrl?: HorizonEndpoint): Promise<HorizonTransaction[]>;
  getAccountTransactions(
    address: string,
    limit?: number,
    baseUrl?: HorizonEndpoint
  ): Promise<HorizonTransaction[]>;
  getLatestLedger(baseUrl?: HorizonEndpoint): Promise<HorizonLatestLedger | null>;
  getTrades(params?: HorizonTradesFilter, baseUrl?: HorizonEndpoint): Promise<HorizonTrade[]>;
}

/** Checks a decoded body; throws `ShapeProblem` when it does not match. */
type BodyCheck = (body: unknown) => void;

/** Runs a check and reports the first problem as data rather than throwing it. */
function runCheck(check: BodyCheck, body: unknown): ShapeProblem | null {
  try {
    check(body);
    return null;
  } catch (err) {
    if (err instanceof ShapeProblem) return err;
    throw err;
  }
}

/** The body as text, cut to `RAW_RESPONSE_LIMIT` so one bad page cannot flood a log line. */
function rawBody(body: unknown): string {
  const text = JSON.stringify(body) ?? String(body);
  return text.length > RAW_RESPONSE_LIMIT ? `${text.slice(0, RAW_RESPONSE_LIMIT)}…` : text;
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
  const validateResponses = options.validateResponses ?? false;
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

  const demotedUntil = new Map<string, number>();
  const demotionMs = 30_000;

  function endpoints(baseUrl?: HorizonEndpoint): string[] {
    const configured = baseUrl ?? defaultBaseUrl;
    const values = typeof configured === 'string' ? configured.split(',') : configured ?? [];
    const result = values.map(value => value.trim()).filter(Boolean);
    if (result.length === 0) throw new Error(`${name} client has no base URL: pass one or configure baseUrl`);
    const now = Date.now();
    return [...result].sort((a, b) => {
      const aDemoted = (demotedUntil.get(a) ?? 0) > now;
      const bDemoted = (demotedUntil.get(b) ?? 0) > now;
      return Number(aDemoted) - Number(bDemoted) || result.indexOf(a) - result.indexOf(b);
    });
  }

  function url(path: string, endpoint: string): string {
    return `${endpoint.replace(/\/+$/, '')}${path}`;
  }

  /**
   * All call styles, one pipeline.
   *
   * `throw` is for the indexer, whose ledger walk must not silently index
   * nothing; `null` is for the GraphQL server's read-through fallback, where a
   * Horizon outage has to degrade to "not indexed yet" rather than fail the
   * query; `null_on_404` is the middle ground for the indexer's account
   * refreshes, where "no such account" is data but an outage must surface as a
   * rejection so the queue retries instead of completing against a `null`. A
   * 404 is a statement about the ledger or account, not a failure, so only
   * `throw` treats it as an error.
   */
  async function request<T>(target: string, mode: 'throw', check?: BodyCheck, baseUrl?: HorizonEndpoint): Promise<T>;
  async function request<T>(target: string, mode: 'null', check?: BodyCheck, baseUrl?: HorizonEndpoint): Promise<T | null>;
  async function request<T>(
    target: string,
    mode: 'null_on_404',
    check?: BodyCheck,
    baseUrl?: HorizonEndpoint
  ): Promise<T | null>;
  async function request<T>(
    target: string,
    mode: 'throw' | 'null' | 'null_on_404',
    check?: BodyCheck,
    baseUrl?: HorizonEndpoint
  ): Promise<T | null> {
    const configuredEndpoints = endpoints(baseUrl);
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      let endpointFailures = 0;
      for (const endpoint of configuredEndpoints) {
        let path = target;
        try {
          const parsed = new URL(target);
          path = parsed.pathname + parsed.search;
        } catch {
          // Tests and some proxies return a relative pagination link.
        }
        const targetUrl = url(path, endpoint);
      await throttle();

      const stopTimer = metrics?.requestDuration?.startTimer();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

      let res: Response;
      try {
        res = await doFetch(targetUrl, { signal: controller.signal });
      } catch (err) {
        clearTimeout(timeout);
        stopTimer?.();
        metrics?.requestsTotal.inc({ status: 'error' });
        metrics?.endpointRequests?.inc({ endpoint, status: 'error' });

        endpointFailures++;
        demotedUntil.set(endpoint, Date.now() + demotionMs);
        log?.warn({ url: targetUrl, attempts: attempt }, `${name} request failed to connect; endpoint demoted`);
        continue;
      }
      clearTimeout(timeout);
      stopTimer?.();
      metrics?.requestsTotal.inc({ status: String(res.status) });
      metrics?.endpointRequests?.inc({ endpoint, status: String(res.status) });

      if (res.ok) {
        const body: unknown = await res.json();
        if (check && validateResponses) {
          const problem = runCheck(check, body);
          if (problem) {
            const raw = rawBody(body);
            log?.warn({ url: targetUrl, field: problem.field, raw }, `${name} response failed validation`);
            // Always a throw, whatever the mode: `null` means "not found", and a
            // malformed body is not that. A caller that treated it as absent
            // would mark the work done and drop the data.
            throw new HorizonResponseError(targetUrl, problem.field, problem.problem, raw);
          }
        }
        demotedUntil.delete(endpoint);
        return body as T;
      }

      if (res.status === 404 && mode !== 'throw') return null;

      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = res.headers?.get?.('Retry-After') ?? null;
        const parsed = retryAfter === null ? Number.NaN : Number(retryAfter);
        // A `Retry-After` that is not a number of seconds (an HTTP date, a
        // proxy's placeholder) is worse than no header at all: obeying it as
        // `NaN` waits zero milliseconds and turns a rate limit into a burst.
        const delay = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : backoffMs(attempt);
        log?.warn({ url: targetUrl, attempt, delay }, `${name} rate limit, retrying after a pause`);
        await sleep(delay);
        continue;
      }

      if (mode !== 'null') {
        if (res.status < 500 || res.status === 429) {
          throw new Error(`${name} request failed (${res.status}): ${targetUrl}`);
        }
        endpointFailures++;
        if (res.status >= 500) demotedUntil.set(endpoint, Date.now() + demotionMs);
        continue;
      }
      log?.warn({ url: targetUrl, status: res.status }, `${name} request failed`);
      return null;
      }
      if (endpointFailures === configuredEndpoints.length) {
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        if (mode !== 'null') throw new HorizonUnavailableError(configuredEndpoints);
        return null;
      }
    }

    // Unreachable: `maxRetries` is clamped to at least one attempt, and every
    // path above either returns or throws. Present so the return type is honest.
    return null;
  }

  async function fetchAllPages<T>(target: string, spec: RecordSpec, baseUrl?: HorizonEndpoint): Promise<T[]> {
    const records: T[] = [];
    let next: string | undefined = target;
    const check: BodyCheck = body => checkPage(body, spec);
    while (next) {
      // Annotated rather than inferred: `next` is reassigned from `page` below,
      // and the two would otherwise be circular.
      const page: HorizonPage<T> = await request<HorizonPage<T>>(next, 'throw', check, baseUrl);
      records.push(...page._embedded.records);
      next = page._embedded.records.length === PAGE_LIMIT ? page._links.next?.href : undefined;
    }
    return records;
  }

  return {
    async getLatestLedgerSequence(baseUrl?: HorizonEndpoint): Promise<number> {
      const page = await request<HorizonPage<HorizonLedger>>(
        url('/ledgers?order=desc&limit=1', endpoints(baseUrl)[0]!),
        'throw',
        body => checkPage(body, LEDGER_SPEC)
        , baseUrl
      );
      return page._embedded.records[0]?.sequence ?? 0;
    },

    getLedger(sequence: number, baseUrl?: HorizonEndpoint): Promise<HorizonLedger> {
      return request<HorizonLedger>(      url(`/ledgers/${sequence}`, endpoints(baseUrl)[0]!), 'throw', body =>
      checkRecord(body, LEDGER_SPEC, 'response'), baseUrl
      );
    },

    getLedgerTransactions(sequence: number, baseUrl?: HorizonEndpoint): Promise<HorizonTransaction[]> {
      return fetchAllPages<HorizonTransaction>(
        url(`/ledgers/${sequence}/transactions?order=asc&limit=${PAGE_LIMIT}`, endpoints(baseUrl)[0]!),
        TRANSACTION_SPEC, baseUrl
      );
    },

    getLedgerOperations(sequence: number, baseUrl?: HorizonEndpoint): Promise<HorizonOperation[]> {
      return fetchAllPages<HorizonOperation>(
        url(`/ledgers/${sequence}/operations?order=asc&limit=${PAGE_LIMIT}`, endpoints(baseUrl)[0]!),
        OPERATION_SPEC, baseUrl
      );
    },

    /** `null` rather than an exception for accounts that don't exist or were merged away. */
    getAccount(address: string, baseUrl?: HorizonEndpoint): Promise<HorizonAccount | null> {
      return request<HorizonAccount>(url(`/accounts/${address}`, endpoints(baseUrl)[0]!), 'null', body =>
        checkRecord(body, ACCOUNT_SPEC, 'response'), baseUrl
      );
    },

    /** A 404 is `null`; a transient failure throws so the caller can retry. */
    getAccountOrThrow(address: string, baseUrl?: HorizonEndpoint): Promise<HorizonAccount | null> {
      return request<HorizonAccount>(url(`/accounts/${address}`, endpoints(baseUrl)[0]!), 'null_on_404', body =>
        checkRecord(body, ACCOUNT_SPEC, 'response'), baseUrl
      );
    },

    async getRecentTransactions(limit = 20, baseUrl?: HorizonEndpoint): Promise<HorizonTransaction[]> {
      const page = await request<HorizonPage<HorizonTransaction>>(
        url(`/transactions?order=desc&limit=${limit}`, endpoints(baseUrl)[0]!),
        'null', undefined, baseUrl
      );
      return page?._embedded?.records ?? [];
    },

    async getAccountTransactions(
      address: string,
      limit = 10,
      baseUrl?: HorizonEndpoint
    ): Promise<HorizonTransaction[]> {
      const page = await request<HorizonPage<HorizonTransaction>>(
        url(`/accounts/${address}/transactions?order=desc&limit=${limit}`, endpoints(baseUrl)[0]!),
        'null', undefined, baseUrl
      );
      return page?._embedded?.records ?? [];
    },

    async getLatestLedger(baseUrl?: HorizonEndpoint): Promise<HorizonLatestLedger | null> {
      const page = await request<HorizonPage<HorizonLatestLedger>>(
        url('/ledgers?order=desc&limit=1', endpoints(baseUrl)[0]!),
        'null', undefined, baseUrl
      );
      return page?._embedded?.records?.[0] ?? null;
    },

    async getTrades(params: HorizonTradesFilter = {}, baseUrl?: HorizonEndpoint): Promise<HorizonTrade[]> {
      const q = new URLSearchParams();
      if (params.cursor) q.set('cursor', params.cursor);
      if (params.order) q.set('order', params.order);
      if (params.limit) q.set('limit', String(params.limit));
      if (params.base_asset_type) q.set('base_asset_type', params.base_asset_type);
      if (params.base_asset_code) q.set('base_asset_code', params.base_asset_code);
      if (params.base_asset_issuer) q.set('base_asset_issuer', params.base_asset_issuer);
      if (params.counter_asset_type) q.set('counter_asset_type', params.counter_asset_type);
      if (params.counter_asset_code) q.set('counter_asset_code', params.counter_asset_code);
      if (params.counter_asset_issuer) q.set('counter_asset_issuer', params.counter_asset_issuer);
      if (params.offer_id) q.set('offer_id', params.offer_id);
      const qs = q.toString();
      const path = `/trades${qs ? `?${qs}` : ''}`;
      const page = await request<HorizonPage<HorizonTrade>>(url(path, endpoints(baseUrl)[0]!), 'null', body =>
        checkPage(body, TRADE_SPEC), baseUrl
      );
      return page?._embedded?.records ?? [];
    },
  };
}
