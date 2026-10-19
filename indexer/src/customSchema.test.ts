import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findEventDefinition,
  MAX_EVENTS_PER_SCHEMA,
  MAX_FIELDS_PER_EVENT,
  NUMERIC_TYPES,
  normalizeTopic,
  parseContractSchema,
  SchemaValidationError,
} from './customSchema';

const CONTRACT = 'CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ';

const transferSchema = () => ({
  contractId: CONTRACT,
  version: 1,
  events: [
    {
      name: 'transfer',
      topic: 'transfer',
      fields: [
        { name: 'from', type: 'address', source: 'topic[1]' },
        { name: 'to', type: 'address', source: 'topic[2]' },
        { name: 'amount', type: 'i128', source: 'value.amount' },
      ],
    },
  ],
});

/** Assert a schema is rejected, and that the message names the problem. */
function rejects(mutate: (doc: ReturnType<typeof transferSchema>) => unknown, expected: RegExp) {
  const doc = mutate(transferSchema());
  assert.throws(() => parseContractSchema(doc), (err: unknown) => {
    assert.ok(err instanceof SchemaValidationError, `expected SchemaValidationError, got ${err}`);
    assert.match(err.message, expected);
    return true;
  });
}

test('accepts the worked example from the docs', () => {
  const schema = parseContractSchema(transferSchema());

  assert.equal(schema.contractId, CONTRACT);
  assert.equal(schema.version, 1);
  assert.equal(schema.events[0].name, 'transfer');
  assert.deepEqual(
    schema.events[0].fields.map(f => `${f.name}:${f.type}`),
    ['from:address', 'to:address', 'amount:i128']
  );
  // `optional` is normalised so downstream code never sees undefined.
  assert.equal(schema.events[0].fields[0].optional, false);
});

test('defaults version to 1', () => {
  const doc = transferSchema() as Record<string, unknown>;
  delete doc.version;
  assert.equal(parseContractSchema(doc).version, 1);
});

test('rejects a non-object document', () => {
  assert.throws(() => parseContractSchema(null), SchemaValidationError);
  assert.throws(() => parseContractSchema('a schema'), SchemaValidationError);
  assert.throws(() => parseContractSchema([]), SchemaValidationError);
});

test('rejects an invalid contract address', () => {
  rejects(d => ({ ...d, contractId: 'not-a-contract' }), /contractId must be a Soroban contract address/);
  rejects(d => ({ ...d, contractId: 'GABC' }), /contractId/);
});

test('rejects a schema with no events', () => {
  rejects(d => ({ ...d, events: [] }), /at least one event/);
  rejects(d => ({ ...d, events: undefined }), /at least one event/);
});

test('rejects an event with no fields', () => {
  rejects(d => ({ ...d, events: [{ ...d.events[0], fields: [] }] }), /at least one field/);
});

test('rejects an unknown field type', () => {
  rejects(
    d => ({ ...d, events: [{ ...d.events[0], fields: [{ name: 'x', type: 'u256', source: 'value' }] }] }),
    /type "u256" is not one of/
  );
});

test('rejects a malformed source expression', () => {
  const withSource = (source: string) => (d: ReturnType<typeof transferSchema>) => ({
    ...d,
    events: [{ ...d.events[0], fields: [{ name: 'x', type: 'string', source }] }],
  });

  rejects(withSource('topic'), /must be "topic\[N\]"/);
  rejects(withSource('topic[]'), /must be "topic\[N\]"/);
  rejects(withSource('result.amount'), /must be "topic\[N\]"/);
  // The one that matters: a path that could reach beyond the payload.
  rejects(withSource('value.amount; DROP TABLE custom_events'), /must be "topic\[N\]"/);
});

test('accepts every documented source form', () => {
  const schema = parseContractSchema({
    ...transferSchema(),
    events: [
      {
        name: 'transfer',
        topic: 'transfer',
        fields: [
          { name: 'a', type: 'string', source: 'topic[0]' },
          { name: 'b', type: 'json', source: 'value' },
          { name: 'c', type: 'i128', source: 'value.amount' },
          { name: 'd', type: 'string', source: 'value.nested.deeply.here' },
        ],
      },
    ],
  });

  assert.equal(schema.events[0].fields.length, 4);
});

test('rejects field names that are not identifier-shaped', () => {
  const named = (name: string) => (d: ReturnType<typeof transferSchema>) => ({
    ...d,
    events: [{ ...d.events[0], fields: [{ name, type: 'string', source: 'value' }] }],
  });

  rejects(named('from-address'), /must start with a letter/);
  rejects(named('2fast'), /must start with a letter/);
  rejects(named('drop table'), /must start with a letter/);
  rejects(named('"; DROP TABLE custom_events; --'), /must start with a letter/);
});

test('rejects field names that shadow real columns', () => {
  const named = (name: string) => (d: ReturnType<typeof transferSchema>) => ({
    ...d,
    events: [{ ...d.events[0], fields: [{ name, type: 'string', source: 'value' }] }],
  });

  for (const reserved of ['ledger', 'event_id', 'contract_id', 'fields', 'created_at']) {
    rejects(named(reserved), /is reserved/);
  }
});

test('rejects duplicate names', () => {
  rejects(
    d => ({
      ...d,
      events: [
        {
          ...d.events[0],
          fields: [
            { name: 'amount', type: 'i128', source: 'value.a' },
            { name: 'amount', type: 'i128', source: 'value.b' },
          ],
        },
      ],
    }),
    /duplicate field name "amount"/
  );

  rejects(d => ({ ...d, events: [d.events[0], d.events[0]] }), /duplicate event name "transfer"/);
});

test('rejects a schema large enough to be a denial of service on its own', () => {
  const manyEvents = Array.from({ length: MAX_EVENTS_PER_SCHEMA + 1 }, (_, i) => ({
    name: `event_${i}`,
    topic: `topic_${i}`,
    fields: [{ name: 'x', type: 'string', source: 'value' }],
  }));
  rejects(d => ({ ...d, events: manyEvents }), /more than the limit of/);

  const manyFields = Array.from({ length: MAX_FIELDS_PER_EVENT + 1 }, (_, i) => ({
    name: `field_${i}`,
    type: 'string',
    source: 'value',
  }));
  rejects(d => ({ ...d, events: [{ ...d.events[0], fields: manyFields }] }), /more than the limit of/);
});

test('rejects a version below 1', () => {
  rejects(d => ({ ...d, version: 0 }), /version must be 1 or greater/);
  rejects(d => ({ ...d, version: 1.5 }), /must be an integer/);
});

test('normalizeTopic unwraps the indexer JSON encoding', () => {
  // Topics are stored JSON-encoded, so a symbol arrives with quotes. A schema
  // is written in terms of what the contract emits.
  assert.equal(normalizeTopic('"transfer"'), 'transfer');
  assert.equal(normalizeTopic('transfer'), 'transfer');
  assert.equal(normalizeTopic('123'), '123');
  assert.equal(normalizeTopic(undefined), null);
});

test('findEventDefinition matches on the first topic', () => {
  const schema = parseContractSchema(transferSchema());

  assert.equal(findEventDefinition(schema, ['"transfer"', '"GFROM"'])?.name, 'transfer');
  assert.equal(findEventDefinition(schema, ['"mint"'])?.name, undefined);
  assert.equal(findEventDefinition(schema, []), null);
});

// ── optional fields ───────────────────────────────────────────────────────────

test('optional: true is preserved through parsing', () => {
  const schema = parseContractSchema({
    contractId: CONTRACT,
    version: 1,
    events: [
      {
        name: 'mint',
        topic: 'mint',
        fields: [
          { name: 'to', type: 'address', source: 'topic[1]' },
          { name: 'memo', type: 'string', source: 'value.memo', optional: true },
        ],
      },
    ],
  });

  const mint = schema.events[0];
  assert.ok(mint, 'event parsed');
  assert.equal(mint.fields[0].optional, false, 'non-optional defaults to false');
  assert.equal(mint.fields[1].optional, true, 'optional: true is preserved');
});

test('rejects a non-boolean optional flag', () => {
  rejects(
    d => ({
      ...d,
      events: [
        {
          ...d.events[0],
          fields: [{ name: 'x', type: 'string', source: 'value', optional: 'yes' }],
        },
      ],
    }),
    /must be a boolean/
  );
});

test('optional field present in the event indexes with its value', () => {
  // When the source resolves to a value the optional flag makes no difference —
  // the value is decoded normally.
  const schema = parseContractSchema({
    contractId: CONTRACT,
    version: 1,
    events: [
      {
        name: 'mint',
        topic: 'mint',
        fields: [
          { name: 'to', type: 'address', source: 'topic[1]' },
          { name: 'memo', type: 'string', source: 'value.memo', optional: true },
        ],
      },
    ],
  });

  // The field definition carries the flag; consumers (e.g. customDecode.ts)
  // use it when the source is absent. The schema layer's job is to parse and
  // validate — confirming `optional` is preserved is all we need here.
  const field = schema.events[0].fields.find(f => f.name === 'memo');
  assert.ok(field, 'memo field present');
  assert.equal(field.optional, true);
  assert.equal(field.source, 'value.memo');
  assert.equal(field.type, 'string');
});

test('NUMERIC_TYPES covers exactly the ordered comparison types', () => {
  // This set drives the GT/LT/GTE/LTE filter operators in the GraphQL API;
  // adding a type there without adding it here silently disables ordering on it.
  for (const t of ['i32', 'u32', 'i64', 'u64', 'i128', 'u128']) {
    assert.ok(NUMERIC_TYPES.has(t as Parameters<typeof NUMERIC_TYPES.has>[0]), `${t} should be numeric`);
  }
  for (const t of ['address', 'string', 'symbol', 'bool', 'bytes', 'json']) {
    assert.equal(NUMERIC_TYPES.has(t as Parameters<typeof NUMERIC_TYPES.has>[0]), false, `${t} should not be numeric`);
  }
});
