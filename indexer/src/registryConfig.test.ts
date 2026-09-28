/**
 * Per-network registry configuration.
 *
 * Each network has its own registry deployment, its own read account and — the
 * one that is easy to get wrong — its own passphrase. A simulated read signed
 * against the wrong chain's passphrase fails, and the failure is invisible
 * until someone notices a network that never discovers anything. So the
 * resolution is asserted here rather than inferred from the variables being
 * present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RegistryConfigError, resolveRegistryConfigs } from './registry';
import { resolveNetworks, type NetworkConfig } from './networks';

const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

const MAINNET_REGISTRY = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const TESTNET_REGISTRY = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';
const READ_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Networks with a Soroban RPC, since discovery reads through one. */
function twoNetworks(): NetworkConfig[] {
  return resolveNetworks({
    NETWORKS: 'mainnet,testnet',
    MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
    TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    MAINNET_SOROBAN_RPC_URL: 'https://soroban.stellar.org',
    TESTNET_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  }).networks;
}

test('no registry configuration leaves every network without a registry', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {});
  assert.equal(configs.size, 0);
});

test('the flat variables become the default every network inherits', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {
    REGISTRY_CONTRACT_ID: MAINNET_REGISTRY,
    REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
  });

  assert.equal(configs.size, 2);
  assert.equal(configs.get('mainnet')?.contractId, MAINNET_REGISTRY);
  assert.equal(configs.get('testnet')?.contractId, MAINNET_REGISTRY);
});

test('each network reads its own registry when it configures one', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {
    REGISTRY_CONTRACT_ID: MAINNET_REGISTRY,
    REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
    TESTNET_REGISTRY_CONTRACT_ID: TESTNET_REGISTRY,
    TESTNET_REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
  });

  assert.equal(configs.get('mainnet')?.contractId, MAINNET_REGISTRY);
  assert.equal(configs.get('testnet')?.contractId, TESTNET_REGISTRY);
});

test('a network with only its own registry configures no default and still resolves', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {
    TESTNET_REGISTRY_CONTRACT_ID: TESTNET_REGISTRY,
    TESTNET_REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
  });

  // This is the common shape: a project deploys its registry to testnet first
  // and has not deployed one to mainnet yet.
  assert.equal(configs.has('mainnet'), false);
  assert.equal(configs.get('testnet')?.contractId, TESTNET_REGISTRY);
});

test('the passphrase comes from the network the registry is deployed on', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {
    MAINNET_REGISTRY_CONTRACT_ID: MAINNET_REGISTRY,
    MAINNET_REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
    TESTNET_REGISTRY_CONTRACT_ID: TESTNET_REGISTRY,
    TESTNET_REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
  });

  // The point of the whole change: a single process-level passphrase is wrong
  // for every network but one.
  assert.equal(configs.get('mainnet')?.networkPassphrase, MAINNET_PASSPHRASE);
  assert.equal(configs.get('testnet')?.networkPassphrase, TESTNET_PASSPHRASE);
});

test('a single network override does not leak its passphrase to the others', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {
    REGISTRY_CONTRACT_ID: MAINNET_REGISTRY,
    REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
    TESTNET_REGISTRY_NETWORK_PASSPHRASE: 'A Private Network ; July 2026',
  });

  assert.equal(configs.get('testnet')?.networkPassphrase, 'A Private Network ; July 2026');
  assert.equal(configs.get('mainnet')?.networkPassphrase, MAINNET_PASSPHRASE);
});

test('the flat passphrase still overrides every network, for a cross-chain registry', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {
    REGISTRY_CONTRACT_ID: MAINNET_REGISTRY,
    REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
    REGISTRY_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
  });

  // A registry that does not live on the network it is registered under: the
  // case the flat override exists for, so it must still work.
  assert.equal(configs.get('mainnet')?.networkPassphrase, TESTNET_PASSPHRASE);
  assert.equal(configs.get('testnet')?.networkPassphrase, TESTNET_PASSPHRASE);
});

test('a per-network passphrase beats the flat one', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {
    REGISTRY_CONTRACT_ID: MAINNET_REGISTRY,
    REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
    REGISTRY_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
    MAINNET_REGISTRY_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
  });

  assert.equal(configs.get('mainnet')?.networkPassphrase, MAINNET_PASSPHRASE);
  assert.equal(configs.get('testnet')?.networkPassphrase, TESTNET_PASSPHRASE);
});

test('a contract id without a read account is an error, not a silent skip', () => {
  assert.throws(
    () => resolveRegistryConfigs(twoNetworks(), { REGISTRY_CONTRACT_ID: MAINNET_REGISTRY }),
    (err: unknown) => err instanceof RegistryConfigError && /REGISTRY_READ_ACCOUNT/.test(err.message)
  );
});

test('a read account without a contract id is an error too', () => {
  assert.throws(
    () => resolveRegistryConfigs(twoNetworks(), { REGISTRY_READ_ACCOUNT: READ_ACCOUNT }),
    (err: unknown) => err instanceof RegistryConfigError && /REGISTRY_CONTRACT_ID/.test(err.message)
  );
});

test('a network override inherits the flat half it does not set', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {
    REGISTRY_CONTRACT_ID: MAINNET_REGISTRY,
    REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
    TESTNET_REGISTRY_CONTRACT_ID: TESTNET_REGISTRY,
  });

  // Both halves resolve, so no error: overriding only the contract is a
  // complete configuration when the read account is the same on both chains.
  assert.equal(configs.get('testnet')?.contractId, TESTNET_REGISTRY);
  assert.equal(configs.get('testnet')?.readAccount, READ_ACCOUNT);
});

test('a half-configured network override with no flat default names the variable to set', () => {
  // Discovery that quietly does not happen is indistinguishable from a registry
  // with no contracts in it, so the failure is at startup.
  assert.throws(
    () =>
      resolveRegistryConfigs(twoNetworks(), {
        TESTNET_REGISTRY_CONTRACT_ID: TESTNET_REGISTRY,
      }),
    (err: unknown) =>
      err instanceof RegistryConfigError && /TESTNET_REGISTRY_READ_ACCOUNT/.test(err.message)
  );
});

test('an empty override variable counts as unset rather than as a broken registry', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {
    REGISTRY_CONTRACT_ID: MAINNET_REGISTRY,
    REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
    TESTNET_REGISTRY_CONTRACT_ID: '   ',
    TESTNET_REGISTRY_READ_ACCOUNT: '',
  });

  assert.equal(configs.size, 2);
  assert.equal(configs.get('testnet')?.contractId, MAINNET_REGISTRY);
});

test('a single-network deployment resolves exactly as it did before', () => {
  const networks = resolveNetworks({
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    PRIMARY_NETWORK: 'testnet',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  }).networks;

  const configs = resolveRegistryConfigs(networks, {
    REGISTRY_CONTRACT_ID: TESTNET_REGISTRY,
    REGISTRY_READ_ACCOUNT: READ_ACCOUNT,
  });

  assert.equal(configs.size, 1);
  assert.equal(configs.get('testnet')?.contractId, TESTNET_REGISTRY);
  assert.equal(configs.get('testnet')?.networkPassphrase, TESTNET_PASSPHRASE);
});
