/**
 * Applying a {@link ContractSchema} to a raw event: pull each declared field
 * out of the topics or the value, coerce it to its declared type, and hand back
 * a flat record ready to store.
 *
 * ## Why every value is stored as a string
 *
 * `i128` is the type this exists for — token amounts — and it does not fit in a
 * JavaScript number. `JSON.parse` on an amount above 2^53 silently rounds it,
 * and a token indexer that rounds balances is worse than one that does not
 * decode them at all. So numeric fields are validated as integers and kept in
 * canonical decimal text, and Postgres casts them to `numeric` at query time,
 * where the arithmetic is exact.
 *
 * The same reasoning is why decoding *rejects* rather than guesses: a field
 * declared `i128` that arrives as an object is a schema that no longer matches
 * the contract, and silently storing null would hide that indefinitely.
 */
import type { ContractSchema, EventDefinition, FieldDefinition } from './customSchema';
import { findEventDefinition } from './customSchema';
import type { ContractEvent } from './soroban';

/** One schema-matched contract event, with all declared fields in canonical text form. */
export interface DecodedCustomEvent {
  /** Event paging token used as its stable database identifier. */
  eventId: string;
  contractId: string;
  eventName: string;
  ledger: number;
  createdAt: string;
  schemaVersion: number;
  /** Decoded field values; optional absent values are represented as `null`. */
  fields: Record<string, string | null>;
}

/** A schema-matched event that could not be decoded against its definition. */
export interface DecodeFailure {
  eventId: string;
  eventName: string;
  /** Human-readable cause, including the failing field and expected shape. */
  reason: string;
}

/** Successfully decoded events and per-event failures from one input batch. */
export interface DecodeResult {
  decoded: DecodedCustomEvent[];
  /** Events that matched a definition but could not be decoded against it. */
  failures: DecodeFailure[];
}

/**
 * Decode every event that matches a schema into named, string-valued fields.
 *
 * Events with no matching definition are skipped silently — a contract emits
 * plenty a schema does not care about, and that is not an error. Events that
 * *do* match but fail to decode are reported, because that means the schema and
 * the contract have diverged and someone needs to know.
 */
export function decodeEvents(schemas: Map<string, ContractSchema>, events: ContractEvent[]): DecodeResult {
  const decoded: DecodedCustomEvent[] = [];
  const failures: DecodeFailure[] = [];

  for (const event of events) {
    const schema = schemas.get(event.contractId);
    if (!schema) continue;

    const definition = findEventDefinition(schema, event.topics);
    if (!definition) continue;

    try {
      decoded.push({
        eventId: event.id,
        contractId: event.contractId,
        eventName: definition.name,
        ledger: event.ledger,
        createdAt: event.createdAt,
        schemaVersion: schema.version,
        fields: decodeFields(definition, event),
      });
    } catch (err) {
      failures.push({
        eventId: event.id,
        eventName: definition.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { decoded, failures };
}

function decodeFields(definition: EventDefinition, event: ContractEvent): Record<string, string | null> {
  const fields: Record<string, string | null> = {};

  for (const field of definition.fields) {
    const raw = readSource(field.source, event);

    if (raw === undefined || raw === null) {
      if (!field.optional) {
        throw new Error(`field "${field.name}" is missing at source "${field.source}"`);
      }
      fields[field.name] = null;
      continue;
    }

    fields[field.name] = coerce(field, raw);
  }

  return fields;
}

/** Resolve a `topic[N]` / `value` / `value.a.b` source against one event. */
function readSource(source: string, event: ContractEvent): unknown {
  const topicMatch = /^topic\[(\d+)\]$/.exec(source);
  if (topicMatch) {
    const raw = event.topics[Number(topicMatch[1])];
    if (raw === undefined) return undefined;
    // Topics are stored JSON-encoded; decode back to the native value so a
    // schema can talk about the value the contract emitted.
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  if (source === 'value') return event.value;

  const path = source.slice('value.'.length).split('.');
  let current: unknown = event.value;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function coerce(field: FieldDefinition, raw: unknown): string {
  switch (field.type) {
    case 'address':
    case 'string':
    case 'symbol':
      return coerceText(field, raw);

    case 'bool':
      if (typeof raw !== 'boolean') {
        throw new Error(`field "${field.name}" expected a bool, got ${describe(raw)}`);
      }
      return raw ? 'true' : 'false';

    case 'bytes':
      if (typeof raw === 'string') return raw;
      // stellar-sdk decodes Bytes to a Buffer/Uint8Array.
      if (raw instanceof Uint8Array) return Buffer.from(raw).toString('hex');
      throw new Error(`field "${field.name}" expected bytes, got ${describe(raw)}`);

    case 'i32':
    case 'u32':
    case 'i64':
    case 'u64':
    case 'i128':
    case 'u128':
      return coerceInteger(field, raw);

    case 'json':
      return JSON.stringify(raw);
  }
}

function coerceText(field: FieldDefinition, raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
    return String(raw);
  }
  throw new Error(`field "${field.name}" expected ${field.type}, got ${describe(raw)}`);
}

/**
 * Integers are kept as canonical decimal text.
 *
 * `bigint` is the shape stellar-sdk hands back for i128/u128, and it converts
 * exactly. A JS `number` is accepted only when it is a safe integer — past that
 * the value has already lost precision before reaching us, and storing it would
 * launder a rounding error into the database.
 */
function coerceInteger(field: FieldDefinition, raw: unknown): string {
  if (typeof raw === 'bigint') return raw.toString();

  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) {
      throw new Error(`field "${field.name}" expected an integer, got ${raw}`);
    }
    if (!Number.isSafeInteger(raw)) {
      throw new Error(
        `field "${field.name}" arrived as an unsafe JavaScript number (${raw}); ` +
          'the value has already lost precision upstream'
      );
    }
    return String(raw);
  }

  if (typeof raw === 'string') {
    if (!/^-?\d+$/.test(raw.trim())) {
      throw new Error(`field "${field.name}" expected an integer, got "${raw}"`);
    }
    // Round-trip through BigInt to normalise "+7" / "007" / " 7 ".
    return BigInt(raw.trim()).toString();
  }

  if (isUnsignedPair(raw)) {
    // Some decoders surface u128/i128 as { hi, lo }.
    return ((BigInt(raw.hi) << 64n) + BigInt(raw.lo)).toString();
  }

  throw new Error(`field "${field.name}" expected ${field.type}, got ${describe(raw)}`);
}

function isUnsignedPair(raw: unknown): raw is { hi: string | number | bigint; lo: string | number | bigint } {
  if (typeof raw !== 'object' || raw === null) return false;
  const candidate = raw as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint';
  return ok(candidate.hi) && ok(candidate.lo);
}

function describe(raw: unknown): string {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return 'an array';
  return `a ${typeof raw}`;
}
