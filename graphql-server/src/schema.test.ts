import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchema, type GraphQLSchema } from 'graphql';

const schemaPath = resolve(__dirname, 'schema.graphql');
const schema: GraphQLSchema = buildSchema(readFileSync(schemaPath, 'utf8'));

// A description is the only thing the playground has to go on, so an undocumented
// argument is as much a defect as a wrong type. Checking it here means the schema
// cannot quietly regress into a wall of bare names.

test('every type is described', () => {
  const undocumented: string[] = [];

  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (name.startsWith('__')) continue;
    if (!type.astNode) continue; // built-in scalars
    if (!type.description) undocumented.push(name);
  }

  assert.deepEqual(undocumented, []);
});

test('every field and argument is described', () => {
  const undocumented: string[] = [];

  for (const [typeName, type] of Object.entries(schema.getTypeMap())) {
    if (typeName.startsWith('__')) continue;
    if (!('getFields' in type)) continue;

    for (const [fieldName, field] of Object.entries(type.getFields())) {
      if (!field.description) undocumented.push(`${typeName}.${fieldName}`);

      // input fields carry no args
      for (const arg of field.args ?? []) {
        if (!arg.description) undocumented.push(`${typeName}.${field.name}(${arg.name})`);
      }
    }
  }

  assert.deepEqual(undocumented, []);
});

test('every enum value is described', () => {
  const undocumented: string[] = [];

  for (const [typeName, type] of Object.entries(schema.getTypeMap())) {
    if (typeName.startsWith('__')) continue;
    if (!('getValues' in type)) continue;

    for (const value of type.getValues()) {
      if (!value.description) undocumented.push(`${typeName}.${value.name}`);
    }
  }

  assert.deepEqual(undocumented, []);
});

test('every paginated query says how to resume', () => {
  const query = schema.getQueryType();
  assert.ok(query, 'schema has a Query type');

  const paginated = Object.values(query.getFields()).filter(
    (field) => field.args.some((arg) => arg.name === 'cursor'),
  );

  assert.ok(paginated.length > 0, 'schema has paginated queries');

  for (const field of paginated) {
    assert.match(field.description ?? '', /PageInfo/, `Query.${field.name} documents where to resume`);
  }
});
