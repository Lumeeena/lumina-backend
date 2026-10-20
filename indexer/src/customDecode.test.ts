import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEvents } from './customDecode';
import { parseContractSchema, type ContractSchema } from './customSchema';
import type { ContractEvent } from './soroban';

const CONTRACT = 'CAYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ';
const OTHER_CONTRACT = 'CBYUDQPV3RKPM3EXDFGI3457FV677JLUCJ4OLKWGCUBPRIHYKXK3WFAZ';
const FROM = 'GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TO = 'GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function schema(overrides: Partial<SchemaDoc> = {}): ContractSchema {
  return parseContractSchema({ ...baseDoc(), ...overrides });
}

/** Widened so individual tests can add `optional` without fighting inference. */
interface SchemaDoc {
  contractId: string;
  version: number;
  events: {
    name: string;
    topic: string;
    fields: { name: string; type: string; source: string; optional?: boolean }[];
  }[];
}

function baseDoc(): SchemaDoc {
  return {
    contractId: CONTRACT,
    version: 2,
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
  };
}

function event(overrides: Partial<ContractEvent> = {}): ContractEvent {
  return {
    id: 'evt1',
    type: 'contract',
    contractId: CONTRACT,
    ledger: 500,
    createdAt: '2026-01-01T00:00:00Z',
    pagingToken: '500-1',
    topics: [JSON.stringify('transfer'), JSON.stringify(FROM), JSON.stringify(TO)],
    value: { amount: 1000n },
    transactionHash: null,
    ...overrides,
  };
}

const schemasFor = (s: ContractSchema) => new Map([[s.contractId, s]]);

test('decodes the worked example into named typed fields', () => {
  const { decoded, failures } = decodeEvents(schemasFor(schema()), [event()]);

  assert.equal(failures.length, 0);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0].fields, { from: FROM, to: TO, amount: '1000' });
  assert.equal(decoded[0].eventName, 'transfer');
  assert.equal(decoded[0].schemaVersion, 2);
  assert.equal(decoded[0].ledger, 500);
});

test('keeps an i128 exact rather than rounding it through a JS number', () => {
  // This is the whole reason values are stored as text. 2^80 has no
  // representation as a double, and a token indexer that rounds balances is
  // worse than one that does not decode them.
  const huge = 1208925819614629174706176n;
  const { decoded } = decodeEvents(schemasFor(schema()), [event({ value: { amount: huge } })]);

  assert.equal(decoded[0].fields.amount, '1208925819614629174706176');
  assert.equal(BigInt(decoded[0].fields.amount!), huge);
});

test('decodes an i128 represented as unsigned high and low 64-bit words', () => {
  const { decoded, failures } = decodeEvents(schemasFor(schema()), [
    event({ value: { amount: { hi: '65536', lo: '0' } } }),
  ]);

  assert.equal(failures.length, 0);
  assert.equal(decoded[0].fields.amount, '1208925819614629174706176');
});

test('accepts an integer already rendered as a string, normalised', () => {
  const cases: [unknown, string][] = [
    ['42', '42'],
    [' 42 ', '42'],
    ['007', '7'],
    ['-42', '-42'],
  ];

  for (const [raw, expected] of cases) {
    const { decoded } = decodeEvents(schemasFor(schema()), [event({ value: { amount: raw } })]);
    assert.equal(decoded[0].fields.amount, expected, `for ${JSON.stringify(raw)}`);
  }
});

test('rejects a number that has already lost precision upstream', () => {
  const { decoded, failures } = decodeEvents(schemasFor(schema()), [
    event({ value: { amount: 2 ** 70 } }),
  ]);

  assert.equal(decoded.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /unsafe JavaScript number/);
});

test('rejects a non-integer where an integer is declared', () => {
  const { failures } = decodeEvents(schemasFor(schema()), [event({ value: { amount: 1.5 } })]);
  assert.match(failures[0].reason, /expected an integer/);

  const bad = decodeEvents(schemasFor(schema()), [event({ value: { amount: 'lots' } })]);
  assert.match(bad.failures[0].reason, /expected an integer/);
});

test('reports a missing required field instead of storing a silent null', () => {
  // A schema that no longer matches the contract has to be visible, or it hides
  // indefinitely behind nulls.
  const { decoded, failures } = decodeEvents(schemasFor(schema()), [event({ value: {} })]);

  assert.equal(decoded.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /field "amount" is missing at source "value.amount"/);
  assert.equal(failures[0].eventId, 'evt1');
});

test('an optional field that is absent decodes to null', () => {
  const withMemo = schema({
    events: [
      {
        ...baseDoc().events[0],
        fields: [
          ...baseDoc().events[0].fields,
          { name: 'memo', type: 'string', source: 'value.memo', optional: true },
        ],
      },
    ],
  });

  const { decoded, failures } = decodeEvents(schemasFor(withMemo), [event()]);

  assert.equal(failures.length, 0);
  assert.equal(decoded[0].fields.memo, null);
});

test('skips events the schema does not describe, without calling them failures', () => {
  // A contract emits plenty a schema does not care about; that is not an error.
  const { decoded, failures } = decodeEvents(schemasFor(schema()), [
    event({ id: 'evt_mint', topics: [JSON.stringify('mint'), JSON.stringify(TO)] }),
  ]);

  assert.equal(decoded.length, 0);
  assert.equal(failures.length, 0);
});

test('ignores events from contracts with no registered schema', () => {
  const { decoded } = decodeEvents(schemasFor(schema()), [
    event({ id: 'evt_other', contractId: OTHER_CONTRACT }),
  ]);

  assert.equal(decoded.length, 0);
});

test('one undecodable event does not stop the rest of the batch', () => {
  const { decoded, failures } = decodeEvents(schemasFor(schema()), [
    event({ id: 'good1' }),
    event({ id: 'bad', value: {} }),
    event({ id: 'good2' }),
  ]);

  assert.deepEqual(decoded.map(d => d.eventId), ['good1', 'good2']);
  assert.deepEqual(failures.map(f => f.eventId), ['bad']);
});

test('decodes each declared type', () => {
  const typed = schema({
    events: [
      {
        name: 'mixed',
        topic: 'mixed',
        fields: [
          { name: 'flag', type: 'bool', source: 'value.flag' },
          { name: 'label', type: 'symbol', source: 'value.label' },
          { name: 'count', type: 'u32', source: 'value.count' },
          { name: 'blob', type: 'bytes', source: 'value.blob' },
          { name: 'raw', type: 'json', source: 'value.raw' },
        ],
      },
    ],
  });

  const { decoded, failures } = decodeEvents(schemasFor(typed), [
    event({
      topics: [JSON.stringify('mixed')],
      value: {
        flag: true,
        label: 'ok',
        count: 7,
        blob: new Uint8Array([0xde, 0xad]),
        raw: { nested: [1, 2] },
      },
    }),
  ]);

  assert.equal(failures.length, 0);
  assert.deepEqual(decoded[0].fields, {
    flag: 'true',
    label: 'ok',
    count: '7',
    blob: 'dead',
    raw: '{"nested":[1,2]}',
  });
});

test('reads a deeply nested value path', () => {
  const nested = schema({
    events: [
      {
        name: 'transfer',
        topic: 'transfer',
        fields: [{ name: 'amount', type: 'i128', source: 'value.detail.inner.amount' }],
      },
    ],
  });

  const { decoded } = decodeEvents(schemasFor(nested), [
    event({ value: { detail: { inner: { amount: 5n } } } }),
  ]);

  assert.equal(decoded[0].fields.amount, '5');
});

test('a value path through a non-object is a miss, not a crash', () => {
  const nested = schema({
    events: [
      {
        name: 'transfer',
        topic: 'transfer',
        fields: [{ name: 'amount', type: 'i128', source: 'value.detail.amount', optional: true }],
      },
    ],
  });

  const { decoded, failures } = decodeEvents(schemasFor(nested), [event({ value: { detail: 42 } })]);

  assert.equal(failures.length, 0);
  assert.equal(decoded[0].fields.amount, null);
});

test('decodes the whole value when source is "value"', () => {
  const whole = schema({
    events: [
      {
        name: 'transfer',
        topic: 'transfer',
        fields: [{ name: 'payload', type: 'json', source: 'value' }],
      },
    ],
  });

  const { decoded } = decodeEvents(schemasFor(whole), [event({ value: { a: 1 } })]);

  assert.equal(decoded[0].fields.payload, '{"a":1}');
});

test('a topic beyond the emitted topics is a miss', () => {
  const { failures } = decodeEvents(schemasFor(schema()), [
    event({ topics: [JSON.stringify('transfer')] }),
  ]);

  assert.match(failures[0].reason, /field "from" is missing at source "topic\[1\]"/);
});
