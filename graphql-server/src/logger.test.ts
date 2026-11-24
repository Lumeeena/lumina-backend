/**
 * The logger reads `LOG_LEVEL` and `LOG_PRETTY` once, when the module loads, so
 * these tests check the configuration it produced rather than changing the
 * environment and re-importing. The tests assert on bindings and level, not on
 * the bytes written to stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger, subsystem } from './logger';

test('the root level follows LOG_LEVEL and defaults to info', () => {
  assert.equal(logger.level, process.env.LOG_LEVEL ?? 'info');
});

test('every line from the root logger carries the service name', () => {
  assert.equal(logger.bindings().service, 'lumina-graphql');
});

test('subsystem() tags its lines with the module name', () => {
  const horizon = subsystem('horizon');

  assert.equal(horizon.bindings().subsystem, 'horizon');
  assert.equal(horizon.bindings().service, 'lumina-graphql');
});

test('a correlation id is bound only when one is passed', () => {
  assert.equal(subsystem('auth').bindings().correlationId, undefined);
  assert.equal(subsystem('auth', 'req-42').bindings().correlationId, 'req-42');
});

test('a subsystem logger inherits the root level', () => {
  assert.equal(subsystem('auth').level, logger.level);
});
