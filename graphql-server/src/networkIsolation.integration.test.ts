/**
 * Network isolation, against a real Postgres.
 *
 * The unit tests assert that a `network = $n` predicate is *present* in the SQL
 * a function builds. That is not the same claim as "a mainnet row never appears
 * under a testnet query", which is the one that matters: when the filter is
 * missing or scoped wrongly the results do not look broken, they look plausible.
 * A ledger sequence, transaction hash, operation id and account address all
 * exist on every chain, so a page that quietly returns mainnet rows under a
 * testnet label is indistinguishable from a correct one to the client reading
 * it.
 *
 * So the seed here is built to make the mix-up detectable rather than to make
 * the happy path tidy: both networks carry the *same* ledger sequences, the
 * same transaction hash, the same operation ids, the same account address, the
 * same contract id and the same custom-event id, and the values differ per
 * network. A query that returns the other network's row is then wrong in a way
 * the assertion can see — it is the wrong memo, the wrong balance, the wrong
 * marker — rather than merely present.
 *
 * A second group of tests covers keyset paging, where the cursor is resolved by
 * a subquery rather than a predicate. That subquery is a filter like any other
 * and can be the one that forgets the network: a page-2 request whose cursor
 * resolves against another chain's row either repeats a row or returns nothing.
 *
 * The subscription path is included because it filters differently from every
 * query: a notification is dropped unless it carries the subscribed network,
 * *and* the rows it then triggers are read scoped to that network. Both halves
 * are asserted, and so is the legacy case of a notification with no network
 * field, where the subscribed network is the only thing that can scope the read.
 *
 * Skipped unless `TEST_DATABASE_URL` is set; CI provides one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { resolvers, createContext, type Context } from './resolvers';
import { createSubscriptionResolvers, type SubscriptionContext } from './subscriptions';
import { resolveNetworks, type NetworkRegistry } from './networks';
import type { IndexedNotification } from './notifications';
import type { LedgerNotifier } from './pubsub';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const skip = DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

const TEST_TIMEOUT_MS = 30_000;

/**
 * Both networks declare a ledger at 990_010 — the same sequence on two chains,
 * which is the ordinary case and the reason a single-column key would drop one
 * network's rows the moment the other wrote the same number.
 */
const SHARED_LEDGER = 990_010;
/** Mainnet indexes further ahead than testnet, so a leaked MAX() is visible. */
const MAINNET_TIP = 990_050;
const TESTNET_TIP = 990_020;

const ACCOUNT = 'GISOLATION';
const COUNTERPARTY = 'GCOUNTERPARTY';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ASSET = `USDC:${ISSUER}`;
const CONTRACT = 'CISOISOLATION';
const STORAGE_KEY = 'kIsolationKey';

const TX_HASH = 'tx_isolation_shared';
const TX_TAIL = 'tx_isolation_tail';
const OP_HEAD = 'op_isolation_head';
const OP_TAIL = 'op_isolation';
const EVENT_ID = 'evt_isolation_shared';
const CUSTOM_EVENT_ID = 'cev_isolation_shared';

const MAINNET = 'MAINNET';
const TESTNET = 'TESTNET';

let pool: Pool;
let registry: NetworkRegistry;

/**
 * A Horizon URL that refuses the connection immediately.
 *
 * The freshness and account resolvers fall back to Horizon for rows the
 * database does not have; the seed covers every row they would ask for, so this
 * only bounds the cost of a mistake from three retries to one refusal.
 */
const NO_HORIZON = 'http://127.0.0.1:1';

function context(): Context {
  return createContext(pool, { registry });
}

async function clear(): Promise<void> {
  for (const network of ['mainnet', 'testnet']) {
    await pool.query(
      `DELETE FROM operations
        WHERE ledger IN ($1, $2, $3) AND network = $4`,
      [SHARED_LEDGER, MAINNET_TIP, TESTNET_TIP, network]
    );
    await pool.query(
      `DELETE FROM transactions
        WHERE ledger IN ($1, $2, $3) AND network = $4`,
      [SHARED_LEDGER, MAINNET_TIP, TESTNET_TIP, network]
    );
    await pool.query(
      `DELETE FROM accounts WHERE address = $1 AND network = $2`,
      [ACCOUNT, network]
    );
    await pool.query(
      `DELETE FROM ledgers WHERE sequence IN ($1, $2, $3) AND network = $4`,
      [SHARED_LEDGER, MAINNET_TIP, TESTNET_TIP, network]
    );
    await pool.query(
      `DELETE FROM custom_events WHERE event_id = $1 AND network = $2`,
      [CUSTOM_EVENT_ID, network]
    );
    await pool.query(
      `DELETE FROM contract_schemas WHERE contract_id = $1 AND network = $2`,
      [CONTRACT, network]
    );
    await pool.query(
      `DELETE FROM contract_storage_entries WHERE contract_id = $1 AND key = $2 AND network = $3`,
      [CONTRACT, STORAGE_KEY, network]
    );
    await pool.query(
      `DELETE FROM contract_events WHERE contract_id = $1 AND id = $2 AND network = $3`,
      [CONTRACT, EVENT_ID, network]
    );
  }
}

/**
 * One network's share of the seed.
 *
 * `OP_HEAD` is the row that carries the cross-network paging risk. It exists on
 * both networks under the same id, and it sits at each network's *own* tip
 * (mainnet 990_050, testnet 990_020) rather than at a shared one. Keyset paging
 * resolves the cursor by a subquery rather than a predicate, so a subquery that
 * omits the network compares the second page against the other chain's row —
 * and because mainnet's boundary sits *later*, testnet's own row falls inside
 * it and is returned a second time. An identical sequence on both networks
 * would hide the bug behind a coincidentally correct answer.
 */
interface Seed {
  network: string;
  /** Ledger holding the shared ledger/transaction/operation/event rows. */
  sharedLedger: number;
  /** Ledger holding the rows that make each network's tip differ. */
  tipLedger: number;
  /** Account sequence, unique per network. */
  accountSequence: string;
  /** USDC holding, unique per network. */
  usdcBalance: string;
  /** Memo marker, unique per network. */
  memo: string;
  /** USDC payment amount. */
  usdcAmount: string;
  /** Native payment amount. */
  nativeAmount: string;
  /** Value of the custom event's marker field. */
  marker: string;
  /** Value of the contract storage entry. */
  storageValue: string;
  /** Which custom event the contract's schema declares on this network. */
  eventName: string;
}

const MAINNET_SEED: Seed = {
  network: 'mainnet',
  sharedLedger: SHARED_LEDGER,
  tipLedger: MAINNET_TIP,
  accountSequence: '11',
  usdcBalance: '100',
  memo: 'ISOLATION-MAINNET-ORDER-4471',
  usdcAmount: '25',
  nativeAmount: '10',
  marker: 'mainnet',
  storageValue: 'mainnet-value',
  eventName: 'transfer',
};

const TESTNET_SEED: Seed = {
  network: 'testnet',
  sharedLedger: SHARED_LEDGER,
  tipLedger: TESTNET_TIP,
  accountSequence: '22',
  usdcBalance: '400',
  memo: 'ISOLATION-TESTNET-ORDER-4471',
  usdcAmount: '75',
  nativeAmount: '70',
  marker: 'testnet',
  storageValue: 'testnet-value',
  eventName: 'swap',
};

async function seedNetwork(seed: Seed): Promise<void> {
  const n = seed.network;

  for (const sequence of [seed.sharedLedger, seed.tipLedger]) {
    await pool.query(
      `INSERT INTO ledgers (sequence, closed_at, transaction_count, operation_count, network)
       VALUES ($1, NOW(), 1, 1, $2)
       ON CONFLICT (sequence, network) DO NOTHING`,
      [sequence, n]
    );
  }

  // The same hash exists on both networks; only the memo tells them apart.
  await pool.query(
    `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo, network)
     VALUES ($1, $2, '2026-01-01T12:00:00Z', $3, 100, 1, true, 'text', $4, $5)
     ON CONFLICT (hash, network) DO UPDATE SET memo = EXCLUDED.memo`,
    [TX_HASH, seed.sharedLedger, ACCOUNT, seed.memo, n]
  );

  await pool.query(
    `INSERT INTO transactions (hash, ledger, created_at, source_account, fee_charged, operation_count, successful, memo_type, memo, network)
     VALUES ($1, $2, '2026-01-01T13:00:00Z', $3, 100, 1, true, 'text', $4, $5)
     ON CONFLICT (hash, network) DO UPDATE SET memo = EXCLUDED.memo`,
    [TX_TAIL, seed.tipLedger, ACCOUNT, `${seed.memo}-TAIL`, n]
  );

  // The same address on both networks, holding different balances.
  await pool.query(
    `INSERT INTO accounts (address, sequence, subentry_count, last_modified_ledger, num_sponsored, num_sponsoring, balances, flags, thresholds, network)
     VALUES ($1, $2, 0, $3, 0, 0, $4, '{}', '{}', $5)
     ON CONFLICT (address, network) DO UPDATE
       SET sequence = EXCLUDED.sequence, balances = EXCLUDED.balances`,
    [
      ACCOUNT,
      seed.accountSequence,
      seed.tipLedger,
      JSON.stringify([
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, balance: seed.usdcBalance },
      ]),
      n,
    ]
  );

  // USDC payment at the network's tip ledger, so supply and volume differ too.
  await pool.query(
    `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details, network)
     VALUES ($1, 'payment', $2, $3, '2026-01-01T13:00:00Z', $4, $5, $6)
     ON CONFLICT (id, network) DO UPDATE SET details = EXCLUDED.details`,
    [
      OP_HEAD,
      TX_TAIL,
      seed.tipLedger,
      ACCOUNT,
      JSON.stringify({
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: ISSUER,
        amount: seed.usdcAmount,
        from: COUNTERPARTY,
        to: ACCOUNT,
      }),
      n,
    ]
  );

  // Native payment into the same account, which is what balance history reads.
  await pool.query(
    `INSERT INTO operations (id, type, transaction_hash, ledger, created_at, source_account, details, network)
     VALUES ($1, 'payment', $2, $3, '2026-01-01T12:00:00Z', $4, $5, $6)
     ON CONFLICT (id, network) DO UPDATE SET details = EXCLUDED.details`,
    [
      OP_TAIL,
      TX_HASH,
      seed.sharedLedger,
      COUNTERPARTY,
      JSON.stringify({ asset_type: 'native', amount: seed.nativeAmount, from: COUNTERPARTY, to: ACCOUNT }),
      n,
    ]
  );

  await pool.query(
    `INSERT INTO contract_events (id, type, contract_id, ledger, created_at, paging_token, topics, value, network)
     VALUES ($1, 'contract', $2, $3, '2026-01-01T12:00:00Z', $4, ARRAY['"transfer"']::text[], $5, $6)
     ON CONFLICT (id, network) DO UPDATE SET value = EXCLUDED.value`,
    [
      EVENT_ID,
      CONTRACT,
      seed.sharedLedger,
      `${seed.network}-paging-token`,
      JSON.stringify({ marker: seed.marker }),
      n,
    ]
  );

  // The same contract id, but each network registers a different schema: the
  // same contract address decoding differently per chain is the case a
  // per-network lookup exists for, and a shared lookup would serve the wrong
  // one's field types.
  const definition =
    seed.eventName === 'transfer'
      ? {
          contractId: CONTRACT,
          version: 1,
          events: [
            {
              name: 'transfer',
              topic: 'transfer',
              fields: [{ name: 'amount', type: 'i128', source: 'value.amount' }],
            },
          ],
        }
      : {
          contractId: CONTRACT,
          version: 2,
          events: [
            {
              name: 'swap',
              topic: 'swap',
              fields: [{ name: 'marker', type: 'string', source: 'value.marker' }],
            },
          ],
        };

  await pool.query(
    `INSERT INTO contract_schemas (contract_id, version, definition, network)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (contract_id, network) DO UPDATE
       SET version = EXCLUDED.version, definition = EXCLUDED.definition`,
    [CONTRACT, definition.version, JSON.stringify(definition), n]
  );

  await pool.query(
    `INSERT INTO custom_events (event_id, contract_id, event_name, ledger, created_at, schema_version, fields, network)
     VALUES ($1, $2, $3, $4, '2026-01-01T12:00:00Z', $5, $6, $7)
     ON CONFLICT (event_id, event_name, network) DO UPDATE SET fields = EXCLUDED.fields`,
    [
      CUSTOM_EVENT_ID,
      CONTRACT,
      seed.eventName,
      seed.sharedLedger,
      definition.version,
      JSON.stringify({ amount: seed.nativeAmount, marker: seed.marker }),
      n,
    ]
  );

  // The same contract and the same key on both networks.
  await pool.query(
    `INSERT INTO contract_storage_entries (contract_id, key, durability, state, value, last_modified_ledger, network)
     VALUES ($1, $2, 'persistent', 'active', $3, $4, $5)
     ON CONFLICT (contract_id, key, network) DO UPDATE SET value = EXCLUDED.value`,
    [CONTRACT, STORAGE_KEY, JSON.stringify({ marker: seed.marker }), seed.sharedLedger, n]
  );
}

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  registry = resolveNetworks({
    NETWORKS: 'mainnet,testnet',
    MAINNET_HORIZON_URL: NO_HORIZON,
    TESTNET_HORIZON_URL: NO_HORIZON,
    PRIMARY_NETWORK: 'mainnet',
  });
  await clear();
  await seedNetwork(MAINNET_SEED);
  await seedNetwork(TESTNET_SEED);
});

after(async () => {
  if (skip) return;
  await clear();
  await pool.end();
});

// ── Rows sharing a key are kept distinct ──────────────────────────────────────

test('the same ledger sequence, hash, operation id and address coexist per network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const counts = await pool.query<{ network: string; ledgers: string; transactions: string; operations: string; accounts: string }>(
    `SELECT l.network,
            (SELECT COUNT(*) FROM ledgers      WHERE sequence = $1 AND network = l.network) AS ledgers,
            (SELECT COUNT(*) FROM transactions WHERE hash     = $2 AND network = l.network) AS transactions,
            (SELECT COUNT(*) FROM operations   WHERE id       = $3 AND network = l.network) AS operations,
            (SELECT COUNT(*) FROM accounts     WHERE address  = $4 AND network = l.network) AS accounts
       FROM (VALUES ('mainnet'), ('testnet')) AS l(network)`,
    [SHARED_LEDGER, TX_HASH, OP_TAIL, ACCOUNT]
  );

  assert.equal(counts.rows.length, 2);
  for (const row of counts.rows) {
    assert.equal(row.ledgers, '1', `${row.network} should keep its own ledger row`);
    assert.equal(row.transactions, '1', `${row.network} should keep its own transaction row`);
    assert.equal(row.operations, '1', `${row.network} should keep its own operation row`);
    assert.equal(row.accounts, '1', `${row.network} should keep its own account row`);
  }
});

// ── Flat queries ──────────────────────────────────────────────────────────────

test('transactions returns only the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnet = await resolvers.Query.transactions(undefined, { network: MAINNET, limit: 10 }, ctx);
  const testnet = await resolvers.Query.transactions(undefined, { network: TESTNET, limit: 10 }, ctx);

  assert.ok(mainnet.items.length > 0 && testnet.items.length > 0);
  for (const item of mainnet.items) {
    assert.equal(item.network, 'mainnet', 'a mainnet query returned a testnet row');
    assert.ok(!String(item.memo).includes('TESTNET'), `mainnet query leaked memo ${item.memo}`);
  }
  for (const item of testnet.items) {
    assert.equal(item.network, 'testnet', 'a testnet query returned a mainnet row');
    assert.ok(!String(item.memo).includes('MAINNET'), `testnet query leaked memo ${item.memo}`);
  }
  // Newest first, so each network leads with its own tip row.
  assert.equal(mainnet.items[0]?.memo, `${MAINNET_SEED.memo}-TAIL`);
  assert.equal(testnet.items[0]?.memo, `${TESTNET_SEED.memo}-TAIL`);
  // And the shared-sequence row is present on both, with that network's memo.
  assert.equal(mainnet.items.find(tx => tx.hash === TX_HASH)?.memo, MAINNET_SEED.memo);
  assert.equal(testnet.items.find(tx => tx.hash === TX_HASH)?.memo, TESTNET_SEED.memo);
});

test('omitting network serves the primary, and naming an unconfigured network is an error', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const defaulted = await resolvers.Query.transactions(undefined, { limit: 10 }, ctx);
  assert.equal(defaulted.items[0]?.network, 'mainnet');

  await assert.rejects(
    () => resolvers.Query.transactions(undefined, { network: 'FUTURENET', limit: 10 }, ctx),
    /not configured/i
  );
});

test('transaction by hash resolves within the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnet = await resolvers.Query.transaction(undefined, { network: MAINNET, hash: TX_HASH }, ctx);
  const testnet = await resolvers.Query.transaction(undefined, { network: TESTNET, hash: TX_HASH }, ctx);

  assert.equal(mainnet?.memo, MAINNET_SEED.memo);
  assert.equal(testnet?.memo, TESTNET_SEED.memo);
});

test('account by address resolves within the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnet = await resolvers.Query.account(undefined, { network: MAINNET, address: ACCOUNT }, ctx);
  const testnet = await resolvers.Query.account(undefined, { network: TESTNET, address: ACCOUNT }, ctx);

  assert.equal(mainnet?.sequence, MAINNET_SEED.accountSequence);
  assert.equal(testnet?.sequence, TESTNET_SEED.accountSequence);
  assert.equal(mainnet?.balances[0]?.balance, MAINNET_SEED.usdcBalance);
  assert.equal(testnet?.balances[0]?.balance, TESTNET_SEED.usdcBalance);
});

test('operations returns only the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  for (const [network, seed] of [[MAINNET, MAINNET_SEED], [TESTNET, TESTNET_SEED]] as const) {
    const result = await resolvers.Query.operations(undefined, { network, limit: 20 }, ctx);
    assert.ok(result.items.length > 0, `${network} should return its own operations`);
    for (const item of result.items) {
      assert.equal(item.network, seed.network);
    }
  }
});

test('operations filtered by account stay inside the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  for (const [network, seed] of [[MAINNET, MAINNET_SEED], [TESTNET, TESTNET_SEED]] as const) {
    const result = await resolvers.Query.operations(undefined, { network, account: ACCOUNT, limit: 20 }, ctx);
    assert.deepEqual(result.items.map(op => op.id), [OP_HEAD]);
    assert.equal(result.items[0]?.amount, seed.usdcAmount);
  }
});

test('operations filtered by asset stay inside the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  for (const [network, seed] of [[MAINNET, MAINNET_SEED], [TESTNET, TESTNET_SEED]] as const) {
    const result = await resolvers.Query.operations(undefined, { network, asset: ASSET, limit: 20 }, ctx);
    assert.deepEqual(result.items.map(op => op.id), [OP_HEAD]);
    assert.equal(result.items[0]?.amount, seed.usdcAmount);
  }
});

test('search returns only the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnet = await resolvers.Query.search(undefined, { network: MAINNET, query: 'ORDER-4471', limit: 10 }, ctx);
  const testnet = await resolvers.Query.search(undefined, { network: TESTNET, query: 'ORDER-4471', limit: 10 }, ctx);

  assert.ok(mainnet.items.some(tx => tx.hash === TX_HASH), 'mainnet memo should match');
  assert.ok(testnet.items.some(tx => tx.hash === TX_HASH), 'testnet memo should match');
  for (const item of mainnet.items) {
    assert.equal(item.network, 'mainnet');
    assert.ok(!String(item.memo).includes('TESTNET'));
  }
  for (const item of testnet.items) {
    assert.equal(item.network, 'testnet');
    assert.ok(!String(item.memo).includes('MAINNET'));
  }
});

test('events for a contract stay inside the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnet = await resolvers.Query.events(undefined, { network: MAINNET, contractId: CONTRACT, limit: 10 }, ctx);
  const testnet = await resolvers.Query.events(undefined, { network: TESTNET, contractId: CONTRACT, limit: 10 }, ctx);

  assert.equal(mainnet.items.length, 1);
  assert.equal(testnet.items.length, 1);
  assert.match(String(mainnet.items[0]?.value), new RegExp(MAINNET_SEED.marker));
  assert.match(String(testnet.items[0]?.value), new RegExp(TESTNET_SEED.marker));
});

test('contract storage entries stay inside the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnet = await resolvers.Query.contractStorageEntries(undefined, { network: MAINNET, contractId: CONTRACT, limit: 10 }, ctx);
  const testnet = await resolvers.Query.contractStorageEntries(undefined, { network: TESTNET, contractId: CONTRACT, limit: 10 }, ctx);

  assert.equal(mainnet.items.length, 1);
  assert.equal(testnet.items.length, 1);
  assert.match(String(mainnet.items[0]?.value), new RegExp(MAINNET_SEED.marker));
  assert.match(String(testnet.items[0]?.value), new RegExp(TESTNET_SEED.marker));
});

test('latestLedger reports each network own tip', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnet = await resolvers.Query.latestLedger(undefined, { network: MAINNET }, ctx);
  const testnet = await resolvers.Query.latestLedger(undefined, { network: TESTNET }, ctx);

  assert.equal(mainnet?.sequence, MAINNET_TIP);
  assert.equal(testnet?.sequence, TESTNET_TIP);
  assert.equal(mainnet?.network, 'mainnet');
  assert.equal(testnet?.network, 'testnet');
});

test('ledger by sequence resolves within the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  // The same sequence number, present on both chains, must not resolve to
  // whichever row the primary network's index happens to find first.
  const mainnet = await resolvers.Query.ledger(undefined, { network: MAINNET, sequence: SHARED_LEDGER }, ctx);
  const testnet = await resolvers.Query.ledger(undefined, { network: TESTNET, sequence: SHARED_LEDGER }, ctx);

  assert.equal(mainnet?.network, 'mainnet');
  assert.equal(testnet?.network, 'testnet');
  assert.equal(mainnet?.sequence, SHARED_LEDGER);
  assert.equal(testnet?.sequence, SHARED_LEDGER);
});

test('asset detail counts only the requested network holders and volume', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();
  const args = { asset: ASSET, from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z', bucketSeconds: 86400 };

  const mainnet = await resolvers.Query.asset(undefined, { network: MAINNET, ...args }, ctx);
  const testnet = await resolvers.Query.asset(undefined, { network: TESTNET, ...args }, ctx);

  assert.equal(mainnet.supply, MAINNET_SEED.usdcBalance);
  assert.equal(testnet.supply, TESTNET_SEED.usdcBalance);
  const volume = (detail: { series: { volume: string }[] }) =>
    detail.series.reduce((sum, bucket) => sum + Number(bucket.volume), 0);
  assert.equal(volume(mainnet), Number(MAINNET_SEED.usdcAmount));
  assert.equal(volume(testnet), Number(TESTNET_SEED.usdcAmount));
});

test('balance history replays only the requested network operations', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();
  const args = {
    address: ACCOUNT,
    asset: 'XLM',
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-02T00:00:00Z',
  };

  const mainnet = await resolvers.Query.accountBalanceHistory(undefined, { network: MAINNET, ...args }, ctx);
  const testnet = await resolvers.Query.accountBalanceHistory(undefined, { network: TESTNET, ...args }, ctx);

  const last = (history: { snapshots: { balance: string }[] }) =>
    history.snapshots.at(-1)?.balance ?? '0';
  assert.equal(last(mainnet), MAINNET_SEED.nativeAmount);
  assert.equal(last(testnet), TESTNET_SEED.nativeAmount);
});

test('indexerStatus reports each network own indexed tip', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnet = await resolvers.Query.indexerStatus(undefined, { network: MAINNET }, ctx);
  const testnet = await resolvers.Query.indexerStatus(undefined, { network: TESTNET }, ctx);

  assert.equal(mainnet.network, MAINNET);
  assert.equal(testnet.network, TESTNET);
  assert.equal(mainnet.latestIndexedLedger, MAINNET_TIP);
  assert.equal(testnet.latestIndexedLedger, TESTNET_TIP);
});

// ── Custom schemas, which are registered per network ──────────────────────────

test('contractSchema returns the schema registered on that network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnet = await resolvers.Query.contractSchema(undefined, { network: MAINNET, contractId: CONTRACT }, ctx);
  const testnet = await resolvers.Query.contractSchema(undefined, { network: TESTNET, contractId: CONTRACT }, ctx);

  assert.equal(mainnet?.events[0]?.name, MAINNET_SEED.eventName);
  assert.equal(testnet?.events[0]?.name, TESTNET_SEED.eventName);
  assert.equal(mainnet?.events[0]?.fields[0]?.type, 'i128');
  assert.equal(testnet?.events[0]?.fields[0]?.type, 'string');
});

test('customEvents reads against the schema of the requested network only', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnet = await resolvers.Query.customEvents(undefined, { network: MAINNET, contractId: CONTRACT, event: MAINNET_SEED.eventName, limit: 10 }, ctx);
  assert.equal(mainnet.items.length, 1);
  assert.equal(mainnet.items[0]?.fields[0]?.value, MAINNET_SEED.nativeAmount);

  const testnet = await resolvers.Query.customEvents(undefined, { network: TESTNET, contractId: CONTRACT, event: TESTNET_SEED.eventName, limit: 10 }, ctx);
  assert.equal(testnet.items.length, 1);
  assert.equal(testnet.items[0]?.fields[0]?.value, TESTNET_SEED.marker);

  // Mainnet's event name does not exist on testnet: serving it would mean
  // answering from mainnet's schema.
  await assert.rejects(
    () => resolvers.Query.customEvents(undefined, { network: TESTNET, contractId: CONTRACT, event: MAINNET_SEED.eventName, limit: 10 }, ctx),
    /has no event/i
  );
});

// ── Nested fields inherit the parent row network ──────────────────────────────

test('Transaction fields resolve against the parent row network, not the primary', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const testnetTx = await resolvers.Query.transaction(undefined, { network: TESTNET, hash: TX_HASH }, ctx);
  assert.ok(testnetTx);

  const ledger = await resolvers.Transaction.ledgerData(testnetTx, undefined, ctx);
  const operations = await resolvers.Transaction.operations(testnetTx, undefined, ctx);
  const account = await resolvers.Transaction.account(testnetTx, undefined, ctx);

  assert.equal(ledger?.network, 'testnet');
  assert.deepEqual(operations.map(op => op.id), [OP_TAIL]);
  assert.equal(account?.sequence, TESTNET_SEED.accountSequence);
});

test('Operation fields resolve against the parent row network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const result = await resolvers.Query.operations(undefined, { network: TESTNET, account: ACCOUNT, limit: 10 }, ctx);
  const operation = result.items[0];
  assert.ok(operation);

  const transaction = await resolvers.Operation.transaction(operation, undefined, ctx);
  const account = await resolvers.Operation.account(operation, undefined, ctx);

  assert.equal(transaction?.memo, `${TESTNET_SEED.memo}-TAIL`);
  assert.equal(account?.sequence, TESTNET_SEED.accountSequence);
});

test('Account fields resolve against the parent row network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const testnetAccount = await resolvers.Query.account(undefined, { network: TESTNET, address: ACCOUNT }, ctx);
  assert.ok(testnetAccount);

  const transactions = await resolvers.Account.transactions(testnetAccount, { limit: 10 }, ctx);
  const operations = await resolvers.Account.operations(testnetAccount, { limit: 10 }, ctx);

  assert.deepEqual(transactions.map(tx => tx.hash).sort(), [TX_HASH, TX_TAIL].sort());
  assert.deepEqual(operations.map(op => op.id), [OP_HEAD]);
});

test('one context serves two networks in one document without sharing loader batches', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const mainnetTx = await resolvers.Query.transaction(undefined, { network: MAINNET, hash: TX_HASH }, ctx);
  const testnetTx = await resolvers.Query.transaction(undefined, { network: TESTNET, hash: TX_HASH }, ctx);
  assert.ok(mainnetTx && testnetTx);

  // The same hash and the same ledger number on both chains: a loader batch
  // shared across networks would return whichever network's row it happened to
  // fetch.
  const [mainnetLedger, testnetLedger] = await Promise.all([
    resolvers.Transaction.ledgerData(mainnetTx, undefined, ctx),
    resolvers.Transaction.ledgerData(testnetTx, undefined, ctx),
  ]);
  assert.equal(mainnetTx.ledger, testnetTx.ledger, 'the seed must put both rows on the same sequence');
  assert.equal(mainnetLedger?.sequence, SHARED_LEDGER);
  assert.equal(testnetLedger?.sequence, SHARED_LEDGER);
  assert.equal(mainnetLedger?.network, 'mainnet');
  assert.equal(testnetLedger?.network, 'testnet');
});

// ── Keyset paging, where the cursor is a subquery ─────────────────────────────

test('transactions paging resolves the cursor within the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const first = await resolvers.Query.transactions(undefined, { network: TESTNET, limit: 1 }, ctx);
  assert.deepEqual(first.items.map(tx => tx.hash), [TX_TAIL]);

  const second = await resolvers.Query.transactions(undefined, { network: TESTNET, limit: 1, cursor: TX_TAIL }, ctx);
  assert.deepEqual(second.items.map(tx => tx.hash), [TX_HASH]);
  assert.equal(second.items[0]?.network, 'testnet');
});

test('operations paging resolves the cursor within the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  // Both networks hold an operation with the id OP_HEAD, at their own tips
  // (mainnet 990_050, testnet 990_020). The cursor is resolved by a subquery
  // rather than a filter, so a subquery that omits the network predicate
  // compares page two against mainnet's row: testnet's own OP_HEAD then falls
  // inside the boundary and is returned a second time.
  const first = await resolvers.Query.operations(undefined, { network: TESTNET, limit: 1 }, ctx);
  assert.deepEqual(first.items.map(op => op.id), [OP_HEAD]);
  assert.equal(first.items[0]?.network, 'testnet');

  const second = await resolvers.Query.operations(undefined, { network: TESTNET, limit: 1, cursor: OP_HEAD }, ctx);
  assert.deepEqual(second.items.map(op => op.id), [OP_TAIL], 'the page after the cursor must not repeat the cursor row');
  assert.equal(second.items[0]?.network, 'testnet');
  assert.equal(second.items[0]?.amount, TESTNET_SEED.nativeAmount);
});

test('asset-filtered operations paging resolves the cursor within the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  // OP_HEAD is the only USDC operation on either network, and it sits at each
  // network's own tip. A cursor resolved against the other network's row makes
  // the boundary either too early (the row repeats) or too late (the page is
  // empty) — both are assertions rather than a "looks plausible" page.
  const mainnet = await resolvers.Query.operations(undefined, { network: MAINNET, asset: ASSET, limit: 10 }, ctx);
  assert.deepEqual(mainnet.items.map(op => op.id), [OP_HEAD]);

  const mainnetSecond = await resolvers.Query.operations(undefined, { network: MAINNET, asset: ASSET, limit: 10, cursor: OP_HEAD }, ctx);
  assert.deepEqual(mainnetSecond.items, [], 'the row after the last one is empty, not a repeat');

  const testnet = await resolvers.Query.operations(undefined, { network: TESTNET, asset: ASSET, limit: 10 }, ctx);
  assert.deepEqual(testnet.items.map(op => op.id), [OP_HEAD]);

  const testnetSecond = await resolvers.Query.operations(undefined, { network: TESTNET, asset: ASSET, limit: 10, cursor: OP_HEAD }, ctx);
  assert.deepEqual(testnetSecond.items, [], 'a cursor must not page into the other network');
});

test('contract event paging resolves the cursor within the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const first = await resolvers.Query.events(undefined, { network: TESTNET, contractId: CONTRACT, limit: 1 }, ctx);
  assert.equal(first.items.length, 1);

  const second = await resolvers.Query.events(undefined, { network: TESTNET, contractId: CONTRACT, limit: 1, cursor: EVENT_ID }, ctx);
  assert.deepEqual(second.items, []);
});

test('contract storage paging resolves the cursor within the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();

  const first = await resolvers.Query.contractStorageEntries(undefined, { network: TESTNET, contractId: CONTRACT, limit: 1 }, ctx);
  assert.equal(first.items.length, 1);

  const second = await resolvers.Query.contractStorageEntries(undefined, { network: TESTNET, contractId: CONTRACT, limit: 1, cursor: STORAGE_KEY }, ctx);
  assert.deepEqual(second.items, []);
});

test('custom event paging resolves the cursor within the requested network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const ctx = context();
  const args = { contractId: CONTRACT, event: TESTNET_SEED.eventName, limit: 1 };

  const first = await resolvers.Query.customEvents(undefined, { network: TESTNET, ...args }, ctx);
  assert.equal(first.items.length, 1);

  const second = await resolvers.Query.customEvents(undefined, { network: TESTNET, ...args, cursor: CUSTOM_EVENT_ID }, ctx);
  assert.deepEqual(second.items, []);
});

// ── Subscriptions, which filter differently ───────────────────────────────────

/** A notifier whose stream the test feeds by hand. */
function fakeNotifier() {
  let push: (n: IndexedNotification) => void = () => {};
  let finish: () => void = () => {};
  const queue: IndexedNotification[] = [];
  let waiting: ((r: IteratorResult<IndexedNotification>) => void) | null = null;
  let done = false;

  const settle = (result: IteratorResult<IndexedNotification>) => {
    const resolve = waiting;
    waiting = null;
    resolve?.(result);
  };

  push = n => {
    if (done) return;
    if (waiting) settle({ value: n, done: false });
    else queue.push(n);
  };

  // Closing the source is what actually unwinds the subscription: the
  // generator is parked on a pending `next()`, and a return queued behind that
  // promise would not be seen until it resolved.
  finish = () => {
    done = true;
    settle({ value: undefined, done: true } as IteratorResult<IndexedNotification>);
  };

  const iterator: AsyncIterableIterator<IndexedNotification> = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    next: () => {
      if (done) return Promise.resolve({ value: undefined, done: true } as IteratorResult<IndexedNotification>);
      const buffered = queue.shift();
      if (buffered) return Promise.resolve({ value: buffered, done: false });
      return new Promise(resolve => {
        waiting = resolve;
      });
    },
    return: () => {
      finish();
      return Promise.resolve({ value: undefined, done: true } as IteratorResult<IndexedNotification>);
    },
    throw: () => {
      finish();
      return Promise.resolve({ value: undefined, done: true } as IteratorResult<IndexedNotification>);
    },
  };

  return { notifier: { subscribe: () => iterator } as unknown as LedgerNotifier, push, finish };
}

/**
 * Collect what a subscription yields, then close it.
 *
 * The stream is always closed, which matters beyond this file: a subscription
 * left parked on a pending `next()` holds the promise chain and any work it had
 * in flight for the rest of the run. That is load the other integration suites
 * run against the same database, and enough of it makes an unrelated
 * reconnect-timing test flaky.
 *
 * `expected` is a bound, not a wait: the outcome that matters most here is
 * *nothing* arriving, and a bound of zero means the loop would never end on its
 * own. So the empty case settles on the source closing after a short grace
 * period, which is what lets "this network's notification was dropped" be an
 * assertion rather than a hang.
 */
async function drain(
  stream: AsyncIterable<unknown>,
  close: () => void,
  expected: number,
  graceMs = 300
): Promise<unknown[]> {
  const received: unknown[] = [];
  const collected = (async () => {
    for await (const value of stream) {
      received.push(value);
      if (received.length >= expected) break;
    }
  })();

  if (expected > 0) await collected;
  else await Promise.race([collected, new Promise(resolve => setTimeout(resolve, graceMs))]);

  close();
  await collected.catch(() => {});
  return received;
}

const subscriptionResolvers = createSubscriptionResolvers();

test('newTransaction yields only the subscribed network rows', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const { notifier, push, finish } = fakeNotifier();
  const stream = subscriptionResolvers.newTransaction.subscribe(
    {},
    { network: TESTNET },
    { pool, notifier, registry } as SubscriptionContext
  );

  // The same ledger number on both chains, announced twice.
  push({ kind: 'ledger', ledger: SHARED_LEDGER, network: 'mainnet' });
  push({ kind: 'ledger', ledger: SHARED_LEDGER, network: 'testnet' });

  const received = (await drain(stream, finish, 1)) as { hash: string; memo: string }[];

  assert.equal(received.length, 1, 'exactly one network announcement should be acted on');
  assert.equal(received[0]?.hash, TX_HASH);
  assert.equal(received[0]?.memo, TESTNET_SEED.memo);
});

test('newTransaction drops another network notification before it reads any row', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const { notifier, push, finish } = fakeNotifier();
  const stream = subscriptionResolvers.newTransaction.subscribe(
    {},
    { network: TESTNET },
    { pool, notifier, registry } as SubscriptionContext
  );

  push({ kind: 'ledger', ledger: SHARED_LEDGER, network: 'mainnet' });

  // Nothing should arrive: the row read is what the first network filter
  // prevents, so an empty stream is the observable form of the claim.
  const received = await drain(stream, finish, 0);
  assert.deepEqual(received, []);
});

test('a notification without a network field is scoped to the subscribed network', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const { notifier, push, finish } = fakeNotifier();
  // An indexer that predates per-network notifications writes one chain and
  // omits the field. Reading by ledger number alone would then return whichever
  // network's rows happen to be in the table.
  const stream = subscriptionResolvers.newTransaction.subscribe(
    {},
    { network: TESTNET },
    { pool, notifier, registry } as SubscriptionContext
  );

  push({ kind: 'ledger', ledger: SHARED_LEDGER });

  const received = (await drain(stream, finish, 1)) as { memo: string }[];
  assert.equal(received.length, 1);
  assert.equal(received[0]?.memo, TESTNET_SEED.memo);
});

test('accountActivity yields only the subscribed network operations', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const { notifier, push, finish } = fakeNotifier();
  const stream = subscriptionResolvers.accountActivity.subscribe(
    {},
    { network: TESTNET, address: ACCOUNT },
    { pool, notifier, registry } as SubscriptionContext
  );

  push({ kind: 'ledger', ledger: SHARED_LEDGER, network: 'mainnet' });
  push({ kind: 'ledger', ledger: SHARED_LEDGER, network: 'testnet' });

  const received = (await drain(stream, finish, 1)) as { id: string; amount: string | null }[];

  assert.equal(received.length, 1);
  assert.equal(received[0]?.id, OP_TAIL);
  assert.equal(received[0]?.amount, TESTNET_SEED.nativeAmount);
});
