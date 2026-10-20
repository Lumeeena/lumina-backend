/**
 * The failures the chaos suite injects, one dependency at a time and then
 * together.
 *
 * Each was handled correctly in isolation by a unit test with a fake client.
 * What none of those could show is what the running services do: whether a
 * pool notices its connections are dead, whether a process that exits comes
 * back, whether a request that never answers holds everything behind it.
 * Faults go in at the wire — a reset socket, a 429, a port that stops
 * listening — so the code under test is the code that ships.
 */
import { sleep, type Stack } from '../stack/stack';

export interface Scenario {
  name: string;
  dependency: 'postgres' | 'horizon' | 'soroban' | 'combined';
  /** What the fault is, in operational terms. Printed in the report. */
  fault: string;
  /** How long the fault is held before it is cleared. */
  holdMs: number;
  inject(stack: Stack): Promise<{ midTransaction?: boolean }>;
  clear(stack: Stack): Promise<void>;
}

const HOLD_MS = Number(process.env['CHAOS_HOLD_MS'] ?? 15_000);

/**
 * Waits for the indexer to be inside a ledger transaction, so a database fault
 * lands between BEGIN and COMMIT rather than between ledgers. Gives up after a
 * few seconds and reports that it did: the scenario still runs, it just says
 * it was not mid-transaction.
 */
async function untilIndexerInTransaction(stack: Stack): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await stack.indexerInTransaction()) return true;
    await sleep(2);
  }
  return false;
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'postgres-backends-terminated',
    dependency: 'postgres',
    fault: 'every service backend killed with pg_terminate_backend, timed to land inside a ledger transaction (a Postgres restart or failover, as the services see it)',
    holdMs: 0,
    async inject(stack) {
      const midTransaction = await untilIndexerInTransaction(stack);
      await stack.terminateBackends();
      return { midTransaction };
    },
    async clear() {},
  },
  {
    name: 'postgres-down',
    dependency: 'postgres',
    fault: 'every connection reset and the port refusing new ones, timed to land inside a ledger transaction',
    holdMs: HOLD_MS,
    async inject(stack) {
      const midTransaction = await untilIndexerInTransaction(stack);
      await stack.proxy.setMode('down');
      return { midTransaction };
    },
    async clear(stack) {
      await stack.proxy.setMode('ok');
    },
  },
  {
    name: 'postgres-partition',
    dependency: 'postgres',
    fault: 'connections stay open but no byte moves either way (a network partition); traffic resumes intact',
    holdMs: HOLD_MS,
    async inject(stack) {
      const midTransaction = await untilIndexerInTransaction(stack);
      await stack.proxy.setMode('stall');
      return { midTransaction };
    },
    async clear(stack) {
      await stack.proxy.setMode('ok');
    },
  },
  {
    name: 'horizon-throttled',
    dependency: 'horizon',
    fault: 'every request answered 429 with Retry-After: 2',
    holdMs: HOLD_MS,
    async inject(stack) {
      await stack.horizon.setFault({ mode: 'throttle', retryAfterSeconds: 2 });
      return {};
    },
    async clear(stack) {
      await stack.horizon.setFault({ mode: 'ok' });
    },
  },
  {
    name: 'horizon-5xx',
    dependency: 'horizon',
    fault: 'every request answered 503',
    holdMs: HOLD_MS,
    async inject(stack) {
      await stack.horizon.setFault({ mode: 'error', status: 503 });
      return {};
    },
    async clear(stack) {
      await stack.horizon.setFault({ mode: 'ok' });
    },
  },
  {
    name: 'horizon-down',
    dependency: 'horizon',
    fault: 'the port stops listening; open sockets are reset',
    holdMs: HOLD_MS,
    async inject(stack) {
      await stack.horizon.setFault({ mode: 'down' });
      return {};
    },
    async clear(stack) {
      await stack.horizon.setFault({ mode: 'ok' });
    },
  },
  {
    name: 'horizon-hanging',
    dependency: 'horizon',
    fault: 'requests are accepted and never answered; requests already hanging stay hung after the fault clears',
    holdMs: HOLD_MS,
    async inject(stack) {
      await stack.horizon.setFault({ mode: 'hang' });
      return {};
    },
    async clear(stack) {
      await stack.horizon.setFault({ mode: 'ok' });
    },
  },
  {
    name: 'soroban-5xx',
    dependency: 'soroban',
    fault: 'every JSON-RPC call answered 503',
    holdMs: HOLD_MS,
    async inject(stack) {
      await stack.rpc.setFault({ mode: 'error', status: 503 });
      return {};
    },
    async clear(stack) {
      await stack.rpc.setFault({ mode: 'ok' });
    },
  },
  {
    name: 'soroban-down',
    dependency: 'soroban',
    fault: 'the port stops listening; open sockets are reset',
    holdMs: HOLD_MS,
    async inject(stack) {
      await stack.rpc.setFault({ mode: 'down' });
      return {};
    },
    async clear(stack) {
      await stack.rpc.setFault({ mode: 'ok' });
    },
  },
  {
    name: 'soroban-hanging',
    dependency: 'soroban',
    fault: 'calls are accepted and never answered; calls already hanging stay hung after the fault clears',
    holdMs: HOLD_MS,
    async inject(stack) {
      await stack.rpc.setFault({ mode: 'hang' });
      return {};
    },
    async clear(stack) {
      await stack.rpc.setFault({ mode: 'ok' });
    },
  },
  {
    // The combination the issue names: what an outage actually looks like.
    name: 'combined-outage',
    dependency: 'combined',
    fault: 'Horizon throttling (429) and Soroban RPC failing (503) while Postgres disappears mid-transaction; Postgres returns first, then Soroban, then Horizon',
    holdMs: HOLD_MS,
    async inject(stack) {
      // All three at once, after the indexer has opened a transaction: with
      // Horizon throttled first there would be no ledger left to be writing.
      const midTransaction = await untilIndexerInTransaction(stack);
      await Promise.all([
        stack.proxy.setMode('down'),
        stack.horizon.setFault({ mode: 'throttle', retryAfterSeconds: 2 }),
        stack.rpc.setFault({ mode: 'error', status: 503 }),
      ]);
      return { midTransaction };
    },
    async clear(stack) {
      // Staggered, because dependencies do not come back at the same instant,
      // and the order is the one where the services see the most combinations.
      await stack.proxy.setMode('ok');
      await sleep(2_000);
      await stack.rpc.setFault({ mode: 'ok' });
      await sleep(2_000);
      await stack.horizon.setFault({ mode: 'ok' });
    },
  },
];
