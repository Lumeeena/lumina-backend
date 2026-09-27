/**
 * Tests for the plan-signature comparison behind `npm run explain`.
 *
 * These exist because the regression check is only worth having if it has been
 * seen to fire. A checker that has never reported a regression is not evidence
 * of anything — so the interesting cases here are plans that *changed*: an
 * index that stopped being used, a scan that appeared, a query that was edited.
 * The other half of the job is the opposite: a plan that differs only in
 * timings and costs must produce no diff at all, or the check cries wolf and
 * people stop reading it.
 *
 * The plan documents are hand-written EXPLAIN (FORMAT JSON) output, kept small.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { diffSignatures, extractPlan, planSignature, summarise } from './explain';

/** A statement served by an index: Limit -> Index Scan. */
const indexPlan = {
  Plan: {
    'Node Type': 'Limit',
    'Actual Rows': 20,
    Plans: [
      {
        'Node Type': 'Index Scan',
        'Relation Name': 'transactions',
        'Index Name': 'idx_transactions_ledger',
        'Actual Rows': 20,
      },
    ],
  },
  'Planning Time': 0.412,
  'Execution Time': 0.088,
};

/** The same shape after the index stopped being usable: Limit -> Sort -> Seq Scan. */
const seqScanPlan = {
  Plan: {
    'Node Type': 'Limit',
    'Actual Rows': 20,
    Plans: [
      {
        'Node Type': 'Sort',
        'Actual Rows': 20,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'operations',
            'Actual Rows': 6000000,
          },
        ],
      },
    ],
  },
  'Planning Time': 1.9,
  'Execution Time': 2140.5,
};

/** The same plan as `indexPlan` with nothing changed but cost and time. */
const indexPlanSlower = {
  Plan: {
    'Node Type': 'Limit',
    'Actual Rows': 20,
    'Total Cost': 99123.44,
    Plans: [
      {
        'Node Type': 'Index Scan',
        'Relation Name': 'transactions',
        'Index Name': 'idx_transactions_ledger',
        'Actual Rows': 20,
        'Actual Total Time': 41.2,
      },
    ],
  },
  'Planning Time': 9.5,
  'Execution Time': 118.3,
};

const signature = (plan: unknown, rowsReturned = 20, sql = 'SELECT * FROM transactions LIMIT 20') =>
  planSignature({ sql, plan, rowsReturned });

test('a signature records the index a plan used and no sequential scans', () => {
  const sig = signature(indexPlan);

  assert.deepEqual(sig.indexes, ['idx_transactions_ledger']);
  assert.deepEqual(sig.seqScans, []);
  assert.equal(sig.sorts, 0);
  assert.equal(sig.rowsReturned, 20);
});

test('a sequential scan and a sort are recorded, because both are the finding', () => {
  const sig = signature(seqScanPlan);

  assert.deepEqual(sig.seqScans, ['operations']);
  assert.equal(sig.sorts, 1);
  assert.deepEqual(sig.indexes, []);
});

test('timings and costs are not part of the signature', () => {
  // The whole reason the signature exists: a plan that took longer, or was
  // re-costed by fresh statistics, is not a regression.
  assert.deepEqual(signature(indexPlan), signature(indexPlanSlower));
});

test('an index that stops being used is reported, along with the scan that replaced it', () => {
  const deltas = diffSignatures(signature(indexPlan), signature(seqScanPlan));
  const kinds = deltas.map(d => d.kind);

  assert.ok(kinds.includes('index-lost'), `expected index-lost in ${kinds.join(',')}`);
  assert.ok(kinds.includes('seq-scan-added'), `expected seq-scan-added in ${kinds.join(',')}`);
  assert.ok(deltas.some(d => d.detail.includes('idx_transactions_ledger')));
});

test('an index scan that becomes a bitmap scan is not a lost index', () => {
  // Observed for real: between two consecutive runs of this audit, one entry
  // flipped between these two plans, which cost the same. The first version of
  // this comparison reported it as index-lost + index-added. A check that
  // reports a plan which did not change is a check nobody reads.
  const indexScan = {
    Plan: {
      'Node Type': 'Limit',
      Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'operations', 'Index Name': 'idx_operations_source' }],
    },
  };
  const bitmapScan = {
    Plan: {
      'Node Type': 'Limit',
      Plans: [
        {
          'Node Type': 'Bitmap Heap Scan',
          'Relation Name': 'operations',
          Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Name': 'idx_operations_source' }],
        },
      ],
    },
  };

  assert.deepEqual(diffSignatures(signature(indexScan), signature(bitmapScan)), []);
  assert.deepEqual(diffSignatures(signature(bitmapScan), signature(indexScan)), []);
});

test('an unchanged plan against the same baseline produces no deltas', () => {
  assert.deepEqual(diffSignatures(signature(indexPlan), signature(indexPlanSlower)), []);
});

test('an edited statement is reported even when the plan shape survives', () => {
  // Otherwise a WHERE clause could be rewritten, keep the same nodes, and the
  // baseline would quietly bless the new query as if nothing had happened.
  const deltas = diffSignatures(
    signature(indexPlan, 20, 'SELECT * FROM transactions LIMIT 20'),
    signature(indexPlan, 20, 'SELECT * FROM transactions WHERE successful LIMIT 20')
  );

  assert.deepEqual(deltas.map(d => d.kind), ['sql-changed']);
});

test('reindenting a statement is not reported as a change', () => {
  const deltas = diffSignatures(
    signature(indexPlan, 20, 'SELECT * FROM transactions\n   LIMIT 20'),
    signature(indexPlan, 20, 'SELECT *   FROM transactions LIMIT 20  ')
  );

  assert.deepEqual(deltas, []);
});

test('an index losing its index-only scan is not reported, and that is deliberate', () => {
  // An Index Only Scan usually becomes an Index Scan because the visibility map
  // was reset, which costs heap fetches and no correctness. "Index lost" has to
  // mean the index stopped being used at all, or the check fires on something
  // that says nothing about whether the query is still served.
  const indexOnly = {
    Plan: { 'Node Type': 'Index Only Scan', 'Relation Name': 'ledgers', 'Index Name': 'ledgers_pkey' },
  };
  const indexScan = {
    Plan: { 'Node Type': 'Index Scan', 'Relation Name': 'ledgers', 'Index Name': 'ledgers_pkey' },
  };

  assert.deepEqual(diffSignatures(signature(indexOnly), signature(indexScan)), []);
});

test('a sort appearing where there was none is reported', () => {
  const sorted = {
    Plan: {
      'Node Type': 'Limit',
      Plans: [
        {
          'Node Type': 'Sort',
          // The same index as the baseline plan, so the only difference is the sort.
          Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'transactions', 'Index Name': 'idx_transactions_ledger' }],
        },
      ],
    },
  };

  const deltas = diffSignatures(signature(indexPlan), signature(sorted));

  assert.deepEqual(deltas, [{ kind: 'sort-added', detail: '0 -> 1 sort nodes' }]);
});

test('a parallel sequential scan still counts as a sequential scan and is reported separately', () => {
  const parallel = {
    Plan: {
      'Node Type': 'Gather',
      Plans: [
        { 'Node Type': 'Parallel Seq Scan', 'Relation Name': 'operations', 'Actual Rows': 2000000 },
      ],
    },
  };

  assert.deepEqual(signature(parallel).seqScans, ['operations']);

  const deltas = diffSignatures(signature(indexPlan), signature(parallel));
  assert.ok(deltas.some(d => d.kind === 'seq-scan-added' && d.detail.includes('operations')));
});

test('a row count change is reported, because the seed or the predicate moved', () => {
  const deltas = diffSignatures(signature(indexPlan, 20), signature(indexPlan, 0));

  assert.deepEqual(deltas, [{ kind: 'rows-changed', detail: '20 -> 0 rows (the seed or the predicate changed)' }]);
});

test('extractPlan accepts the shapes EXPLAIN JSON arrives in', () => {
  // node-postgres parses the json column; other clients hand back text. Both
  // are real, and getting this wrong yields a signature of `undefined` that
  // would compare equal to every other broken signature.
  assert.equal(extractPlan(indexPlan)['Node Type'], 'Limit');
  assert.equal(extractPlan(JSON.stringify([indexPlan]))['Node Type'], 'Limit');
  assert.equal(extractPlan([indexPlan])['Node Type'], 'Limit');
});

test('extractPlan rejects anything that is not a plan, rather than returning junk', () => {
  assert.throws(() => extractPlan({ rows: [] }), /not an EXPLAIN/);
  assert.throws(() => extractPlan(null), /not an EXPLAIN/);
});

test('summarise leads with the finding a reader is looking for', () => {
  assert.equal(summarise(signature(indexPlan)), 'indexed | idx_transactions_ledger');
  assert.equal(summarise(signature(seqScanPlan)), 'scans | SEQ SCAN operations (1 sort)');
});
