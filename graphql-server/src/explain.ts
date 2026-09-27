/**
 * Plan signatures — the stable part of an EXPLAIN ANALYZE result.
 *
 * ## Why not compare the plans directly
 *
 * Two runs of the same query on the same database produce plans that differ in
 * every timing, every cost estimate and every buffer count. Diffing raw plans
 * would fail on every run, and a check that cries wolf is one people learn to
 * ignore — which is worse than having no check, because it looks like coverage.
 *
 * What is actually stable on a deterministic database is the *shape*: which
 * nodes ran, which indexes were used, which relations were scanned end to end,
 * and how many rows came back. That is what a regression changes — a dropped
 * index turns an Index Scan into a Seq Scan, an edit to a WHERE clause changes
 * the SQL hash — and none of it is timing.
 *
 * Timings and costs are still captured, into the (gitignored) raw plan files
 * beside the baseline, where somebody investigating a diff can read them.
 *
 * This module is pure and dependency-free on purpose: it runs under `npm test`
 * with hand-written plan fixtures, so the diff logic is proven against a plan
 * that regressed rather than only against plans that happened to work.
 */

export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}

/** One relation access in a plan, and the index it went through if any. */
export interface ScanRef {
  node: string;
  relation: string | null;
  index: string | null;
}

export interface PlanSignature {
  /** Hash of the statement text: catches an edit the plan shape survives. */
  sqlHash: string;
  /**
   * Indexes the plan accessed, by name and deduplicated.
   *
   * Deliberately not a list of plan *nodes*: the planner flips between an Index
   * Scan and a Bitmap Index Scan + Bitmap Heap Scan on the same index whenever
   * their costs are near-equal, and it did exactly that between two consecutive
   * runs of this audit. Reporting a plan that did not change as a regression is
   * how a check stops being read, so the signature records which index was used
   * and not which node shape reached it.
   */
  indexes: string[];
  /** Relations read end to end. The finding the audit exists to produce. */
  seqScans: string[];
  /** Sort nodes. A sort appearing where there was none is a real change. */
  sorts: number;
  /** Rows the top node returned. Deterministic on a frozen seed. */
  rowsReturned: number;
}

export type DeltaKind =
  | 'sql-changed'
  | 'index-lost'
  | 'index-added'
  | 'seq-scan-added'
  | 'seq-scan-removed'
  | 'sort-added'
  | 'sort-removed'
  | 'rows-changed';

export interface Delta {
  kind: DeltaKind;
  detail: string;
}

function hash(sql: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('crypto') as typeof import('crypto');
  // Whitespace is normalised so a re-indent is not reported as a query change,
  // while any change to the tokens is.
  return 'sha256:' + createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/**
 * Accept the shape EXPLAIN (FORMAT JSON) arrives in.
 *
 * node-postgres parses the `json` column into a value already, but the same
 * query through other clients returns text — handle both, because the failure
 * mode of getting this wrong is a signature of `undefined` that compares equal
 * to every other wrong signature.
 */
export function extractPlan(raw: unknown): PlanNode {
  let value: unknown = raw;
  if (typeof value === 'string') value = JSON.parse(value);
  if (Array.isArray(value)) value = value[0];
  const plan = (value as { Plan?: PlanNode } | null)?.Plan;
  if (!plan || typeof plan['Node Type'] !== 'string') {
    throw new Error('not an EXPLAIN (FORMAT JSON) plan');
  }
  return plan;
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

export function planSignature(input: { sql: string; plan: unknown; rowsReturned: number }): PlanSignature {
  const root = extractPlan(input.plan);

  const indexes = new Set<string>();
  const seqScans = new Set<string>();
  let sorts = 0;

  walk(root, node => {
    if (node['Index Name']) indexes.add(node['Index Name']);

    if (node['Node Type'].includes('Sort')) sorts++;

    // A parallel sequential scan is still a sequential scan.
    if (node['Node Type'].includes('Seq Scan') && node['Relation Name']) {
      seqScans.add(node['Relation Name']);
    }
  });

  return {
    sqlHash: hash(input.sql),
    indexes: [...indexes].sort(),
    seqScans: [...seqScans].sort(),
    sorts,
    rowsReturned: input.rowsReturned,
  };
}

/** Every relation access in a plan, for the report rather than the comparison. */
export function planScans(plan: unknown): ScanRef[] {
  const scans: ScanRef[] = [];
  walk(extractPlan(plan), node => {
    if (node['Node Type'].endsWith('Scan')) {
      scans.push({
        node: node['Node Type'],
        relation: node['Relation Name'] ?? null,
        index: node['Index Name'] ?? null,
      });
    }
  });
  return scans;
}

function scanKey(scan: ScanRef): string {
  // A Bitmap Index Scan names its index but not its relation (the heap access
  // below it carries that), so the index is the part worth leading with.
  if (scan.index) return scan.relation ? `${scan.index} on ${scan.relation}` : scan.index;
  return `scan(${scan.relation ?? 'unknown'})`;
}

/** Compare a captured signature against the baseline's. Empty means unchanged. */
export function diffSignatures(baseline: PlanSignature, current: PlanSignature): Delta[] {
  const deltas: Delta[] = [];

  if (baseline.sqlHash !== current.sqlHash) {
    deltas.push({
      kind: 'sql-changed',
      detail: `statement text changed (${baseline.sqlHash} -> ${current.sqlHash})`,
    });
  }

  for (const index of baseline.indexes) {
    if (!current.indexes.includes(index)) {
      deltas.push({ kind: 'index-lost', detail: `${index} no longer used` });
    }
  }
  for (const index of current.indexes) {
    if (!baseline.indexes.includes(index)) {
      deltas.push({ kind: 'index-added', detail: `${index} now used` });
    }
  }

  if (baseline.sorts !== current.sorts) {
    deltas.push({
      kind: current.sorts > baseline.sorts ? 'sort-added' : 'sort-removed',
      detail: `${baseline.sorts} -> ${current.sorts} sort nodes`,
    });
  }

  for (const relation of current.seqScans) {
    if (!baseline.seqScans.includes(relation)) {
      deltas.push({ kind: 'seq-scan-added', detail: `sequential scan on ${relation}` });
    }
  }
  for (const relation of baseline.seqScans) {
    if (!current.seqScans.includes(relation)) {
      deltas.push({ kind: 'seq-scan-removed', detail: `no longer scans ${relation} sequentially` });
    }
  }

  if (baseline.rowsReturned !== current.rowsReturned) {
    deltas.push({
      kind: 'rows-changed',
      detail: `${baseline.rowsReturned} -> ${current.rowsReturned} rows (the seed or the predicate changed)`,
    });
  }

  return deltas;
}

/** One line for the report table: what the plan did, in the shape a reader wants. */
export function summarise(signature: PlanSignature): string {
  const access = [
    ...signature.seqScans.map(relation => `SEQ SCAN ${relation}`),
    ...signature.indexes,
  ].join('; ');
  const sort = signature.sorts > 0 ? ` (${signature.sorts} sort${signature.sorts > 1 ? 's' : ''})` : '';
  return `${signature.seqScans.length > 0 ? 'scans' : 'indexed'} | ${access || 'no relation access'}${sort}`;
}
