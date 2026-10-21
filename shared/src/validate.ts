/**
 * Boundary validation for Horizon responses.
 *
 * Horizon's response types are TypeScript interfaces, which exist only at
 * compile time. A `res.json() as T` cast checks nothing, so a field that is
 * missing or the wrong type reaches the write path as `undefined` and fails
 * deep inside a database insert with an error that names no field. The checks
 * here run once, where the bytes arrive, and fail with the path of the first
 * field that does not match, along with the raw body for diagnosis.
 *
 * The specs list only the fields a consumer reads. Horizon adds fields over
 * time, and an unknown field is not an error: the check is for the shape the
 * code depends on, not for a byte-for-byte match with a Horizon version.
 */

type Kind = 'string' | 'number' | 'boolean' | 'object' | 'array';

/** A field rule: a kind, or a kind with a trailing `?` when the field may be absent. */
export type FieldRule = Kind | `${Kind}?`;

export type RecordSpec = Readonly<Record<string, FieldRule>>;

/** Thrown when a response does not match its spec. Names the field, keeps the raw body. */
export class HorizonResponseError extends Error {
  readonly field: string;
  readonly url: string;
  /** The response body as received, truncated to `RAW_RESPONSE_LIMIT` characters. */
  readonly raw: string;

  constructor(url: string, field: string, problem: string, raw: string) {
    super(`Horizon response from ${url} is malformed: ${field} ${problem}`);
    this.name = 'HorizonResponseError';
    this.url = url;
    this.field = field;
    this.raw = raw;
  }
}

/** Characters of the raw response kept on an error or in a log line. */
export const RAW_RESPONSE_LIMIT = 4096;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function matches(kind: Kind, value: unknown): boolean {
  switch (kind) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return typeof value === kind;
  }
}

/**
 * Checks one object against a spec. Returns nothing; throws a plain `Error`
 * naming the failing path, which the caller wraps with the URL and raw body.
 */
export function checkRecord(value: unknown, spec: RecordSpec, path: string): void {
  if (!matches('object', value)) {
    throw new ShapeProblem(path, `expected an object, got ${describe(value)}`);
  }
  const record = value as Record<string, unknown>;
  for (const [field, rule] of Object.entries(spec)) {
    const optional = rule.endsWith('?');
    const kind = (optional ? rule.slice(0, -1) : rule) as Kind;
    const fieldValue = record[field];
    const fieldPath = `${path}.${field}`;
    if (fieldValue === undefined || fieldValue === null) {
      if (optional) continue;
      throw new ShapeProblem(fieldPath, 'is missing');
    }
    if (!matches(kind, fieldValue)) {
      throw new ShapeProblem(fieldPath, `expected ${kind}, got ${describe(fieldValue)}`);
    }
  }
}

/**
 * Checks a paged Horizon response: `_embedded.records` is an array and every
 * record matches `spec`. A failure reports the index of the record, so a
 * malformed record in a 200-record page is findable without a debugger.
 */
export function checkPage(value: unknown, spec: RecordSpec): void {
  checkRecord(value, { _embedded: 'object' }, 'response');
  const embedded = (value as { _embedded: Record<string, unknown> })._embedded;
  if (!Array.isArray(embedded.records)) {
    throw new ShapeProblem('response._embedded.records', `expected an array, got ${describe(embedded.records)}`);
  }
  embedded.records.forEach((record, index) => checkRecord(record, spec, `records[${index}]`));
}

/** Internal carrier so the failing path survives until the caller adds the URL and body. */
export class ShapeProblem extends Error {
  readonly field: string;
  readonly problem: string;

  constructor(field: string, problem: string) {
    super(`${field} ${problem}`);
    this.name = 'ShapeProblem';
    this.field = field;
    this.problem = problem;
  }
}

/** Fields the indexer reads from each Horizon resource. Kept beside the checks so a new read is a new line here. */
export const LEDGER_SPEC: RecordSpec = {
  sequence: 'number',
  closed_at: 'string',
  successful_transaction_count: 'number',
  failed_transaction_count: 'number',
  operation_count: 'number',
  base_fee_in_stroops: 'number',
  base_reserve_in_stroops: 'number',
};

export const TRANSACTION_SPEC: RecordSpec = {
  hash: 'string',
  ledger: 'number',
  created_at: 'string',
  source_account: 'string',
  fee_charged: 'string',
  operation_count: 'number',
  successful: 'boolean',
  memo_type: 'string',
  memo: 'string?',
  source_account_sequence: 'string?',
};

export const OPERATION_SPEC: RecordSpec = {
  id: 'string',
  type: 'string',
  transaction_hash: 'string',
  created_at: 'string',
  source_account: 'string',
};

export const ACCOUNT_SPEC: RecordSpec = {
  account_id: 'string',
  sequence: 'string',
  subentry_count: 'number',
  last_modified_ledger: 'number',
  num_sponsored: 'number',
  num_sponsoring: 'number',
  balances: 'array',
  flags: 'object',
  thresholds: 'object',
};

export const TRADE_SPEC: RecordSpec = {
  id: 'string',
  paging_token: 'string',
  ledger_close_time: 'string',
  base_account: 'string',
  base_amount: 'string',
  base_asset_type: 'string',
  counter_amount: 'string',
  counter_asset_type: 'string',
};

export const EFFECT_SPEC: RecordSpec = {
  id: 'string',
  paging_token: 'string',
  operation_id: 'string',
  type: 'string',
  type_i: 'number',
  created_at: 'string',
  account: 'string',
  details: 'object',
};
