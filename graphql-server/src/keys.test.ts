import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateApiKey,
  hashApiKey,
  deriveKeyPrefix,
  createApiKey,
  listApiKeys,
  getApiKey,
  revokeApiKey,
  setApiKeyLimit,
} from './keys';
import { runCli, parsePositiveInteger } from './manageKeys';

function createMockPool(rowsToReturn: any[] = []) {
  const queries: { sql: string; params: any[] }[] = [];
  return {
    queries,
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      return { rows: rowsToReturn, rowCount: rowsToReturn.length };
    },
    end: async () => {},
  } as any;
}

describe('API Keys — Generation & Hashing', () => {
  it('generates high entropy keys with lum_ prefix', () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();

    assert.ok(key1.startsWith('lum_'));
    assert.ok(key2.startsWith('lum_'));
    assert.equal(key1.length, 68); // "lum_" + 64 hex characters
    assert.notEqual(key1, key2);
  });

  it('computes deterministic SHA-256 hash', () => {
    const key = 'lum_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const hash1 = hashApiKey(key);
    const hash2 = hashApiKey(key);

    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
    assert.match(hash1, /^[0-9a-f]{64}$/);
  });

  it('derives key prefix for human display', () => {
    const key = 'lum_1234567890abcdef';
    const prefix = deriveKeyPrefix(key);
    assert.equal(prefix, 'lum_12345678...');
  });
});

describe('API Keys — DB Operations', () => {
  it('createApiKey inserts key hash and returns plaintext key exactly once', async () => {
    const now = new Date();
    const mockRow = {
      id: 1,
      key_hash: 'mockhash',
      key_prefix: 'lum_12345678...',
      label: 'test-app',
      rate_limit: 120,
      created_at: now,
      revoked_at: null,
      updated_at: now,
    };
    const pool = createMockPool([mockRow]);

    const created = await createApiKey(pool, 'test-app', 120);

    assert.equal(pool.queries.length, 1);
    assert.match(pool.queries[0].sql, /INSERT INTO api_keys/);
    assert.equal(pool.queries[0].params[2], 'test-app');
    assert.equal(pool.queries[0].params[3], 120);

    assert.equal(created.id, 1);
    assert.equal(created.label, 'test-app');
    assert.equal(created.rateLimit, 120);
    assert.ok(created.plaintextKey.startsWith('lum_'));
    // Ensure the hash in DB matches the plaintext key
    assert.equal(pool.queries[0].params[0], hashApiKey(created.plaintextKey));
  });

  it('createApiKey rejects empty label and invalid rate limits', async () => {
    const pool = createMockPool();
    await assert.rejects(
      async () => createApiKey(pool, '   '),
      /API key label cannot be empty/
    );
    await assert.rejects(
      async () => createApiKey(pool, 'valid-label', 0),
      /Rate limit must be a positive integer/
    );
    await assert.rejects(
      async () => createApiKey(pool, 'valid-label', -5),
      /Rate limit must be a positive integer/
    );
  });

  it('listApiKeys retrieves all keys without plaintext', async () => {
    const now = new Date();
    const rows = [
      {
        id: 1,
        key_hash: 'hash1',
        key_prefix: 'lum_11111111...',
        label: 'app-1',
        rate_limit: 60,
        created_at: now,
        revoked_at: null,
        updated_at: now,
      },
      {
        id: 2,
        key_hash: 'hash2',
        key_prefix: 'lum_22222222...',
        label: 'app-2',
        rate_limit: 100,
        created_at: now,
        revoked_at: now,
        updated_at: now,
      },
    ];
    const pool = createMockPool(rows);

    const keys = await listApiKeys(pool);
    assert.match(pool.queries[0].sql, /ORDER BY created_at DESC, id DESC/);
    assert.equal(keys.length, 2);
    assert.equal(keys[0].id, 1);
    assert.equal(keys[0].label, 'app-1');
    assert.equal(keys[1].id, 2);
    assert.ok(keys[1].revokedAt instanceof Date);
    // Plaintext key is NOT part of ApiKeyRecord
    assert.equal((keys[0] as any).plaintextKey, undefined);
  });

  it('getApiKey retrieves key metadata by id or hash', async () => {
    const now = new Date();
    const mockRow = {
      id: 5,
      key_hash: 'hash5',
      key_prefix: 'lum_55555555...',
      label: 'app-5',
      rate_limit: 60,
      created_at: now,
      revoked_at: null,
      updated_at: now,
    };
    const pool = createMockPool([mockRow]);

    const keyById = await getApiKey(pool, 5);
    assert.ok(keyById);
    assert.equal(keyById.id, 5);
    assert.equal(pool.queries[0].params[0], 5);

    const keyByHash = await getApiKey(pool, 'hash5');
    assert.ok(keyByHash);
    assert.equal(keyByHash.id, 5);
  });

  it('revokeApiKey updates revoked_at', async () => {
    const now = new Date();
    const mockRow = {
      id: 3,
      key_hash: 'hash3',
      key_prefix: 'lum_33333333...',
      label: 'revoked-app',
      rate_limit: 60,
      created_at: now,
      revoked_at: now,
      updated_at: now,
    };
    const pool = createMockPool([mockRow]);

    const revoked = await revokeApiKey(pool, 3);
    assert.equal(revoked.id, 3);
    assert.ok(revoked.revokedAt);
    assert.match(pool.queries[0].sql, /UPDATE api_keys/);
    assert.match(pool.queries[0].sql, /revoked_at = NOW\(\)/);
  });

  it('setApiKeyLimit updates rate limit and validates input', async () => {
    const now = new Date();
    const mockRow = {
      id: 4,
      key_hash: 'hash4',
      key_prefix: 'lum_44444444...',
      label: 'limited-app',
      rate_limit: 250,
      created_at: now,
      revoked_at: null,
      updated_at: now,
    };
    const pool = createMockPool([mockRow]);

    const updated = await setApiKeyLimit(pool, 4, 250);
    assert.equal(updated.rateLimit, 250);
    assert.equal(pool.queries[0].params[1], 250);

    await assert.rejects(
      async () => setApiKeyLimit(pool, 4, -10),
      /Rate limit must be a positive integer/
    );
  });
});

describe('API Keys — CLI command execution', () => {
  it('manage-keys create displays plaintext key and warning', async () => {
    const now = new Date();
    const mockRow = {
      id: 10,
      key_hash: 'hash10',
      key_prefix: 'lum_10101010...',
      label: 'cli-test',
      rate_limit: 80,
      created_at: now,
      revoked_at: null,
      updated_at: now,
    };
    const pool = createMockPool([mockRow]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...msgs) => logs.push(msgs.join(' '));

    try {
      await runCli(['create', 'cli-test', '80'], pool);
      const output = logs.join('\n');
      assert.match(output, /API key created successfully!/);
      assert.match(output, /Plaintext API Key:/);
      assert.match(output, /lum_/);
      assert.match(output, /stored ONLY as a cryptographic hash/);
      assert.match(output, /will NEVER be shown again/);
    } finally {
      console.log = origLog;
    }
  });

  it('manage-keys show displays metadata and refuses to show plaintext key', async () => {
    const now = new Date();
    const mockRow = {
      id: 11,
      key_hash: 'hash11',
      key_prefix: 'lum_11111111...',
      label: 'cli-show',
      rate_limit: 60,
      created_at: now,
      revoked_at: null,
      updated_at: now,
    };
    const pool = createMockPool([mockRow]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...msgs) => logs.push(msgs.join(' '));

    try {
      await runCli(['show', '11'], pool);
      const output = logs.join('\n');
      assert.match(output, /API Key #11 Metadata:/);
      assert.match(output, /lum_11111111\.\.\./);
      assert.match(output, /\[SECURITY NOTICE\] Plaintext key cannot be shown: only the SHA-256 hash is stored\./);
    } finally {
      console.log = origLog;
    }
  });

  it('manage-keys list outputs formatted table', async () => {
    const now = new Date();
    const mockRows = [
      {
        id: 1,
        key_hash: 'hash1',
        key_prefix: 'lum_11111111...',
        label: 'first-key',
        rate_limit: 60,
        created_at: now,
        revoked_at: null,
        updated_at: now,
      },
    ];
    const pool = createMockPool(mockRows);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...msgs) => logs.push(msgs.join(' '));

    try {
      await runCli(['list'], pool);
      const output = logs.join('\n');
      assert.match(output, /PREFIX/);
      assert.match(output, /first-key/);
      assert.match(output, /ACTIVE/);
    } finally {
      console.log = origLog;
    }
  });

  it('manage-keys revoke confirms revocation', async () => {
    const now = new Date();
    const mockRow = {
      id: 1,
      key_hash: 'hash1',
      key_prefix: 'lum_11111111...',
      label: 'first-key',
      rate_limit: 60,
      created_at: now,
      revoked_at: now,
      updated_at: now,
    };
    const pool = createMockPool([mockRow]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...msgs) => logs.push(msgs.join(' '));

    try {
      await runCli(['revoke', '1'], pool);
      const output = logs.join('\n');
      assert.match(output, /Revoked API key #1/);
    } finally {
      console.log = origLog;
    }
  });

  it('manage-keys set-limit confirms limit change', async () => {
    const now = new Date();
    const mockRow = {
      id: 1,
      key_hash: 'hash1',
      key_prefix: 'lum_11111111...',
      label: 'first-key',
      rate_limit: 150,
      created_at: now,
      revoked_at: null,
      updated_at: now,
    };
    const pool = createMockPool([mockRow]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...msgs) => logs.push(msgs.join(' '));

    try {
      await runCli(['set-limit', '1', '150'], pool);
      const output = logs.join('\n');
      assert.match(output, /Updated rate limit for API key #1 .* to 150 req\/min/);
    } finally {
      console.log = origLog;
    }
  });
});

describe('API Keys — CLI input validation', () => {
  it('parsePositiveInteger accepts valid positive integers', () => {
    assert.equal(parsePositiveInteger('1'), 1);
    assert.equal(parsePositiveInteger('60'), 60);
    assert.equal(parsePositiveInteger('1000'), 1000);
    assert.equal(parsePositiveInteger('  120  '), 120);
  });

  it('parsePositiveInteger rejects strings with non-numeric suffixes or float/exponent syntax', () => {
    assert.equal(parsePositiveInteger('10foo'), null);
    assert.equal(parsePositiveInteger('10.5'), null);
    assert.equal(parsePositiveInteger('1e3'), null);
    assert.equal(parsePositiveInteger('0'), null);
    assert.equal(parsePositiveInteger('-5'), null);
    assert.equal(parsePositiveInteger(''), null);
    assert.equal(parsePositiveInteger('abc'), null);
  });
});
