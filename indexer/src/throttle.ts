/**
 * Shared request throttle for pacing outbound HTTP calls.
 *
 * Both Horizon and Soroban RPC providers impose per-IP rate limits. A burst of
 * concurrent requests from a single indexer process can trip those limits even
 * when the average request rate is well within bounds. Serializing every
 * outbound request through a gate with a minimum spacing turns that burst into
 * a paced stream.
 */

import { subsystem } from './logger';

const log = subsystem('throttle');

export interface ThrottleMetrics {
  requestsTotal: { inc: (labels: Record<string, string | number>) => void };
  requestDuration?: { startTimer: () => () => void };
}

const MIN_REQUEST_INTERVAL_MS_DEFAULT = 100;

export interface ThrottleOptions {
  name: string;
  minIntervalMs?: number;
  metrics?: ThrottleMetrics;
}

export function createThrottle(options: ThrottleOptions) {
  const { name, minIntervalMs = MIN_REQUEST_INTERVAL_MS_DEFAULT, metrics } = options;
  let gate: Promise<void> = Promise.resolve();

  async function throttle(): Promise<void> {
    const previous = gate;
    let release!: () => void;
    gate = new Promise(r => { release = r; });
    await previous;
    await new Promise(r => setTimeout(r, minIntervalMs));
    release();
  }

  async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    await throttle();

    const stopTimer = metrics?.requestDuration?.startTimer();
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      metrics?.requestsTotal.inc({ status: 'error' });
      stopTimer?.();
      throw err;
    }
    stopTimer?.();
    metrics?.requestsTotal.inc({ status: String(res.status) });

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
    init?: Omit<RequestInit, 'method' | 'body'>
  ): Promise<T> {
    await throttle();

    const stopTimer = metrics?.requestDuration?.startTimer();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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