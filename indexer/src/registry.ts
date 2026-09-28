/**
 * Discovers contract IDs from a deployed Lumina Registry contract, so the
 * indexer's Soroban event indexing (soroban.ts) doesn't have to rely solely
 * on a static INDEXED_CONTRACT_IDS list.
 *
 * Uses simulateTransaction against get_active_contracts — a read-only call,
 * so the read account only needs to be a funded account that exists on the
 * network; no secret key or signature is required.
 *
 * ## Per network, not per deployment
 *
 * Each network has its own registry deployment, so discovery is configured per
 * network rather than once for the process:
 *
 * ```
 * REGISTRY_CONTRACT_ID=CA…              # the default every network inherits
 * REGISTRY_READ_ACCOUNT=GB…              # likewise
 * TESTNET_REGISTRY_CONTRACT_ID=CA…      # a network that deploys its own
 * TESTNET_REGISTRY_READ_ACCOUNT=GB…
 * ```
 *
 * A network with no override uses the flat variables; a network with an
 * override uses its own. Both being unset is the normal case — discovery is
 * opt-in, and the indexer runs exactly as it did before registry support
 * existed when neither is set.
 *
 * The passphrase follows from the network it reads, not from a separate
 * setting: simulating a read on testnet requires testnet's passphrase, and a
 * deployment that has to override it is a deployment whose registry lives
 * somewhere other than the network it is registered under. It can still be
 * overridden explicitly with `<NAME>_REGISTRY_NETWORK_PASSPHRASE` for exactly
 * that case.
 */
import { Contract, nativeToScVal, rpc, scValToNative, TransactionBuilder } from '@stellar/stellar-sdk';
import type { NetworkConfig } from './networks';

interface ContractEntry {
  active: boolean;
  contract_id: string;
  description: string;
  name: string;
  owner: string;
  registered_at: number;
}

const PAGE_LIMIT = 50;
const MAX_PAGES = 20; // safety cap: 1000 contracts

/**
 * A network's registry, or absent when that network does not discover.
 *
 * `undefined` fields mean "discovery is off here", which is distinct from "on
 * but not yet polled": the difference decides whether the loop reads a
 * registry at all, so it is resolved once at startup rather than per tick.
 */
export interface RegistryConfig {
  contractId: string;
  readAccount: string;
  /** Passphrase the simulated read is signed against. */
  networkPassphrase: string;
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/**
 * Resolve the registry each network discovers from.
 *
 * A half-configured network — a contract id without a read account — is an
 * error rather than a silent skip. Discovery that quietly does not happen looks
 * exactly like a registry with no contracts in it, and the deployment goes on
 * indexing a stale static list without anyone noticing.
 */
export function resolveRegistryConfigs(
  networks: readonly NetworkConfig[],
  env: NodeJS.ProcessEnv = process.env
): Map<string, RegistryConfig> {
  const configs = new Map<string, RegistryConfig>();
  const defaultContractId = optional(env, 'REGISTRY_CONTRACT_ID');
  const defaultReadAccount = optional(env, 'REGISTRY_READ_ACCOUNT');
  // Kept for the flat single-network deployment, where the registry is read
  // with a passphrase that is not the network's own (a testnet registry read
  // by a mainnet-configured process, historically).
  const defaultPassphrase = optional(env, 'REGISTRY_NETWORK_PASSPHRASE');

  if (defaultContractId !== undefined && defaultReadAccount === undefined) {
    throw new RegistryConfigError(
      'REGISTRY_CONTRACT_ID is set but REGISTRY_READ_ACCOUNT is not. ' +
        'Set REGISTRY_READ_ACCOUNT, or unset both to disable discovery.'
    );
  }
  if (defaultReadAccount !== undefined && defaultContractId === undefined) {
    throw new RegistryConfigError(
      'REGISTRY_READ_ACCOUNT is set but REGISTRY_CONTRACT_ID is not. ' +
        'Set REGISTRY_CONTRACT_ID, or unset both to disable discovery.'
    );
  }

  for (const network of networks) {
    const prefix = network.name.toUpperCase();
    const contractId = optional(env, `${prefix}_REGISTRY_CONTRACT_ID`) ?? defaultContractId;
    const readAccount = optional(env, `${prefix}_REGISTRY_READ_ACCOUNT`) ?? defaultReadAccount;
    if (contractId === undefined && readAccount === undefined) continue;

    if (contractId === undefined || readAccount === undefined) {
      // Names the half that is *missing*: the operator has set the other one,
      // and telling them to set the one they already set sends them in circles.
      const missing =
        readAccount === undefined ? `${prefix}_REGISTRY_READ_ACCOUNT` : `${prefix}_REGISTRY_CONTRACT_ID`;
      throw new RegistryConfigError(
        `Network "${network.name}" configures only one half of its registry (missing ${missing}). ` +
          'Set both, or unset both to leave discovery off for this network.'
      );
    }

    configs.set(network.name, {
      contractId,
      readAccount,
      // The network's own passphrase by default: a simulated read is only
      // valid against the chain the registry is deployed on.
      networkPassphrase: optional(env, `${prefix}_REGISTRY_NETWORK_PASSPHRASE`) ?? defaultPassphrase ?? network.networkPassphrase,
    });
  }

  return configs;
}

export class RegistryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryConfigError';
  }
}

/** Paginates through get_active_contracts and returns the contract IDs of every active entry. */
export async function getActiveContracts(
  rpcUrl: string,
  registryContractId: string,
  readAccount: string,
  networkPassphrase: string
): Promise<string[]> {
  const server = new rpc.Server(rpcUrl);
  const account = await server.getAccount(readAccount);
  const contract = new Contract(registryContractId);
  const contractIds: string[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_LIMIT;
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase })
      .addOperation(
        contract.call(
          'get_active_contracts',
          nativeToScVal(offset, { type: 'u32' }),
          nativeToScVal(PAGE_LIMIT, { type: 'u32' })
        )
      )
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Registry simulation failed: ${sim.error}`);
    }

    const entries = scValToNative(sim.result!.retval) as ContractEntry[];
    contractIds.push(...entries.map(e => e.contract_id));

    if (entries.length < PAGE_LIMIT) break;
  }

  return contractIds;
}
