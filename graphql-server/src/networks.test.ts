import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphQLError } from 'graphql';
import { NetworkConfigError, resolveNetworkArgument, resolveNetworks } from './networks';

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
