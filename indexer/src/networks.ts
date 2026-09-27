/**
 * Network configuration — how one deployment declares the chains it serves.
 *
 * ## The scheme
 *
 * ```
 * NETWORKS=mainnet,testnet          # which networks exist, in declaration order
 * MAINNET_HORIZON_URL=…             # per-network endpoint(s)
 * MAINNET_SOROBAN_RPC_URL=…         # optional; unset disables contract events
 * MAINNET_NETWORK_PASSPHRASE=…      # optional; defaults per network name
 * PRIMARY_NETWORK=testnet           # which one is the default (first declared otherwise)
 * ```
 *
 * With `NETWORKS` unset the flat `HORIZON_URL` / `SOROBAN_RPC_URL` /
 * `NETWORK_PASSPHRASE` variables become a single network named by
 * `PRIMARY_NETWORK` (default `mainnet`), so an existing single-network
 * deployment keeps working without a configuration change.
 *
 * ## Why it fails loudly
 *
 * A partially configured network — declared in `NETWORKS` but missing its
 * `HORIZON_URL`, or a `<NAME>_HORIZON_URL` present while `NETWORKS` is not —
 * used to be indistinguishable from an intentional default. It surfaces
 * instead as an indexer quietly polling the wrong chain (or the mainnet
 * default) while the operator believes they configured testnet. Every case
 * below throws `NetworkConfigError` at startup with the variable to set.
 *
 * ## Why the names are a fixed set
 *
 * The GraphQL schema exposes a `Network` enum, and enums are static: the
 * declared names must be members of it or a client could not name the network
 * it is asking for. Adding a network to the enum is a schema change, which is
 * the point — the set of networks an API serves is a contract, not a runtime
 * string.
 *
 * This file is deliberately a second copy of `graphql-server/src/networks.ts`
 * rather than a shared import: the two packages don't share code (see
 * `graphql-server/src/horizon.ts` and `notifications.ts` for the same rule),
 * and each service reads its own configuration at its own startup.
 */

/** Networks the GraphQL schema's `Network` enum carries. */
export const KNOWN_NETWORKS = ['mainnet', 'testnet', 'futurenet'] as const;

/** Passphrase a network's transactions are signed against, by name. */
function defaultPassphrase(name: string): string {
  switch (name) {
    case 'testnet':
      return 'Test SDF Network ; September 2015';
    case 'futurenet':
      return 'Test SDF Future Network ; October 2022';
    default:
      return 'Public Global Stellar Network ; September 2015';
  }
}

/** Endpoint used when a flat (single-network) deployment sets no `HORIZON_URL`. */
export const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

export class NetworkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkConfigError';
  }
}

export interface NetworkConfig {
  /** Lowercase declared name — the value stored in the `network` column. */
  name: string;
  horizonUrl: string;
  /** Unset means Soroban event indexing is disabled for this network. */
  sorobanRpcUrl?: string;
  /** Passphrase transactions are signed against for this network. */
  networkPassphrase: string;
}

export interface NetworkRegistry {
  /** Declaration order — the first entry is the default primary. */
  networks: NetworkConfig[];
  primary: NetworkConfig;
}

type Env = Record<string, string | undefined>;

/** Split `NETWORKS` into trimmed, lowercased names — preserving order. */
function parseNetworkNames(env: Env): string[] | null {
  const raw = env['NETWORKS'];
  if (raw === undefined || raw.trim() === '') return null;

  const names = raw
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);

  if (names.length === 0) {
    throw new NetworkConfigError('NETWORKS is set but contains no network names.');
  }

  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new NetworkConfigError(`NETWORKS declares "${name}" twice.`);
    }
    seen.add(name);
    if (!(KNOWN_NETWORKS as readonly string[]).includes(name)) {
      throw new NetworkConfigError(
        `NETWORKS declares "${name}", which is not a known network. ` +
          `Known networks: ${KNOWN_NETWORKS.join(', ')}. ` +
          'Adding a network means adding it to the GraphQL `Network` enum first.'
      );
    }
  }
  return names;
}

/**
 * Every `<PREFIX>_<ENDPOINT>` variable that names a network, so a typo or a
 * network that was configured but never listed is caught rather than ignored.
 *
 * `REGISTRY_NETWORK_PASSPHRASE` deliberately does not match: it is a flat
 * variable whose prefix happens to look like one.
 */
function prefixedEndpointVars(env: Env): { key: string; prefix: string }[] {
  const suffixes = ['_HORIZON_URL', '_SOROBAN_RPC_URL'];
  return Object.keys(env)
    .map(key => ({ key, suffix: suffixes.find(suffix => key.endsWith(suffix)) }))
    .filter((entry): entry is { key: string; suffix: string } => entry.suffix !== undefined)
    .map(({ key, suffix }) => ({ key, prefix: key.slice(0, -suffix.length) }))
    .filter(({ prefix }) => prefix.length > 0);
}

function required(env: Env, key: string, network: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new NetworkConfigError(
      `Network "${network}" is declared but ${key} is not set. ` +
        `Set ${key}, or remove "${network}" from NETWORKS.`
    );
  }
  return value.trim();
}

function optional(env: Env, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function buildNetwork(env: Env, name: string, prefix: string): NetworkConfig {
  const network: NetworkConfig = {
    name,
    horizonUrl: required(env, `${prefix}_HORIZON_URL`, name),
    networkPassphrase: optional(env, `${prefix}_NETWORK_PASSPHRASE`) ?? defaultPassphrase(name),
  };
  const sorobanRpcUrl = optional(env, `${prefix}_SOROBAN_RPC_URL`);
  if (sorobanRpcUrl !== undefined) network.sorobanRpcUrl = sorobanRpcUrl;
  return network;
}

/**
 * Resolve every configured network, or throw `NetworkConfigError`.
 *
 * Call once at startup: a deployment with broken network configuration must
 * not come up and start indexing, because every failure mode after that point
 * is a data-correctness failure rather than an availability one.
 */
export function resolveNetworks(env: Env = process.env): NetworkRegistry {
  const names = parseNetworkNames(env);
  const declared = prefixedEndpointVars(env);

  if (names === null) {
    // Flat variables: a single network, exactly as before `NETWORKS` existed.
    if (declared.length > 0) {
      const list = declared.map(entry => entry.key).join(', ');
      throw new NetworkConfigError(
        `${list} set without NETWORKS. Add NETWORKS=<name>,… to declare the network it belongs to, ` +
          'or unset it and use the flat variables.'
      );
    }

    const name = (env['PRIMARY_NETWORK'] ?? 'mainnet').trim().toLowerCase();
    if (!(KNOWN_NETWORKS as readonly string[]).includes(name)) {
      throw new NetworkConfigError(
        `PRIMARY_NETWORK "${name}" is not a known network. Known networks: ${KNOWN_NETWORKS.join(', ')}.`
      );
    }

    const network: NetworkConfig = {
      name,
      horizonUrl: optional(env, 'HORIZON_URL') ?? DEFAULT_HORIZON_URL,
      networkPassphrase: optional(env, 'NETWORK_PASSPHRASE') ?? defaultPassphrase(name),
    };
    const sorobanRpcUrl = optional(env, 'SOROBAN_RPC_URL');
    if (sorobanRpcUrl !== undefined) network.sorobanRpcUrl = sorobanRpcUrl;

    return { networks: [network], primary: network };
  }

  const stray = declared.filter(({ prefix }) => !names.includes(prefix.toLowerCase()));
  if (stray.length > 0) {
    const list = stray.map(entry => entry.key).join(', ');
    throw new NetworkConfigError(
      `${list} name a network that NETWORKS does not declare (${names.join(', ')}). ` +
        'Add it to NETWORKS or unset the variable.'
    );
  }

  const networks = names.map(name => buildNetwork(env, name, name.toUpperCase()));

  const requested = optional(env, 'PRIMARY_NETWORK')?.toLowerCase();
  let primary: NetworkConfig | undefined = networks[0];
  if (requested !== undefined) {
    primary = networks.find(network => network.name === requested);
    if (primary === undefined) {
      throw new NetworkConfigError(
        `PRIMARY_NETWORK "${requested}" is not one of the declared networks: ${names.join(', ')}.`
      );
    }
  }
  if (primary === undefined) {
    // Unreachable: parseNetworkNames rejects an empty declaration.
    throw new NetworkConfigError('NETWORKS resolved to no networks.');
  }

  return { networks, primary };
}
