import DataLoader from 'dataloader';
import type { Pool } from 'pg';
import {
  getAccountsFromDb,
  getLedgersBySequences,
  getOperationsByTransactionHashes,
  getTransactionsByHashes,
  mapAccount,
} from './db';
import { getAccount as getAccountFromHorizon } from './horizon';
import type { NetworkConfig } from './networks';

export interface RequestLoaders {
  account: DataLoader<string, ReturnType<typeof mapAccount> | null>;
  ledger: DataLoader<number, Awaited<ReturnType<typeof getLedgersBySequences>> extends Map<number, infer T> ? T | null : never>;
  transaction: DataLoader<string, Awaited<ReturnType<typeof getTransactionsByHashes>> extends Map<string, infer T> ? T | null : never>;
  operationsByTransactionHash: DataLoader<string, Awaited<ReturnType<typeof getOperationsByTransactionHashes>> extends Map<string, infer T> ? T : never>;
}

/**
 * Loaders for one network.
 *
 * The batch functions are keyed by database column, and a key means something
 * different per network — the same ledger sequence, transaction hash or account
 * address exists on each chain — so a single loader instance cannot serve two
 * of them. The context keeps one instance per network and memoises it there,
 * which is what stops two fields in one document from sharing batches.
 */
export function createLoaders(pool: Pool, network: NetworkConfig): RequestLoaders {
  return {
    account: new DataLoader(async addresses => {
      const rows = await getAccountsFromDb(pool, network.name, addresses);
      return Promise.all(addresses.map(async address => {
        const fromDb = rows.get(address);
        if (fromDb) return fromDb;

        const horizonAccount = await getAccountFromHorizon(address, network.horizonUrl);
        if (!horizonAccount) return null;
        return mapAccount({
          network: network.name,
          address: horizonAccount.account_id,
          sequence: horizonAccount.sequence,
          subentry_count: horizonAccount.subentry_count,
          last_modified_ledger: horizonAccount.last_modified_ledger,
          num_sponsored: horizonAccount.num_sponsored,
          num_sponsoring: horizonAccount.num_sponsoring,
          balances: horizonAccount.balances,
          flags: horizonAccount.flags,
          thresholds: horizonAccount.thresholds,
        });
      }));
    }),
    ledger: new DataLoader(async sequences => {
      const rows = await getLedgersBySequences(pool, network.name, sequences);
      return sequences.map(sequence => rows.get(sequence) ?? null);
    }),
    transaction: new DataLoader(async hashes => {
      const rows = await getTransactionsByHashes(pool, network.name, hashes);
      return hashes.map(hash => rows.get(hash) ?? null);
    }),
    operationsByTransactionHash: new DataLoader(async hashes => {
      const rows = await getOperationsByTransactionHashes(pool, network.name, hashes);
      return hashes.map(hash => rows.get(hash) ?? []);
    }),
  };
}
