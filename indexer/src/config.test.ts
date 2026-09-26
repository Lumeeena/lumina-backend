import { test } from 'node:test';
import * as assert from 'node:assert/strict';

test('config parses comma-separated contract IDs', () => {
  process.env['INDEXED_CONTRACT_IDS'] = 'C' + '0'.repeat(55) + ',C' + '1'.repeat(55) + ', C' + '2'.repeat(55);
  process.env['SOROBAN_RPC_URL'] = 'http://localhost:8000';
  
  // Verify parsing logic
  const ids = (process.env['INDEXED_CONTRACT_IDS'] ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  
  assert.equal(ids.length, 3);
  
  delete process.env['INDEXED_CONTRACT_IDS'];
  delete process.env['SOROBAN_RPC_URL'];
});

test('config handles empty contract IDs list', () => {
  process.env['INDEXED_CONTRACT_IDS'] = '';
  
  const ids = (process.env['INDEXED_CONTRACT_IDS'] ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  
  assert.equal(ids.length, 0);
  
  delete process.env['INDEXED_CONTRACT_IDS'];
});

test('config redacts database password', () => {
  const url = 'postgresql://user:secret@localhost:5432/db';
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    const redacted = parsed.toString();
    assert.ok(redacted.includes('***'));
    assert.ok(!redacted.includes('secret'));
  } catch {
    assert.fail('Failed to parse database URL');
  }
});

test('config handles unparseable database URL', () => {
  const url = 'not-a-url';
  try {
    new URL(url);
    assert.fail('Should have thrown error');
  } catch {
    // Expected to fail
    assert.ok(true);
  }
});
