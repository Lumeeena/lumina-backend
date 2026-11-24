import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphQLError } from 'graphql';
import { DEFAULT_HORIZON_URL, NetworkConfigError, resolveNetworkArgument, resolveNetworks } from './networks';

const twoNetworks = resolveNetworks({
  NETWORKS: 'mainnet,testnet',
  PRIMARY_NETWORK: 'testnet',
  MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
  TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
});

test('the API resolves the same networks the indexer does', () => {
  assert.deepEqual(
    twoNetworks.networks.map(network => network.name),
    ['mainnet', 'testnet']
  );
  assert.equal(twoNetworks.primary.name, 'testnet');
  assert.equal(twoNetworks.primary.horizonUrl, 'https://horizon-testnet.stellar.org');
});

test('flat configuration resolves to one network with no configuration change', () => {
  const registry = resolveNetworks({ HORIZON_URL: 'https://horizon.stellar.org' });
  assert.equal(registry.networks.length, 1);
  assert.equal(registry.primary.name, 'mainnet');
});

test('a partially configured network fails at startup', () => {
  assert.throws(
    () => resolveNetworks({ NETWORKS: 'mainnet,testnet', MAINNET_HORIZON_URL: 'https://h' }),
    (err: unknown) => {
      assert.ok(err instanceof NetworkConfigError);
      assert.match(err.message, /TESTNET_HORIZON_URL is not set/);
      return true;
    }
  );
});

test('omitting network: resolves to the configured primary', () => {
  assert.equal(resolveNetworkArgument(undefined, twoNetworks).name, 'testnet');
  assert.equal(resolveNetworkArgument(null, twoNetworks).name, 'testnet');
});

test('naming a configured network resolves to exactly that network', () => {
  const resolved = resolveNetworkArgument('MAINNET', twoNetworks);
  assert.equal(resolved.name, 'mainnet');
  assert.equal(resolved.horizonUrl, 'https://horizon.stellar.org');
});

test('naming a network this deployment does not serve is an error, not a fallback', () => {
  assert.throws(
    () => resolveNetworkArgument('FUTURENET', twoNetworks),
    (err: unknown) => {
      assert.ok(err instanceof GraphQLError);
      assert.equal(err.extensions['code'], 'BAD_USER_INPUT');
      assert.match(err.message, /FUTURENET" is not configured on this deployment/);
      assert.match(err.message, /Configured networks: MAINNET, TESTNET/);
      return true;
    }
  );
});

// The rows of the "What fails loudly" table in docs/MULTI_NETWORK.md that the
// partial-network test above does not already cover. Each one is a
// configuration the indexer and the API would otherwise resolve differently or
// quietly ignore.
test('every other misconfiguration in the fail-loudly table is refused at startup', () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['an endpoint set without NETWORKS', { MAINNET_HORIZON_URL: 'https://h' }, /MAINNET_HORIZON_URL set without NETWORKS/],
    [
      'an endpoint for a network NETWORKS does not declare',
      { NETWORKS: 'mainnet', MAINNET_HORIZON_URL: 'https://h', TESTNET_HORIZON_URL: 'https://t' },
      /TESTNET_HORIZON_URL name a network that NETWORKS does not declare/,
    ],
    ['an unknown network name', { NETWORKS: 'mainnet,foonet', MAINNET_HORIZON_URL: 'https://h' }, /"foonet", which is not a known network/],
    ['a network named twice', { NETWORKS: 'testnet,testnet', TESTNET_HORIZON_URL: 'https://t' }, /"testnet" twice/],
    [
      'a primary that NETWORKS does not declare',
      { NETWORKS: 'mainnet', MAINNET_HORIZON_URL: 'https://h', PRIMARY_NETWORK: 'testnet' },
      /PRIMARY_NETWORK "testnet" is not one of the declared networks/,
    ],
    ['an unknown flat primary', { PRIMARY_NETWORK: 'localnet' }, /PRIMARY_NETWORK "localnet" is not a known network/],
  ];

  for (const [what, env, message] of cases) {
    assert.throws(
      () => resolveNetworks(env),
      (err: unknown) => {
        assert.ok(err instanceof NetworkConfigError, `${what} should throw NetworkConfigError`);
        assert.match(err.message, message);
        return true;
      },
      what
    );
  }
});

test('a flat deployment with no configuration defaults to the public mainnet endpoint and passphrase', () => {
  const registry = resolveNetworks({});

  assert.equal(registry.primary.name, 'mainnet');
  assert.equal(registry.primary.horizonUrl, DEFAULT_HORIZON_URL);
  assert.equal(registry.primary.networkPassphrase, 'Public Global Stellar Network ; September 2015');
  assert.equal(registry.primary.sorobanRpcUrl, undefined, 'contract event indexing stays off unless configured');
});

test('each network signs against its own default passphrase, and a comma-separated endpoint list is kept', () => {
  const registry = resolveNetworks({
    NETWORKS: 'testnet,futurenet',
    TESTNET_HORIZON_URL: 'https://a.example, https://b.example',
    FUTURENET_HORIZON_URL: 'https://f.example',
    FUTURENET_NETWORK_PASSPHRASE: 'custom futurenet',
  });
  const [testnet, futurenet] = registry.networks;

  assert.equal(registry.primary.name, 'testnet', 'the first declared network is primary when PRIMARY_NETWORK is unset');
  assert.equal(testnet.networkPassphrase, 'Test SDF Network ; September 2015');
  assert.deepEqual(testnet.horizonUrl, ['https://a.example', 'https://b.example']);
  assert.equal(futurenet.networkPassphrase, 'custom futurenet', 'a configured passphrase overrides the default');
  assert.equal(futurenet.horizonUrl, 'https://f.example', 'a single endpoint stays a string');
});
