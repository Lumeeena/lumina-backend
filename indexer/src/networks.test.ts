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

test('history archive URLs may be configured per network', () => {
  const registry = resolveNetworks({
    NETWORKS: 'mainnet,testnet',
    MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
    MAINNET_HISTORY_ARCHIVE_URL: 'https://history.example/mainnet',
    TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  });

  assert.equal(registry.networks[0]?.historyArchiveUrl, 'https://history.example/mainnet');
  assert.equal(registry.networks[1]?.historyArchiveUrl, undefined);
});

test('history archive URL is supported for a flat single-network deployment', () => {
  const registry = resolveNetworks({
    HORIZON_URL: 'https://horizon.stellar.org',
    HISTORY_ARCHIVE_URL: 'https://history.example/mainnet',
  });

  assert.equal(registry.primary.historyArchiveUrl, 'https://history.example/mainnet');
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

// ── Default passphrases ───────────────────────────────────────────────────

test('testnet gets the correct default passphrase', () => {
  const registry = resolveNetworks({
    NETWORKS: 'testnet',
    TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  });
  assert.equal(registry.primary.networkPassphrase, 'Test SDF Network ; September 2015');
});

test('futurenet gets the correct default passphrase', () => {
  const registry = resolveNetworks({
    NETWORKS: 'futurenet',
    FUTURENET_HORIZON_URL: 'https://horizon-futurenet.stellar.org',
  });
  assert.equal(registry.primary.networkPassphrase, 'Test SDF Future Network ; October 2022');
});

test('mainnet gets the public Stellar passphrase by default', () => {
  const registry = resolveNetworks({});
  assert.equal(registry.primary.networkPassphrase, 'Public Global Stellar Network ; September 2015');
});

test('a custom NETWORK_PASSPHRASE overrides the default in single-network mode', () => {
  const registry = resolveNetworks({ NETWORK_PASSPHRASE: 'My Custom Network ; 2025' });
  assert.equal(registry.primary.networkPassphrase, 'My Custom Network ; 2025');
});

test('a per-network passphrase override is respected in multi-network mode', () => {
  const registry = resolveNetworks({
    NETWORKS: 'testnet',
    TESTNET_HORIZON_URL: 'https://h',
    TESTNET_NETWORK_PASSPHRASE: 'Custom Testnet Passphrase',
  });
  assert.equal(registry.primary.networkPassphrase, 'Custom Testnet Passphrase');
});

// ── Blank / whitespace NETWORKS ───────────────────────────────────────────

test('NETWORKS set to empty string falls back to single-network mode', () => {
  // An empty string is treated the same as unset so that a deployment can
  // clear the variable without also removing all the per-network keys.
  const registry = resolveNetworks({ NETWORKS: '', HORIZON_URL: 'https://h' });
  assert.equal(registry.networks.length, 1);
  assert.equal(registry.primary.horizonUrl, 'https://h');
});

test('NETWORKS set to whitespace-only falls back to single-network mode', () => {
  const registry = resolveNetworks({ NETWORKS: '   ', HORIZON_URL: 'https://h' });
  assert.equal(registry.networks.length, 1);
});

// ── PRIMARY_NETWORK in single-network mode with unknown name ─────────────

test('PRIMARY_NETWORK set to an unknown network name fails in single-network mode', () => {
  assert.throws(
    () => resolveNetworks({ PRIMARY_NETWORK: 'staging' }),
    (err: unknown) => {
      assert.ok(err instanceof NetworkConfigError);
      assert.match(err.message, /PRIMARY_NETWORK "staging" is not a known network/);
      return true;
    }
  );
});
