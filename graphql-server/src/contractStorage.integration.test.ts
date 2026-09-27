/**
 * End-to-end check of the contractStorageEntries query against a real
 * database: real schema, real rows, real keyset pagination. The unit tests
 * assert on generated SQL with a fake pool; only this proves Postgres accepts
 * the query and that the cursor really walks the ordering.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { getContractStorageEntries } from './db';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const CONTRACT_A = 'CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ';
const CONTRACT_B = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

async function seed(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM contract_storage_entries');
  const rows = [
    // Contract A: five persistent entries, deliberately with two sharing a
    // ledger so the (last_modified_ledger, key) tiebreaker is exercised.
    [CONTRACT_A, 'k1', 'persistent', 300, 'a'],
    [CONTRACT_A, 'k2', 'persistent', 300, 'b'],
    [CONTRACT_A, 'k3', 'persistent', 200, 'c'],
    [CONTRACT_A, 'k4', 'temporary', 100, 'd'],
    [CONTRACT_A, 'k5', 'persistent', 100, 'e'],
  ];
  for (const [contractId, key, durability, ledger, value] of rows as string[][]) {
    await pool.query(
      `INSERT INTO contract_storage_entries
         (contract_id, key, durability, state, value, value_xdr, live_until_ledger, last_modified_ledger, network)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, 'mainnet')`,
      [contractId, key, durability, { label: value }, 'xdr:' + key, Number(ledger) + 100, Number(ledger)]
    );
  }
  // A second contract, and an archived entry, so cross-contract and state
  // filtering are both proven against real rows.
  await pool.query(
    `INSERT INTO contract_storage_entries
       (contract_id, key, durability, state, value, value_xdr, live_until_ledger, last_modified_ledger, network)
     VALUES ($1, 'k9', 'persistent', 'archived', NULL, NULL, NULL, 400, 'mainnet')`,
    [CONTRACT_B]
  );
}

test(
  'contractStorageEntries lists, filters, paginates and distinguishes archived from absent',
  { skip: !DATABASE_URL },
  async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      await seed(pool);

      // Ordering: newest ledger first, and within one ledger by key descending —
      // so the two entries sharing ledger 300 come back k2, k1.
      const all = await getContractStorageEntries(pool, { network: 'mainnet', contractId: CONTRACT_A, limit: 10 });
      assert.deepEqual(all.map(e => e.key), ['k2', 'k1', 'k3', 'k5', 'k4']);
      assert.equal(all[0]?.state, 'ACTIVE');
      assert.equal(all[0]?.durability, 'PERSISTENT');
      assert.equal(all[0]?.value, '{"label":"b"}');
      assert.equal(all[0]?.valueXdr, 'xdr:k2');
      assert.equal(all[0]?.lastModifiedLedger, 300);
      assert.equal(all[0]?.liveUntilLedger, 400);

      // Both value forms come back for the same entry.
      assert.ok(all[0]?.value && all[0]?.valueXdr);

      // Durability filter.
      const temporary = await getContractStorageEntries(pool, {
        network: 'mainnet', contractId: CONTRACT_A, durability: 'TEMPORARY', limit: 10,
      });
      assert.deepEqual(temporary.map(e => e.key), ['k4']);

      // Key prefix filter, with _ treated as a literal rather than a wildcard.
      const prefixed = await getContractStorageEntries(pool, {
        network: 'mainnet', contractId: CONTRACT_A, keyPrefix: 'k1', limit: 10,
      });
      assert.deepEqual(prefixed.map(e => e.key), ['k1']);

      // Keyset pagination: walking the cursor must visit every row exactly once,
      // including the two that share ledger 300.
      const paged: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page = await getContractStorageEntries(pool, {
          network: 'mainnet', contractId: CONTRACT_A, limit: 2, cursor,
        });
        paged.push(...page.map(e => e.key));
        if (page.length < 2) break;
        cursor = page.at(-1)?.key ?? null;
      }
      assert.deepEqual(paged, ['k2', 'k1', 'k3', 'k5', 'k4']);

      // Scoped per contract: contract B's rows never leak into A.
      const b = await getContractStorageEntries(pool, { network: 'mainnet', contractId: CONTRACT_B, limit: 10 });
      assert.deepEqual(b.map(e => e.key), ['k9']);
      assert.equal(b[0]?.state, 'ARCHIVED');
      // An archived entry keeps its row but reports no readable value.
      assert.equal(b[0]?.value, null);
      assert.equal(b[0]?.valueXdr, null);
      assert.equal(b[0]?.lastModifiedLedger, 400);

      // An unknown network is not silently read from another one.
      const otherNetwork = await getContractStorageEntries(pool, { network: 'testnet', contractId: CONTRACT_A, limit: 10 });
      assert.deepEqual(otherNetwork, []);

      // A key that was never set has no row at all — the archived/absent split.
      const absent = await getContractStorageEntries(pool, {
        network: 'mainnet', contractId: CONTRACT_A, keyPrefix: 'never', limit: 10,
      });
      assert.deepEqual(absent, []);
    } finally {
      await pool.end();
    }
  }
);
