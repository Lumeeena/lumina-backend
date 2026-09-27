const { existsSync, readFileSync } = require('fs');
const { execFileSync } = require('child_process');
const { buildSchema, findBreakingChanges, findDangerousChanges } = require('graphql');

const intentionalNullableRelationshipChanges = [
  'Transaction.operations',
  'Account.transactions',
  'Account.operations',
];

const currentPath = 'src/schema.graphql';
const snapshotPath = 'src/schema.snapshot.graphql';

function read(path) {
  return readFileSync(path, 'utf8').replace(/\s+$/u, '') + '\n';
}

function schemaFrom(text, label) {
  try {
    return buildSchema(text);
  } catch (err) {
    console.error(`${label} is not a valid GraphQL schema.`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function baseSnapshot() {
  const candidates = [
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}:${snapshotPath}` : null,
    `origin/main:${snapshotPath}`,
    `HEAD~1:${snapshotPath}`,
  ].filter(Boolean);

  for (const ref of candidates) {
    try {
      return execFileSync('git', ['show', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      // Local checkouts may not have a base ref. Falling back to the committed
      // snapshot still catches uncommitted schema drift.
    }
  }
  return read(snapshotPath);
}

if (!existsSync(snapshotPath)) {
  console.error(`${snapshotPath} is missing. Commit a schema snapshot.`);
  process.exit(1);
}

const current = read(currentPath);
const snapshot = read(snapshotPath);

if (current !== snapshot) {
  const breaking = findBreakingChanges(schemaFrom(snapshot, 'schema snapshot'), schemaFrom(current, 'current schema'));
  if (breaking.length > 0) {
    console.error('GraphQL schema has breaking changes compared with the committed snapshot:');
    for (const change of breaking) console.error(`- ${change.type}: ${change.description}`);
  } else {
    console.error('GraphQL schema differs from src/schema.snapshot.graphql. Update the snapshot with the additive change.');
  }
  process.exit(1);
}

const breakingFromBase = findBreakingChanges(schemaFrom(baseSnapshot(), 'base schema snapshot'), schemaFrom(current, 'current schema'));
const unapprovedBreaking = breakingFromBase.filter(change =>
  !intentionalNullableRelationshipChanges.some(field => change.description.includes(field))
);
if (unapprovedBreaking.length > 0 && process.env.ALLOW_BREAKING_SCHEMA !== '1') {
  console.error('GraphQL schema has breaking changes compared with the base snapshot:');
  for (const change of unapprovedBreaking) console.error(`- ${change.type}: ${change.description}`);
  console.error('Set ALLOW_BREAKING_SCHEMA=1 only when the breaking change is intentional.');
  process.exit(1);
}

const dangerous = findDangerousChanges(schemaFrom(baseSnapshot(), 'base schema snapshot'), schemaFrom(current, 'current schema'));
if (dangerous.length > 0) {
  console.warn('GraphQL schema has dangerous but non-breaking changes:');
  for (const change of dangerous) console.warn(`- ${change.type}: ${change.description}`);
}

console.log('GraphQL schema snapshot is current.');
