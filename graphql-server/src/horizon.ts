// Horizon client for the GraphQL server layer.
// Mirrors frontend/lib/horizon.ts but is intentionally separate —
// the GraphQL server is a standalone service and must not import from the frontend package.
// Once the indexer is writing to PostgreSQL, replace these fetch calls with db queries.
//
// A deployment serves more than one chain, so every call takes the base URL of
// the network it is asking about: falling back to the primary network's Horizon
// when the database has nothing for testnet would hand a client mainnet data
// under a testnet label. The flat `HORIZON_URL` remains the default so the
// single-network deployment — and the unit tests — keep one obvious URL.

const HORIZON = process.env['HORIZON_URL'] ?? 'https://horizon.stellar.org';

export interface HorizonTransaction {
  id: string;
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

export interface HorizonAccount {
  id: string;
  account_id: string;
  sequence: string;
  subentry_count: number;
  last_modified_ledger: number;
  num_sponsored: number;
  num_sponsoring: number;
  balances: Balance[];
  flags: { auth_required: boolean; auth_revocable: boolean; auth_immutable: boolean; auth_clawback_enabled?: boolean };
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
}

export interface Balance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 300;
const REQUEST_TIMEOUT_MS = parseInt(process.env['HORIZON_REQUEST_TIMEOUT_MS'] ?? '2000', 10);

/**
 * Fetches from Horizon with 429-aware retry (respecting Retry-After when
 * present). Logs failures instead of swallowing them silently — a prior
 * silent-null-on-any-failure here made a Horizon rate limit indistinguishable
 * from a genuinely nonexistent account.
 */
async function get<T>(path: string, baseUrl: string = HORIZON): Promise<T | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
      if (res.ok) return res.json() as Promise<T>;
      if (res.status === 404) return null; // genuinely doesn't exist — no point retrying

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : BASE_BACKOFF_MS * 2 ** (attempt - 1);
        console.warn(`Horizon rate-limited (attempt ${attempt}/${MAX_RETRIES}), retrying ${path} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      console.warn(`Horizon request failed (${res.status}) for ${path}`);
      return null;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.warn(`Horizon request errored for ${path}:`, err);
        return null;
      }
      await new Promise(r => setTimeout(r, BASE_BACKOFF_MS * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

export async function getRecentTransactions(limit = 20, baseUrl?: string): Promise<HorizonTransaction[]> {
  type R = { _embedded: { records: HorizonTransaction[] } };
  const data = await get<R>(`/transactions?order=desc&limit=${limit}`, baseUrl);
  return data?._embedded?.records ?? [];
}

export async function getAccount(address: string, baseUrl?: string): Promise<HorizonAccount | null> {
  return get<HorizonAccount>(`/accounts/${address}`, baseUrl);
}

export async function getAccountTransactions(address: string, limit = 10, baseUrl?: string): Promise<HorizonTransaction[]> {
  type R = { _embedded: { records: HorizonTransaction[] } };
  const data = await get<R>(`/accounts/${address}/transactions?order=desc&limit=${limit}`, baseUrl);
  return data?._embedded?.records ?? [];
}

export async function getLatestLedger(baseUrl?: string) {
  type R = { _embedded: { records: Array<{ sequence: number; closed_at: string; successful_transaction_count: number; failed_transaction_count: number; operation_count: number }> } };
  const data = await get<R>('/ledgers?order=desc&limit=1', baseUrl);
  return data?._embedded?.records?.[0] ?? null;
}
