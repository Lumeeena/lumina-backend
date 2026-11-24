/**
 * The `manage-keys` CLI is a thin layer over the functions in keys.ts. keys.test.ts
 * already covers the create, list, show, revoke and set-limit subcommands. These
 * tests cover the rest: the export-permission subcommands, the usage and exit
 * behaviour for bad input, and the rule that bad input never reaches the database.
 *
 * `process.exit` and the console are replaced for the duration of each call, so
 * the test runner itself is never terminated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { parsePositiveInteger, runCli } from './manageKeys';

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function stubPool(rows: unknown[] = []) {
  const queries: RecordedQuery[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, queries };
}

/** Thrown in place of `process.exit` so the test can observe the exit code. */
class ExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

interface CliRun {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

/**
 * Runs `runCli` with the console captured and `process.exit` turned into an
 * exception. Errors that are not exits, such as a database failure, propagate.
 */
async function runCapturing(args: string[], pool: Pool): Promise<CliRun> {
  const run: CliRun = { stdout: [], stderr: [], exitCode: null };
  const original = { log: console.log, error: console.error, exit: process.exit };

  console.log = (...msgs: unknown[]) => {
    run.stdout.push(msgs.join(' '));
  };
  console.error = (...msgs: unknown[]) => {
    run.stderr.push(msgs.join(' '));
  };
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;

  try {
    await runCli(args, pool);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    run.exitCode = err.code;
  } finally {
    console.log = original.log;
    console.error = original.error;
    process.exit = original.exit;
  }
  return run;
}

test('grant-export switches bulk export on for the key and says so', async () => {
  const { pool, queries } = stubPool([{ id: 7 }]);

  const run = await runCapturing(['grant-export', '7'], pool);

  assert.equal(run.exitCode, null);
  assert.deepEqual(run.stdout, ['Bulk export permission granted for API key 7.']);
  assert.match(queries[0].sql, /SET export_enabled = \$2/);
  assert.deepEqual(queries[0].params, ['7', true]);
});

test('revoke-export switches bulk export off for the key and says so', async () => {
  const { pool, queries } = stubPool([{ id: 7 }]);

  const run = await runCapturing(['revoke-export', '7'], pool);

  assert.equal(run.exitCode, null);
  assert.deepEqual(run.stdout, ['Bulk export permission revoked for API key 7.']);
  assert.deepEqual(queries[0].params, ['7', false]);
});

test('revoke-export on an unknown key fails and reports no success', async () => {
  const { pool } = stubPool([]);

  await assert.rejects(() => runCapturing(['revoke-export', '99'], pool), /API key not found: 99/);
});

test('running with no command prints usage and exits with status 1', async () => {
  const { pool, queries } = stubPool();

  const run = await runCapturing([], pool);

  assert.equal(run.exitCode, 1);
  assert.match(run.stderr.join('\n'), /Usage:/);
  assert.equal(queries.length, 0);
});

test('an unknown command prints usage and exits with status 1', async () => {
  const { pool, queries } = stubPool();

  const run = await runCapturing(['frobnicate'], pool);

  assert.equal(run.exitCode, 1);
  assert.match(run.stderr.join('\n'), /Usage:/);
  assert.equal(queries.length, 0);
});

test('create rejects a rate limit that is not a positive integer, before any write', async () => {
  const { pool, queries } = stubPool();

  const run = await runCapturing(['create', 'my-app', '1e3'], pool);

  assert.equal(run.exitCode, 1);
  assert.match(run.stderr.join('\n'), /Invalid rate limit "1e3"/);
  assert.equal(queries.length, 0);
});

test('set-limit rejects a zero limit, before any write', async () => {
  const { pool, queries } = stubPool();

  const run = await runCapturing(['set-limit', '1', '0'], pool);

  assert.equal(run.exitCode, 1);
  assert.match(run.stderr.join('\n'), /Invalid rate limit "0"/);
  assert.equal(queries.length, 0);
});

test('parsePositiveInteger rejects blank input and values beyond the safe integer range', () => {
  assert.equal(parsePositiveInteger('   '), null);
  assert.equal(parsePositiveInteger('9007199254740992'), null);
  assert.equal(parsePositiveInteger('9007199254740991'), 9007199254740991);
});
