/**
 * Tests for `@lumina/shared`'s file-delivered secrets (shared/src/secrets.ts).
 *
 * Both services resolve DATABASE_URL through this, so the cases that matter are
 * the ones a deployment hits: the plain variable still working unchanged, each
 * file form, a password that needs escaping, and the misconfigurations that
 * must stop startup rather than connect with the wrong credential.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import { readSecret, resolveDatabaseUrl, SecretConfigError } from '@lumina/shared';

const dir = mkdtempSync(join(tmpdir(), 'lumina-secrets-'));

function secretFile(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

test('the plain environment variable keeps working', () => {
  const url = 'postgresql://lumina_graphql:pw@db:5432/lumina';
  assert.equal(resolveDatabaseUrl('DATABASE_URL', { DATABASE_URL: url }), url);
});

test('nothing configured resolves to undefined so the caller default applies', () => {
  assert.equal(resolveDatabaseUrl('DATABASE_URL', {}), undefined);
  assert.equal(resolveDatabaseUrl('DATABASE_URL', { DATABASE_URL: '' }), undefined);
});

test('DATABASE_URL_FILE supplies the URL without an environment variable', () => {
  const path = secretFile('url', 'postgresql://lumina_indexer:s3cret@db:5432/lumina\n');
  assert.equal(
    resolveDatabaseUrl('DATABASE_URL', { DATABASE_URL_FILE: path }),
    'postgresql://lumina_indexer:s3cret@db:5432/lumina',
  );
});

test('trailing line breaks are stripped, inner whitespace is not', () => {
  const path = secretFile('token', ' a b \r\n\n');
  assert.equal(readSecret('TOKEN', { TOKEN_FILE: path }), ' a b ');
});

test('DATABASE_PASSWORD_FILE replaces the password in a password-less URL', () => {
  const path = secretFile('password', 'rotated\n');
  assert.equal(
    resolveDatabaseUrl('DATABASE_URL', {
      DATABASE_URL: 'postgresql://lumina_graphql@db:5432/lumina?sslmode=require',
      DATABASE_PASSWORD_FILE: path,
    }),
    'postgresql://lumina_graphql:rotated@db:5432/lumina?sslmode=require',
  );
});

test('DATABASE_PASSWORD_FILE overrides a password already in the URL', () => {
  const path = secretFile('password-override', 'new');
  assert.equal(
    resolveDatabaseUrl('DATABASE_URL', {
      DATABASE_URL: 'postgresql://lumina_graphql:old@db/lumina',
      DATABASE_PASSWORD_FILE: path,
    }),
    'postgresql://lumina_graphql:new@db/lumina',
  );
});

test('a password with URL metacharacters reaches pg intact', () => {
  const password = "p@ss:w/rd#?%&é !'()*[]";
  const path = secretFile('password-escaped', password);
  const url = resolveDatabaseUrl('DATABASE_URL', {
    DATABASE_URL: 'postgresql://lumina_graphql@db:5432/lumina',
    DATABASE_PASSWORD_FILE: path,
  });
  // What matters is not the encoded form but what the driver decodes it to.
  // Constructing a Client parses the string without connecting.
  const client = new Client({ connectionString: url });
  assert.equal(client.password, password);
  assert.equal(client.user, 'lumina_graphql');
  assert.equal(client.host, 'db');
  assert.equal(client.database, 'lumina');
});

test('the READ_DATABASE_URL family reads its own file variables', () => {
  const urlPath = secretFile('read-url', 'postgresql://reader@replica/lumina');
  const passwordPath = secretFile('read-password', 'replica-pw');
  assert.equal(
    resolveDatabaseUrl('READ_DATABASE_URL', {
      READ_DATABASE_URL_FILE: urlPath,
      READ_DATABASE_PASSWORD_FILE: passwordPath,
      // The primary's password file must not leak into the replica URL.
      DATABASE_PASSWORD_FILE: secretFile('primary-password', 'primary-pw'),
    }),
    'postgresql://reader:replica-pw@replica/lumina',
  );
});

test('setting both the variable and its _FILE twin is rejected', () => {
  const path = secretFile('both', 'postgresql://a@b/c');
  assert.throws(
    () => resolveDatabaseUrl('DATABASE_URL', { DATABASE_URL: 'postgresql://x@y/z', DATABASE_URL_FILE: path }),
    (err: unknown) => err instanceof SecretConfigError && /both set/.test(err.message),
  );
});

test('an unreadable or empty file is an error, not an empty credential', () => {
  assert.throws(
    () => resolveDatabaseUrl('DATABASE_URL', { DATABASE_URL_FILE: join(dir, 'missing') }),
    (err: unknown) => err instanceof SecretConfigError && /cannot be read/.test(err.message),
  );
  const empty = secretFile('empty', '\n');
  assert.throws(
    () => resolveDatabaseUrl('DATABASE_URL', { DATABASE_URL_FILE: empty }),
    (err: unknown) => err instanceof SecretConfigError && /is empty/.test(err.message),
  );
});

test('a password file without a URL is rejected', () => {
  const path = secretFile('orphan-password', 'pw');
  assert.throws(
    () => resolveDatabaseUrl('DATABASE_URL', { DATABASE_PASSWORD_FILE: path }),
    (err: unknown) => err instanceof SecretConfigError && /neither DATABASE_URL nor DATABASE_URL_FILE/.test(err.message),
  );
});

test('error messages name the variable and path but never the secret', () => {
  const path = secretFile('leak-check', 'hunter2');
  try {
    resolveDatabaseUrl('DATABASE_URL', { DATABASE_URL: 'not a url', DATABASE_PASSWORD_FILE: path });
    assert.fail('expected an error');
  } catch (err) {
    assert.ok(err instanceof SecretConfigError);
    assert.doesNotMatch(err.message, /hunter2/);
  }
});
