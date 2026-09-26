import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkConfigError, resolveNetworks } from './networks';

test('no configuration at all resolves to a single mainnet network', () => {
  const registry = resolveNetworks({});
  assert.equal(registry.networks.length, 1);
  assert.equal(registry.primary.name, 'mainnet');
  assert.equal(registry.primary.horizonUrl, 'https://horizon.stellar.org');
  assert.equal(registry.primary.sorobanRpcUrl, undefined);
});

test('an existing single-network deployment needs no configuration change', () => {
  const registry = resolveNetworks({
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    REGISTRY_CONTRACT_ID: 'CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ',
    REGISTRY_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  });

  assert.equal(registry.networks.length, 1);
  assert.equal(registry.primary.name, 'mainnet');
  assert.equal(registry.primary.horizonUrl, 'https://horizon-testnet.stellar.org');
  assert.equal(registry.primary.sorobanRpcUrl, 'https://soroban-testnet.stellar.org');
});

test('flat variables can be renamed with PRIMARY_NETWORK', () => {
  const registry = resolveNetworks({
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    PRIMARY_NETWORK: 'testnet',
  });
  assert.equal(registry.primary.name, 'testnet');
  assert.equal(registry.primary.horizonUrl, 'https://horizon-testnet.stellar.org');
  assert.equal(registry.primary.networkPassphrase, 'Test SDF Network ; September 2015');
});

test('NETWORKS declares several networks and both resolve', () => {
  const registry = resolveNetworks({
    NETWORKS: 'mainnet,testnet',
    MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
    TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    TESTNET_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  });

  assert.deepEqual(
    registry.networks.map(network => network.name),
    ['mainnet', 'testnet']
  );
  assert.equal(registry.primary.name, 'mainnet');

  const testnet = registry.networks[1];
  assert.ok(testnet);
  assert.equal(testnet.horizonUrl, 'https://horizon-testnet.stellar.org');
  assert.equal(testnet.sorobanRpcUrl, 'https://soroban-testnet.stellar.org');
  assert.equal(testnet.networkPassphrase, 'Test SDF Network ; September 2015');
});

test('PRIMARY_NETWORK chooses which declared network is the default', () => {
  const registry = resolveNetworks({
    NETWORKS: 'mainnet,testnet',
    PRIMARY_NETWORK: 'testnet',
    MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
    TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  });
  assert.equal(registry.primary.name, 'testnet');
  assert.equal(registry.primary.horizonUrl, 'https://horizon-testnet.stellar.org');
});

test('a declared network with no HORIZON_URL fails naming the variable', () => {
  assert.throws(
    () =>
      resolveNetworks({
        NETWORKS: 'mainnet,testnet',
        MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
      }),
    (err: unknown) => {
      assert.ok(err instanceof NetworkConfigError);
      assert.match(err.message, /"testnet" is declared but TESTNET_HORIZON_URL is not set/);
      return true;
    }
  );
});

test('a per-network variable without NETWORKS fails rather than being ignored', () => {
  assert.throws(
    () => resolveNetworks({ TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org' }),
    (err: unknown) => {
      assert.ok(err instanceof NetworkConfigError);
      assert.match(err.message, /TESTNET_HORIZON_URL set without NETWORKS/);
      return true;
    }
  );
});

test('a per-network variable for an undeclared network fails', () => {
  assert.throws(
    () =>
      resolveNetworks({
        NETWORKS: 'mainnet',
        MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
        FUTURENET_HORIZON_URL: 'https://horizon-futurenet.stellar.org',
      }),
    (err: unknown) => {
      assert.ok(err instanceof NetworkConfigError);
      assert.match(err.message, /FUTURENET_HORIZON_URL name a network that NETWORKS does not declare/);
      return true;
    }
  );
});

test('an unknown network name fails rather than inventing one', () => {
  assert.throws(
    () => resolveNetworks({ NETWORKS: 'mainnet,staging', MAINNET_HORIZON_URL: 'https://h' }),
    (err: unknown) => {
      assert.ok(err instanceof NetworkConfigError);
      assert.match(err.message,     /declares "staging", which is not a known network/);
      return true;
    }
  );
});

test('a network declared twice fails', () => {
  assert.throws(
    () => resolveNetworks({ NETWORKS: 'mainnet,MAINNET', MAINNET_HORIZON_URL: 'https://h' }),
    /declares "mainnet" twice/
  );
});

test('PRIMARY_NETWORK must name a declared network', () => {
  assert.throws(
    () =>
      resolveNetworks({
        NETWORKS: 'mainnet,testnet',
        PRIMARY_NETWORK: 'futurenet',
        MAINNET_HORIZON_URL: 'https://h1',
        TESTNET_HORIZON_URL: 'https://h2',
      }),
    /PRIMARY_NETWORK "futurenet" is not one of the declared networks/
  );
});
