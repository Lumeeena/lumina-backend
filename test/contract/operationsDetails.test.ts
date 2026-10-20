/**
 * Contract tests between the indexer and the GraphQL server: the server can
 * read what the indexer writes into `operations.details`, for every shape.
 *
 * Every fixture is a real mainnet operation — one per shape Horizon returned
 * across a thousand ledgers (fixtures/operations.json, recordFixtures.ts) —
 * and every one goes in through the indexer's own `indexLedger` and comes out
 * through the server's own read functions, against a real Postgres built from
 * db/schema.sql. The expected answer is stated from Horizon's payload alone
 * (contract.ts), never from either side's code, so a change on either side
 * that breaks the other fails here:
 *
 * - the indexer storing a different shape (a key renamed, dropped, re-encoded);
 * - the server reading a key the indexer does not write, or reading it wrongly;
 * - a new reader of `details` that the contract does not declare;
 * - the documentation drifting from the declared keys.
 *
 * The last test writes the same operations through a deliberately incompatible
 * writer and checks that the contract catches it — the proof that this suite
 * fails when it should.
 *
 * Needs TEST_DATABASE_URL; each run creates and drops a database of its own.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { indexLedger } from '../../indexer/src/db';
import type { HorizonLedger, HorizonTransaction, HorizonOperation as IndexerOperation } from '../../indexer/src/horizon';
import { getAccountLifecycle, getAccountOperationsInLedger, getOperationsByTransactionHash } from '../../graphql-server/src/db';
import { getOperationsByAsset, parseAsset } from '../../graphql-server/src/search';
import { getAssetVolumeSeries } from '../../graphql-server/src/assets';
import { computeBalanceHistory } from '../../graphql-server/src/balanceHistory';
import { StellarAmount } from '../../graphql-server/src/amount';
import { applySchema, REPO_ROOT } from '../stack/stack';
import {
  ACCOUNT_KEYS,
  assetsOf,
  assetString,
  DETAILS_KEYS,
  OPERATION_FIELDS,
  type HorizonOperation,
} from './contract';

const ADMIN_URL = process.env['TEST_DATABASE_URL'];
const skip = ADMIN_URL ? false : 'TEST_DATABASE_URL is not set';
const TIMEOUT_MS = 60_000;

// Deliberately not the default `mainnet`: a reader that forgot its network
// filter would find nothing here.
const NETWORK = 'testnet';
const DRIFTED = 'futurenet';

interface FixtureLedger {
  ledger: HorizonLedger;
  transactions: HorizonTransaction[];
  operations: HorizonOperation[];
}

const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'operations.json'), 'utf8')) as {
  shapes: number;
  ledgers: FixtureLedger[];
};
const operations = fixtures.ledgers.flatMap(group => group.operations.map(op => ({ op, ledger: group.ledger.sequence })));

const database = `lumina_contract_${process.pid}`;
let pool: Pool;

function str(op: HorizonOperation, key: string): string | null {
  const value = op[key];
  return typeof value === 'string' ? value : null;
}

/** Writes every fixture ledger through the indexer, optionally through a transform of each operation. */
async function write(network: string, transform: (op: HorizonOperation) => HorizonOperation = op => op): Promise<void> {
  for (const group of fixtures.ledgers) {
    await indexLedger(pool, network, group.ledger, group.transactions, group.operations.map(op => transform(op) as unknown as IndexerOperation));
  }
}

/**
 * The projection half of the contract: every `Operation` field, for every
 * fixture, against the payload. Returns one line per disagreement.
 */
async function projectionViolations(network: string): Promise<string[]> {
  const violations: string[] = [];
  const hashes = [...new Set(operations.map(({ op }) => String(op['transaction_hash'])))];
  const served = new Map<string, Record<string, unknown>>();
  for (const hash of hashes) {
    for (const row of await getOperationsByTransactionHash(pool, network, hash)) served.set(row.id, row as unknown as Record<string, unknown>);
  }
  for (const { op } of operations) {
    const row = served.get(op.id);
    if (!row) {
      violations.push(`${op.type} ${op.id}: not returned at all`);
      continue;
    }
    if (row['type'] !== op.type.toUpperCase()) violations.push(`${op.type} ${op.id}: type is ${String(row['type'])}`);
    if (row['sourceAccount'] !== op['source_account']) violations.push(`${op.type} ${op.id}: sourceAccount is ${String(row['sourceAccount'])}`);
    if (row['transactionHash'] !== op['transaction_hash']) violations.push(`${op.type} ${op.id}: transactionHash is ${String(row['transactionHash'])}`);
    for (const [field, { keys, expected }] of Object.entries(OPERATION_FIELDS)) {
      const want = expected(op);
      if (row[field] !== want) {
        violations.push(
          `${op.type} ${op.id}: Operation.${field} is ${JSON.stringify(row[field])}, Horizon's payload says ${JSON.stringify(want)} (details.${keys.join(', details.')})`
        );
      }
    }
  }
  return violations;
}

before(async () => {
  if (skip) return;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${database}`;
  pool = new Pool({ connectionString: url.toString(), max: 4 });
  await applySchema(pool);
  await write(NETWORK);
});

after(async () => {
  if (skip) return;
  await pool.end();
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

test('the fixtures cover every shape they were recorded with', () => {
  assert.equal(operations.length, fixtures.shapes);
  assert.ok(fixtures.shapes > 40, `only ${fixtures.shapes} shapes recorded`);
});

test('every operation the indexer writes reads back as Horizon sent it, field by field', { skip, timeout: TIMEOUT_MS }, async () => {
  const violations = await projectionViolations(NETWORK);
  assert.deepEqual(violations, [], `\n${violations.join('\n')}`);
});

test('the account-activity replay finds each operation by every account it names', { skip, timeout: TIMEOUT_MS }, async () => {
  const violations: string[] = [];
  for (const { op, ledger } of operations) {
    for (const key of ACCOUNT_KEYS) {
      const address = str(op, key);
      if (!address) continue;
      const rows = await getAccountOperationsInLedger(pool, NETWORK, ledger, address);
      if (!rows.some(row => row.id === op.id)) violations.push(`${op.type} ${op.id}: not found for details.${key} = ${address}`);
    }
  }
  assert.deepEqual(violations, [], `\n${violations.join('\n')}`);
});

test('account lifecycle finds every creation and merge by the account it names', { skip, timeout: TIMEOUT_MS }, async () => {
  const violations: string[] = [];
  const lifecycle = operations.filter(({ op }) => op.type === 'create_account' || op.type === 'account_merge');
  assert.ok(lifecycle.length > 0, 'the fixtures include no account creation or merge');
  for (const { op } of lifecycle) {
    const address = str(op, 'account');
    const rows = address ? await getAccountLifecycle(pool, NETWORK, address, 50) : [];
    if (!rows.some(row => row.id === op.id)) violations.push(`${op.type} ${op.id}: not found for details.account = ${address}`);
  }
  assert.deepEqual(violations, [], `\n${violations.join('\n')}`);
});

test('operations(asset:) finds each operation by every asset it carries, in any role', { skip, timeout: TIMEOUT_MS }, async () => {
  const violations: string[] = [];
  for (const { op } of operations) {
    for (const asset of assetsOf(op)) {
      const rows = await getOperationsByAsset(pool, { network: NETWORK, asset, limit: 500 });
      if (!rows.some(row => row.id === op.id)) violations.push(`${op.type} ${op.id}: not found for asset ${asset}`);
    }
  }
  assert.deepEqual(violations, [], `\n${violations.join('\n')}`);
});

test('the asset volume series sums every amount recorded under each asset', { skip, timeout: TIMEOUT_MS }, async () => {
  const times = operations.map(({ op }) => Date.parse(String(op['created_at'])));
  const start = new Date(Math.min(...times) - 60_000);
  const end = new Date(Math.max(...times) + 60_000);
  const range = { start, end, bucketSeconds: Math.ceil((end.getTime() - start.getTime()) / 1000) + 1 };
  const violations: string[] = [];
  for (const asset of new Set(operations.flatMap(({ op }) => assetsOf(op)))) {
    let expected = StellarAmount.ZERO;
    for (const { op } of operations) {
      const amount = str(op, 'amount');
      if (amount && /^[0-9]+(\.[0-9]+)?$/.test(amount) && assetsOf(op).includes(asset)) expected = expected.plus(StellarAmount.from(amount));
    }
    const buckets = await getAssetVolumeSeries(pool, NETWORK, parseAsset(asset), range);
    const total = buckets.reduce((sum, b) => sum.plus(StellarAmount.from(b.volume)), StellarAmount.ZERO);
    if (!total.equals(expected)) violations.push(`${asset}: volume ${total.toFixed()}, payloads sum to ${expected.toFixed()}`);
  }
  assert.deepEqual(violations, [], `\n${violations.join('\n')}`);
});

test('balance history moves each balance by the amount Horizon reported', { skip, timeout: TIMEOUT_MS }, async () => {
  // [address key, amount key, asset key prefix, sign]: who gains and who pays, per type.
  const effects: Record<string, Array<[string, string, string, 1 | -1]>> = {
    payment: [['to', 'amount', '', 1], ['from', 'amount', '', -1]],
    path_payment_strict_send: [['to', 'amount', '', 1], ['from', 'source_amount', 'source_', -1]],
    path_payment_strict_receive: [['to', 'amount', '', 1], ['from', 'source_amount', 'source_', -1]],
    create_account: [['account', 'starting_balance', 'native', 1], ['funder', 'starting_balance', 'native', -1]],
  };
  const violations: string[] = [];
  let checked = 0;
  for (const { op } of operations) {
    // A self-payment moves nothing, and the replay is not asked to know that.
    if (str(op, 'from') !== null && str(op, 'from') === str(op, 'to')) continue;
    for (const [addressKey, amountKey, assetKey, sign] of effects[op.type] ?? []) {
      const address = str(op, addressKey);
      const amount = str(op, amountKey);
      const asset = assetKey === 'native'
        ? 'XLM'
        : assetString(str(op, `${assetKey}asset_type`), str(op, `${assetKey}asset_code`), str(op, `${assetKey}asset_issuer`));
      if (!address || !amount || !asset) continue;
      const at = Date.parse(String(op['created_at']));
      const history = await computeBalanceHistory(
        pool, NETWORK, address, asset, new Date(at - 60_000).toISOString(), new Date(at + 60_000).toISOString()
      );
      const index = history.snapshots.findIndex(s => s.operationId === op.id);
      const move = sign === 1 ? StellarAmount.from(amount) : StellarAmount.ZERO.minus(StellarAmount.from(amount));
      checked++;
      // A sponsored account can be created with nothing; a move of zero records no snapshot.
      if (move.equals(StellarAmount.ZERO)) {
        if (index !== -1) violations.push(`${op.type} ${op.id}: a zero ${amountKey} recorded a balance change`);
        continue;
      }
      if (index < 1) {
        violations.push(`${op.type} ${op.id}: no balance change for details.${addressKey} in ${asset}`);
        continue;
      }
      const delta = StellarAmount.from(history.snapshots[index]!.balance).minus(StellarAmount.from(history.snapshots[index - 1]!.balance));
      if (!delta.equals(move)) violations.push(`${op.type} ${op.id}: details.${addressKey} moved ${delta.toFixed()} in ${asset}, Horizon says ${move.toFixed()}`);
    }
  }
  assert.ok(checked > 0, 'no fixture exercised the balance replay');
  assert.deepEqual(violations, [], `\n${violations.join('\n')}`);
});

test('every details key the server reads is declared in the contract', () => {
  // Read from the source, so a reader added without declaring its key fails
  // here rather than waiting for the indexer to break it.
  const dir = join(REPO_ROOT, 'graphql-server', 'src');
  const patterns = [
    /details\s*->>?\s*'([a-z_]+)'/g, // SQL: details->'key', details->>'key'
    /\bd\['([a-z_]+)'\]/g, // mapOperation
    /\bdetails\??\.([a-z_]+)\b/g, // balance history
  ];
  const read = new Map<string, string>();
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) read.set(match[1]!, file);
    }
    // Containment: details @> '{"key": ...}', built as JSON.stringify({ key: ... }).
    if (/details @>/.test(source)) {
      for (const match of source.matchAll(/JSON\.stringify\(\{ ([a-z_]+): /g)) read.set(match[1]!, file);
    }
  }
  const undeclared = [...read.entries()].filter(([key]) => !(key in DETAILS_KEYS)).map(([key, file]) => `${key} (${file})`);
  assert.deepEqual(undeclared, [], 'read by the server but missing from contract.ts and docs/OPERATIONS_DETAILS_CONTRACT.md');
  const unread = Object.keys(DETAILS_KEYS).filter(key => !read.has(key));
  assert.deepEqual(unread, [], 'declared in the contract but no longer read by the server');
});

test('the documented contract lists exactly the declared keys', () => {
  const doc = readFileSync(join(REPO_ROOT, 'docs', 'OPERATIONS_DETAILS_CONTRACT.md'), 'utf8');
  const documented = new Set([...doc.matchAll(/^\| `([a-z_]+)` \|/gm)].map(m => m[1]!));
  assert.deepEqual([...documented].sort(), Object.keys(DETAILS_KEYS).sort());
});

test('a written shape a reader depends on changing fails the contract', { skip, timeout: TIMEOUT_MS }, async () => {
  // An indexer that renamed `from` and stored amounts in stroops — a plausible
  // "cleanup" of Horizon's payload. Every operation still lands; the server
  // just stops being able to read it, which is the failure this suite exists
  // to catch.
  await write(DRIFTED, op => {
    const { from, amount, ...rest } = op;
    return {
      ...rest,
      ...(from === undefined ? {} : { source: from }),
      // Horizon always sends seven decimals, so dropping the point is stroops.
      ...(typeof amount === 'string' ? { amount: BigInt(amount.replace('.', '')).toString() } : {}),
    } as HorizonOperation;
  });
  const violations = await projectionViolations(DRIFTED);
  assert.ok(violations.some(v => v.includes('Operation.from')), 'a renamed key was not caught');
  assert.ok(violations.some(v => v.includes('Operation.amount')), 'a re-encoded value was not caught');
});
