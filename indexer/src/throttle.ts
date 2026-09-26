/**
 * Shared request throttle for pacing outbound HTTP calls.
 *
 * Both Horizon and Soroban RPC providers impose per-IP rate limits. A burst of
 * concurrent requests from a single indexer process can trip those limits even
 * when the average request rate is well within bounds. Serializing every
 * outbound request through a gate with a minimum spacing turns that burst into
 * a paced stream.
 */

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
      throw new Error(`${name} request failed (${res.status}): ${url}`);
    }
    return (await res.json()) as T;
  }

  return { throttle, fetchJson, postJson };
}