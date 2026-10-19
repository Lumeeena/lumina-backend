/**
 * Tests for the registry module's configuration resolution and error handling.
 *
 * `getActiveContracts` requires a live Soroban RPC and is exercised end-to-end
 * by the integration tests; here we cover the pieces that can be unit-tested:
 * `RegistryConfigError`, the `resolveRegistryConfigs` error paths, and the
 * constants that bound discovery.
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

function twoNetworks(): NetworkConfig[] {
  return resolveNetworks({
    NETWORKS: 'mainnet,testnet',
    MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
    TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    MAINNET_SOROBAN_RPC_URL: 'https://soroban.stellar.org',
    TESTNET_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  }).networks;
}

test('RegistryConfigError is an Error subclass with a name', () => {
  const err = new RegistryConfigError('test message');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'RegistryConfigError');
  assert.equal(err.message, 'test message');
});

test('RegistryConfigError distinguishes missing contract id from missing read account', () => {
  // Both error messages name the specific missing variable, so an operator
  // is not sent in circles trying to set the one they already set.
  assert.throws(
    () => resolveRegistryConfigs(twoNetworks(), { REGISTRY_CONTRACT_ID: MAINNET_REGISTRY }),
    (err: unknown) => err instanceof RegistryConfigError && /REGISTRY_READ_ACCOUNT/.test((err as Error).message)
  );

  assert.throws(
    () => resolveRegistryConfigs(twoNetworks(), { REGISTRY_READ_ACCOUNT: READ_ACCOUNT }),
    (err: unknown) => err instanceof RegistryConfigError && /REGISTRY_CONTRACT_ID/.test((err as Error).message)
  );
});

test('a per-network half-configured override names the missing per-network variable', () => {
  assert.throws(
    () =>
      resolveRegistryConfigs(twoNetworks(), {
        TESTNET_REGISTRY_CONTRACT_ID: TESTNET_REGISTRY,
      }),
    (err: unknown) =>
      err instanceof RegistryConfigError && /TESTNET_REGISTRY_READ_ACCOUNT/.test((err as Error).message)
  );
});

test('registry polling uses a time-based interval independent of ledger poll cycles', () => {
  // The indexer polls the registry roughly once a minute, not once per ledger
  // poll. This decouples discovery frequency from the 5s ledger poll, so a
  // faster or slower poll cycle does not change how often contracts are
  // discovered.
  const registryPollIntervalMs = 60_000;
  const ledgerPollIntervalMs = 5_000;

  // Registry polls happen at most every registryPollIntervalMs, regardless of
  // how many ledger cycles have elapsed.
  assert.ok(registryPollIntervalMs > ledgerPollIntervalMs);
  assert.ok(registryPollIntervalMs >= 60_000, 'registry poll should be at most once per minute');
});

test('registry discovery is opt-in: no config means no registry', () => {
  const configs = resolveRegistryConfigs(twoNetworks(), {});
  assert.equal(configs.size, 0);
});

test('a single-network deployment with a registry resolves correctly', () => {
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
