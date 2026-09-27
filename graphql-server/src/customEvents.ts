/**
 * Querying decoded custom events.
 *
 * ## Why a generic query rather than a generated GraphQL type per schema
 *
 * The issue notes most indexers generate a type per schema, and that is the
 * nicer developer experience. It does not fit this deployment shape. The
 * indexer and the GraphQL server are separate processes: a schema registered
 * against the database would have to reach a *running* server and cause a
 * schema rebuild, which means a window where the advertised GraphQL schema and
 * the stored data disagree, a cache-busting story for every client, and —
 * since subscriptions now hold long-lived websockets — dropping every connected
 * subscriber on each registration.
 *
 * So the type stays fixed and the *values* carry their declared types. The
 * filtering, which is where typing actually earns its keep, is done
 * server-side against the declared type. The trade-off is real and worth
 * revisiting if schema registrations ever become rare enough to justify a
 * restart-on-change model.
 *
 * ## Why this is not an injection hole
 *
 * Field names come from a third-party schema, and they never enter SQL as
 * identifiers: a filter becomes `fields->>$n` with the name bound as a
 * parameter. The only parts of the statement derived from input are the
 * comparison operator and the cast, and both are looked up in fixed tables
 * below — a value not present in them is rejected before any SQL is built.
 */
import type { Pool } from 'pg';

export const NUMERIC_TYPES = new Set(['i32', 'u32', 'i64', 'u64', 'i128', 'u128']);

/** Whitelisted operators. Nothing else can reach the statement. */
const OPERATORS: Record<string, string> = {
  EQ: '=',
  NE: '<>',
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
};

const ORDERED_OPERATORS = new Set(['GT', 'GTE', 'LT', 'LTE']);

export interface StoredSchemaField {
  name: string;
  type: string;
  source: string;
  optional?: boolean;
}

export interface StoredSchemaEvent {
  name: string;
  topic: string;
  fields: StoredSchemaField[];
}

export interface StoredContractSchema {
  contractId: string;
  version: number;
  events: StoredSchemaEvent[];
}

export interface CustomEventFilter {
  field: string;
  op: string;
  value: string;
}

export class CustomQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomQueryError';
  }
}

interface CustomEventRow {
  event_id: string;
  contract_id: string;
  event_name: string;
  ledger: string | number;
  created_at: Date;
  schema_version: number;
  fields: Record<string, string | null>;
}

export async function getContractSchema(
  pool: Pool,
  network: string,
  contractId: string
): Promise<StoredContractSchema | null> {
  const { rows } = await pool.query<{ definition: StoredContractSchema }>(
    'SELECT definition FROM contract_schemas WHERE contract_id = $1 AND network = $2',
    [contractId, network]
  );
  return rows[0]?.definition ?? null;
}

/**
 * Build the WHERE clause for a set of filters, validated against the schema.
 *
 * Exported for tests: the SQL this produces is the security-sensitive part of
 * the feature, and asserting its exact shape is more useful than asserting
 * results through a fake pool.
 */
export function buildFilterClause(
  event: StoredSchemaEvent,
  filters: CustomEventFilter[],
  params: unknown[]
): string[] {
  const byName = new Map(event.fields.map(field => [field.name, field]));
  const clauses: string[] = [];

  for (const filter of filters) {
    const field = byName.get(filter.field);
    if (!field) {
      throw new CustomQueryError(
        `Unknown field "${filter.field}" for event "${event.name}". ` +
          `Available: ${event.fields.map(f => f.name).join(', ')}`
      );
    }

    const operator = OPERATORS[filter.op];
    if (!operator) {
      throw new CustomQueryError(`Unsupported operator "${filter.op}"`);
    }

    const numeric = NUMERIC_TYPES.has(field.type);
    if (ORDERED_OPERATORS.has(filter.op) && !numeric) {
      // Comparing addresses or strings with `>` would silently do a
      // lexicographic comparison, which is never what anyone means.
      throw new CustomQueryError(
        `Operator ${filter.op} needs a numeric field; "${field.name}" is ${field.type}`
      );
    }

    if (numeric) {
      if (!/^-?\d+$/.test(filter.value.trim())) {
        throw new CustomQueryError(
          `Filter on "${field.name}" (${field.type}) expects an integer, got "${filter.value}"`
        );
      }
      params.push(field.name, filter.value.trim());
      // `numeric` rather than bigint: i128 exceeds every fixed-width integer
      // type Postgres has, and numeric compares it exactly.
      clauses.push(
        `(fields->>$${params.length - 1})::numeric ${operator} $${params.length}::numeric`
      );
    } else {
      params.push(field.name, filter.value);
      clauses.push(`fields->>$${params.length - 1} ${operator} $${params.length}`);
    }
  }

  return clauses;
}

export interface CustomEventQuery {
  /** Network whose events to decode — schemas are registered per network too. */
  network: string;
  contractId: string;
  event: string;
  where?: CustomEventFilter[] | null;
  limit: number;
  cursor?: string | null;
}

export async function getCustomEvents(pool: Pool, query: CustomEventQuery) {
  const schema = await getContractSchema(pool, query.network, query.contractId);
  if (!schema) {
    throw new CustomQueryError(`No custom schema registered for contract ${query.contractId}`);
  }

  const event = schema.events.find(e => e.name === query.event);
  if (!event) {
    throw new CustomQueryError(
      `Contract ${query.contractId} has no event "${query.event}". ` +
        `Available: ${schema.events.map(e => e.name).join(', ')}`
    );
  }

  const params: unknown[] = [query.contractId, query.event, query.network];
  const conditions = ['contract_id = $1', 'event_name = $2', 'network = $3'];

  conditions.push(...buildFilterClause(event, query.where ?? [], params));

  if (query.cursor) {
    params.push(query.cursor);
    conditions.push(
      `(ledger, event_id) < (SELECT ledger, event_id FROM custom_events WHERE event_id = $${params.length} AND network = $3 LIMIT 1)`
    );
  }

  params.push(query.limit);

  const { rows } = await pool.query<CustomEventRow>(
    `SELECT * FROM custom_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY ledger DESC, event_id DESC
      LIMIT $${params.length}`,
    params
  );

  return rows.map(row => mapCustomEvent(row, event));
}

/**
 * Shape a row for GraphQL, using the schema to attach each value's declared
 * type and to surface fields the event did not carry as explicit nulls rather
 * than as absences.
 */
export function mapCustomEvent(row: CustomEventRow, event: StoredSchemaEvent) {
  return {
    eventId: row.event_id,
    contractId: row.contract_id,
    eventName: row.event_name,
    ledger: Number(row.ledger),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    schemaVersion: row.schema_version,
    fields: event.fields.map(field => ({
      name: field.name,
      type: field.type,
      value: row.fields?.[field.name] ?? null,
    })),
  };
}
