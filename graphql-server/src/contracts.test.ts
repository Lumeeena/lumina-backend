/**
 * Unit tests for cursor-paginated `contractsPage` (#382).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createContext, resolvers } from './resolvers';
import { encodeCursor, InvalidCursorError } from './pagination';
import { ERROR_CODES } from './errorCodes';
import { loadNetworks } from './networks';

interface ContractRow {
  network: string;
  contract_id: string;
  deployer: string;
  wasm_hash: string;
  deployed_ledger: number;
  deployed_at: string;
}

const DATASET: ContractRow[] = [
  {
    network: 'mainnet',
    contract_id: 'CZZZZ',
    deployer: 'GDEPLOY1',
    wasm_hash: 'wasm1',
    deployed_ledger: 500,
    deployed_at: '2026-07-05T00:00:00Z',
  },
  {
    network: 'mainnet',
    contract_id: 'CBBBB',
    deployer: 'GDEPLOY2',
    wasm_hash: 'wasm2',
    deployed_ledger: 400,
    deployed_at: '2026-07-04T00:00:00Z',
  },
  {
    network: 'mainnet',
    contract_id: 'CAAAA',
    deployer: 'GDEPLOY3',
    wasm_hash: 'wasm2',
    deployed_ledger: 400,
    deployed_at: '2026-07-04T00:00:00Z',
  },
  {
    network: 'mainnet',
    contract_id: 'C1111',
    deployer: 'GDEPLOY4',
    wasm_hash: 'wasm3',
    deployed_ledger: 300,
    deployed_at: '2026-07-03T00:00:00Z',
  },
  {
    network: 'mainnet',
    contract_id: 'C0000',
    deployer: 'GDEPLOY5',
    wasm_hash: 'wasm4',
    deployed_ledger: 200,
    deployed_at: '2026-07-02T00:00:00Z',
  },
];

function createInMemoryPool(rows: ContractRow[]): Pool {
  return {
    async query(sql: string, params: unknown[] = []) {
      const network = String(params[0]);
      let filtered = rows
        .filter((r) => r.network === network)
        .sort((a, b) =>
          b.deployed_ledger !== a.deployed_ledger
            ? b.deployed_ledger - a.deployed_ledger
            : b.contract_id.localeCompare(a.contract_id)
        );

      // Keyset cursor params: [network, deployed_ledger, contract_id, limit]
      if (params.length === 4 && sql.includes('deployed_ledger')) {
        const cursorLedger = Number(params[1]);
        const cursorId = String(params[2]);
        filtered = filtered.filter(
          (r) =>
            r.deployed_ledger < cursorLedger ||
            (r.deployed_ledger === cursorLedger && r.contract_id < cursorId)
        );
      }

      const limit = Number(params[params.length - 1]);
      return { rows: filtered.slice(0, limit) };
    },
  } as unknown as Pool;
}

describe('Query.contractsPage (#382)', () => {
  test('walks every indexed contract page by page with cursor round-tripping across same-ledger ties', async () => {
    const pool = createInMemoryPool(DATASET);
    const ctx = createContext(pool);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    while (true) {
      const page = await resolvers.Query.contractsPage(
        {},
        { limit: 2, cursor },
        ctx
      );
      pages += 1;

      for (const item of page.items) {
        seen.push(item.contractId);
      }

      if (pages === 1) {
        assert.equal(page.pageInfo.hasPreviousPage, false);
        assert.equal(page.pageInfo.hasNextPage, true);
        assert.ok(page.pageInfo.endCursor);
      }

      if (!page.pageInfo.hasNextPage) {
        assert.equal(page.pageInfo.cursor, page.pageInfo.endCursor);
        break;
      }

      assert.ok(page.pageInfo.endCursor, 'expected endCursor while hasNextPage is true');
      cursor = page.pageInfo.endCursor;
    }

    assert.equal(pages, 3);
    assert.deepEqual(seen, ['CZZZZ', 'CBBBB', 'CAAAA', 'C1111', 'C0000']);
  });

  test('rejects malformed or wrong-query cursors with INVALID_CURSOR', async () => {
    const pool = createInMemoryPool(DATASET);
    const ctx = createContext(pool);

    await assert.rejects(
      () => resolvers.Query.contractsPage({}, { limit: 2, cursor: 'not-a-cursor' }, ctx),
      (err: unknown) =>
        err instanceof InvalidCursorError && err.code === ERROR_CODES.INVALID_CURSOR
    );

    const wrongQueryCursor = encodeCursor('transactions', [500, 'abc']);
    await assert.rejects(
      () => resolvers.Query.contractsPage({}, { limit: 2, cursor: wrongQueryCursor }, ctx),
      (err: unknown) =>
        err instanceof InvalidCursorError && err.code === ERROR_CODES.INVALID_CURSOR
    );
  });
});

describe('ContractDeployment network propagation (#383)', () => {
  test('contract, contracts, contractsPage, and sharedWasmContracts preserve parent network', async () => {
    const seenNetworks: string[] = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        const network = String(params[0]);
        seenNetworks.push(network);
        if (sql.includes('contract_id = $2')) {
          return {
            rows: [
              {
                contract_id: String(params[1]),
                deployer: 'GDEPLOY_TESTNET',
                wasm_hash: 'shared-wasm-abc',
                deployed_ledger: 900,
                deployed_at: '2026-07-10T00:00:00Z',
              },
            ],
          };
        }
        if (sql.includes('wasm_hash = $2')) {
          return {
            rows: [
              {
                contract_id: 'CSIBLING_TESTNET',
                deployer: 'GDEPLOY_TESTNET',
                wasm_hash: String(params[1]),
                deployed_ledger: 901,
                deployed_at: '2026-07-10T00:01:00Z',
              },
            ],
          };
        }
        return {
          rows: [
            {
              contract_id: 'CLIST_TESTNET',
              deployer: 'GDEPLOY_TESTNET',
              wasm_hash: 'shared-wasm-abc',
              deployed_ledger: 902,
              deployed_at: '2026-07-10T00:02:00Z',
            },
          ],
        };
      },
    } as unknown as Pool;

    const multiNetworkRegistry = loadNetworks({
      NETWORKS: 'mainnet,testnet',
      MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
      TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    });

    const ctx = createContext(pool, { networks: multiNetworkRegistry });

    const single = await resolvers.Query.contract(
      {},
      { network: 'TESTNET', contractId: 'CROOT_TESTNET' },
      ctx
    );
    assert.ok(single);
    assert.equal(single.network, 'testnet');

    const siblings = await resolvers.ContractDeployment.sharedWasmContracts(
      single,
      { limit: 5 },
      ctx
    );
    assert.equal(siblings.length, 1);
    assert.equal(siblings[0].contractId, 'CSIBLING_TESTNET');
    assert.equal(siblings[0].network, 'testnet');

    // Nested resolution on the sibling must still stay on testnet.
    const nested = await resolvers.ContractDeployment.sharedWasmContracts(
      siblings[0],
      { limit: 5 },
      ctx
    );
    assert.equal(nested[0].network, 'testnet');

    const list = await resolvers.Query.contracts({}, { network: 'TESTNET', limit: 5 }, ctx);
    assert.equal(list[0].network, 'testnet');

    const page = await resolvers.Query.contractsPage({}, { network: 'TESTNET', limit: 5 }, ctx);
    assert.equal(page.items[0].network, 'testnet');

    assert.deepEqual(seenNetworks, ['testnet', 'testnet', 'testnet', 'testnet', 'testnet']);
  });
});
