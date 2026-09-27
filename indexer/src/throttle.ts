/**
 * Shared request throttle for pacing outbound HTTP calls with adaptive rate limiting.
 *
 * Both Horizon and Soroban RPC providers impose per-IP rate limits. A burst of
 * concurrent requests from a single indexer process can trip those limits even
 * when the average request rate is well within bounds. Serializing every
 * outbound request through a gate with a minimum spacing turns that burst into
 * a paced stream.
 *
 * The throttle adapts to rate limiting by:
 * - Backing off on 429 responses by doubling the interval
 * - Respecting Retry-After headers when present
 * - Gradually recovering after sustained success
 * - Supporting separate budgets for different request purposes
 */

import { subsystem } from './logger';

const log = subsystem('throttle');

export interface ThrottleMetrics {
  requestsTotal: { inc: (labels: Record<string, string | number>) => void };
  requestDuration?: { startTimer: () => () => void };
  currentInterval?: { set: (labels: Record<string, string>, value: number) => void };
  queuedRequests?: { set: (labels: Record<string, string>, value: number) => void };
  waitTime?: { observe: (labels: Record<string, string>, value: number) => void };
}

const MIN_REQUEST_INTERVAL_MS_DEFAULT = 100;
const MAX_REQUEST_INTERVAL_MS_DEFAULT = 10000;
const BACKOFF_MULTIPLIER = 2;
const RECOVERY_THRESHOLD = 10;
const RECOVERY_FACTOR = 0.9;

export type RequestPurpose = 'tip' | 'backfill' | 'default';

export interface ThrottleOptions {
  name: string;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  metrics?: ThrottleMetrics;
  authToken?: string;
  tipWeightFactor?: number;
}

interface BudgetState {
  gate: Promise<void>;
  queueSize: number;
  currentIntervalMs: number;
  successCount: number;
}

export function createThrottle(options: ThrottleOptions) {
  const { 
    name, 
    minIntervalMs = MIN_REQUEST_INTERVAL_MS_DEFAULT,
    maxIntervalMs = MAX_REQUEST_INTERVAL_MS_DEFAULT,
    metrics,
    authToken,
    tipWeightFactor = 2,
  } = options;

  const budgets: Record<RequestPurpose, BudgetState> = {
    tip: {
      gate: Promise.resolve(),
      queueSize: 0,
      currentIntervalMs: minIntervalMs,
      successCount: 0,
    },
    backfill: {
      gate: Promise.resolve(),
      queueSize: 0,
      currentIntervalMs: minIntervalMs * tipWeightFactor,
      successCount: 0,
    },
    default: {
      gate: Promise.resolve(),
      queueSize: 0,
      currentIntervalMs: minIntervalMs,
      successCount: 0,
    },
  };

  function updateMetrics(purpose: RequestPurpose): void {
    const budget = budgets[purpose];
    if (metrics?.currentInterval) {
      metrics.currentInterval.set({ name, purpose }, budget.currentIntervalMs);
    }
    if (metrics?.queuedRequests) {
      metrics.queuedRequests.set({ name, purpose }, budget.queueSize);
    }
  }

  function handleRateLimitResponse(purpose: RequestPurpose, retryAfterSeconds?: number): void {
    const budget = budgets[purpose];
    
    if (retryAfterSeconds) {
      const retryAfterMs = retryAfterSeconds * 1000;
      budget.currentIntervalMs = Math.min(retryAfterMs, maxIntervalMs);
    } else {
      budget.currentIntervalMs = Math.min(budget.currentIntervalMs * BACKOFF_MULTIPLIER, maxIntervalMs);
    }
    
    budget.successCount = 0;
    updateMetrics(purpose);
  }

  function handleSuccessResponse(purpose: RequestPurpose): void {
    const budget = budgets[purpose];
    budget.successCount++;
    
    if (budget.successCount >= RECOVERY_THRESHOLD && budget.currentIntervalMs > minIntervalMs) {
      budget.currentIntervalMs = Math.max(
        budget.currentIntervalMs * RECOVERY_FACTOR,
        minIntervalMs
      );
      budget.successCount = 0;
      updateMetrics(purpose);
    }
  }

  async function throttle(purpose: RequestPurpose = 'default'): Promise<void> {
    const budget = budgets[purpose];
    
    const tipBudget = budgets.tip;
    if (purpose === 'backfill' && tipBudget.queueSize > 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    budget.queueSize++;
    updateMetrics(purpose);

    const startWait = Date.now();
    const previous = budget.gate;
    let release!: () => void;
    budget.gate = new Promise(r => { release = r; });
    await previous;
    await new Promise(r => setTimeout(r, budget.currentIntervalMs));
    
    const waitTimeMs = Date.now() - startWait;
    if (metrics?.waitTime) {
      metrics.waitTime.observe({ name, purpose }, waitTimeMs / 1000);
    }
    
    budget.queueSize--;
    updateMetrics(purpose);
    release();
  }

  function buildHeaders(init?: RequestInit): Record<string, string> {
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> || {}),
    };
    
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    return headers;
  }

  async function fetchJson<T>(url: string, init?: RequestInit, purpose: RequestPurpose = 'default'): Promise<T> {
    await throttle(purpose);

    const stopTimer = metrics?.requestDuration?.startTimer();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: buildHeaders(init),
      });
    } catch (err) {
      metrics?.requestsTotal.inc({ status: 'error' });
      stopTimer?.();
      throw err;
    }
    stopTimer?.();
    metrics?.requestsTotal.inc({ status: String(res.status) });

    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
      handleRateLimitResponse(purpose, retryAfterSeconds);
    } else if (res.ok) {
      handleSuccessResponse(purpose);
    }

    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        if (retryAfter) {
          const retryMs = parseRetryAfter(retryAfter);
          log.info({ retryAfter, retryMs, url }, 'honouring Retry-After on 429');
          await new Promise(r => setTimeout(r, retryMs));
          // Retry once after waiting
          return fetchJson<T>(url, init);
        }
      }
      throw new Error(`${name} request failed (${res.status}): ${url}`);
    }
    return (await res.json()) as T;
  }

  async function postJson<T>(
    url: string,
    body: Record<string, unknown>,
    init?: Omit<RequestInit, 'method' | 'body'>,
    purpose: RequestPurpose = 'default'
  ): Promise<T> {
    await throttle(purpose);

    const stopTimer = metrics?.requestDuration?.startTimer();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildHeaders(init),
        },
        body: JSON.stringify(body),
        ...init,
      });
    } catch (err) {
      metrics?.requestsTotal.inc({ status: 'error' });
      stopTimer?.();
      throw err;
    }
    stopTimer?.();
    metrics?.requestsTotal.inc({ status: String(res.status) });

    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
      handleRateLimitResponse(purpose, retryAfterSeconds);
    } else if (res.ok) {
      handleSuccessResponse(purpose);
    }

    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        if (retryAfter) {
          const retryMs = parseRetryAfter(retryAfter);
          log.info({ retryAfter, retryMs, url }, 'honouring Retry-After on 429');
          await new Promise(r => setTimeout(r, retryMs));
          // Retry once after waiting
          return postJson<T>(url, body, init);
        }
      }
      throw new Error(`${name} request failed (${res.status}): ${url}`);
    }
    return (await res.json()) as T;
  }

  return { throttle, fetchJson, postJson };
}

/**
 * Parses the Retry-After header value and returns the delay in milliseconds.
 * Supports both delay-seconds (integer) and HTTP-date formats.
 */
function parseRetryAfter(retryAfter: string): number {
  // Try parsing as delay-seconds first
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }

  // Try parsing as HTTP-date
  const date = Date.parse(retryAfter);
  if (!isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  // Fall back to default if unparseable
  log.warn({ retryAfter }, 'could not parse Retry-After header');
  return 5000; // 5 second fallback
}