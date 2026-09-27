/**
 * The persisted-query settings are configuration a client can observe: it
 * decides whether a hash-only request is answered or refused, and how long a
 * registration survives. Both are covered here so the answer to "why is my
 * client getting PERSISTED_QUERY_NOT_FOUND?" is a documented variable rather
 * than a reading of Apollo Server's source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERSISTED_QUERY_TTL_SECONDS,
  persistedQueryConfig,
  persistedQueryOption,
} from './persistedQueries';

test('an empty environment gives documented defaults', () => {
  const config = persistedQueryConfig({});

  assert.equal(config.enabled, true, 'APQ is on unless it is switched off');
  assert.equal(config.ttlSeconds, 604800, 'seven days');
  assert.equal(DEFAULT_PERSISTED_QUERY_TTL_SECONDS, 604800);
});

test('APQ can be switched off', () => {
  for (const value of ['false', '0', 'no', 'off', ' FALSE ', 'Off']) {
    assert.equal(persistedQueryConfig({ PERSISTED_QUERIES: value }).enabled, false, value);
  }
});

test('APQ can be switched on explicitly', () => {
  for (const value of ['true', '1', 'yes', 'on', ' Yes ']) {
    assert.equal(persistedQueryConfig({ PERSISTED_QUERIES: value }).enabled, true, value);
  }
});

test('a value that cannot be understood fails at startup', () => {
  // PERSISTED_QUERIES=falsee would otherwise silently leave APQ enabled, and
  // the operator who meant to turn it off would learn it from a client's
  // PERSISTED_QUERY_NOT_FOUND instead.
  assert.throws(
    () => persistedQueryConfig({ PERSISTED_QUERIES: 'falsee' }),
    /PERSISTED_QUERIES must be one of/
  );
});

test('the TTL is configurable and validated', () => {
  assert.equal(persistedQueryConfig({ PERSISTED_QUERIES_TTL_SECONDS: '3600' }).ttlSeconds, 3600);

  for (const bad of ['0', '-5', '1.5', 'soon']) {
    assert.throws(
      () => persistedQueryConfig({ PERSISTED_QUERIES_TTL_SECONDS: bad }),
      /PERSISTED_QUERIES_TTL_SECONDS must be a positive whole number/,
      bad
    );
  }
});

test('an empty value falls back to the default rather than failing', () => {
  const config = persistedQueryConfig({ PERSISTED_QUERIES: '', PERSISTED_QUERIES_TTL_SECONDS: '  ' });

  assert.equal(config.enabled, true);
  assert.equal(config.ttlSeconds, DEFAULT_PERSISTED_QUERY_TTL_SECONDS);
});

test('the Apollo option is a TTL when enabled and false when not', () => {
  assert.deepEqual(persistedQueryOption({ PERSISTED_QUERIES_TTL_SECONDS: '60' }), { ttl: 60 });
  // `false` is what makes Apollo answer PERSISTED_QUERY_NOT_SUPPORTED, so a
  // client falls back to sending full documents instead of retrying a hash.
  assert.equal(persistedQueryOption({ PERSISTED_QUERIES: 'false' }), false);
});
