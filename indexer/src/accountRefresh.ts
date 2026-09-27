import type { Pool } from 'pg';
import {
  completeAccountRefreshes,
  deferAccountRefreshes,
  getPendingAccountRefreshes,
} from './db';
import { getAccount, type HorizonAccount } from './horizon';
import { accountFetchDecisions } from './metrics';

const ACCOUNT_REFRESH_CONCURRENCY = 10;

export interface AccountRefreshFailure {
  address: string;
  error: unknown;
}

export interface AccountRefreshBatchResult {
  requested: number;
  skipped: number;
  failures: AccountRefreshFailure[];
  hasMore: boolean;
}

type FetchAccount = (horizonUrl: string, address: string) => Promise<HorizonAccount | null>;

export async function refreshAccountQueueBatch(
  pool: Pool,
  network: string,
  horizonUrl: string,
  fetchAccount: FetchAccount = getAccount,
  batchSize = 100
): Promise<AccountRefreshBatchResult> {
  const requests = await getPendingAccountRefreshes(pool, network, batchSize);
  if (requests.length === 0) {
    return { requested: 0, skipped: 0, failures: [], hasMore: false };
  }

  const completed: Array<{
    request: (typeof requests)[number];
    account: HorizonAccount | null;
  }> = [];
  const toFetch = [] as typeof requests;
  for (const request of requests) {
    if (request.lastModifiedLedger !== null && request.lastModifiedLedger >= request.lastRequestedLedger) {
      completed.push({ request, account: null });
    } else {
      toFetch.push(request);
    }
  }

  if (toFetch.length > 0) {
    accountFetchDecisions.inc({ network, outcome: 'requested' }, toFetch.length);
  }
  const skipped = completed.length;
  if (skipped > 0) accountFetchDecisions.inc({ network, outcome: 'skipped' }, skipped);

  const results: PromiseSettledResult<HorizonAccount | null>[] = [];
  for (let offset = 0; offset < toFetch.length; offset += ACCOUNT_REFRESH_CONCURRENCY) {
    const batch = toFetch.slice(offset, offset + ACCOUNT_REFRESH_CONCURRENCY);
    results.push(...await Promise.allSettled(
      batch.map(request => fetchAccount(horizonUrl, request.address))
    ));
  }
  const failures: AccountRefreshFailure[] = [];
  const deferred = [] as typeof requests;
  results.forEach((result, index) => {
    const request = toFetch[index]!;
    if (result.status === 'fulfilled') {
      completed.push({ request, account: result.value });
    } else {
      failures.push({ address: request.address, error: result.reason });
      deferred.push(request);
    }
  });

  await completeAccountRefreshes(pool, network, completed);
  await deferAccountRefreshes(pool, network, deferred);

  return {
    requested: toFetch.length,
    skipped,
    failures,
    hasMore: requests.length === batchSize && failures.length === 0,
  };
}
