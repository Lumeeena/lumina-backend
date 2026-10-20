#!/usr/bin/env node
/**
 * Schema validation CLI - compares live database schema against expected schema.
 *
 * Compares the live database structure against the expected schema defined in
 * db/schema.sql and reports any discrepancies:
 * - Missing tables
 * - Missing columns
 * - Missing indexes
 *
 * Can be run at service startup behind a flag to gate startup on schema parity.
 *
 * Usage:
 *   validate-schema [--fail-on-mismatch]
 *
 * Environment:
 *   DATABASE_URL - PostgreSQL connection string
 *
 * Exit codes:
 *   0 - Schema matches expected
 *   1 - Schema mismatch detected (or with --fail-on-mismatch)
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { createPool } from './db';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/lumina';

interface SchemaDifference {
  type: 'missing_table' | 'missing_column' | 'missing_index';
  table?: string;
  column?: string;
  index?: string;
  details: string;
}

/**
 * Get the expected schema from db/schema.sql by parsing it.
 * Returns table names, columns, and indexes.
 */
function parseExpectedSchema(): {
  tables: Map<string, Set<string>>;
  indexes: Set<string>;
} {
  const schemaPath = join(__dirname, '../../db/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');

  const tables = new Map<string, Set<string>>();
  const indexes = new Set<string>();

  // Parse CREATE TABLE statements
  const tableRegex = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\);/g;
  let match;
  while ((match = tableRegex.exec(schema)) !== null) {
    const tableName = match[1];
    const tableBody = match[2];
    const columns = new Set<string>();

    // Parse column definitions (simplified - looks for column name followed by type)
    const columnRegex = /(\w+)\s+(?:TEXT|BIGINT|INTEGER|SMALLINT|BOOLEAN|TIMESTAMPTZ|NUMERIC|JSONB|TEXT\[\])/g;
    let colMatch;
    while ((colMatch = columnRegex.exec(tableBody)) !== null) {
      // Skip constraint names
      if (!colMatch[1].startsWith('CONSTRAINT')) {
        columns.add(colMatch[1]);
      }
    }

    tables.set(tableName, columns);
  }

  // Parse CREATE INDEX statements
  const indexRegex = /CREATE INDEX IF NOT EXISTS (\w+)/g;
  while ((match = indexRegex.exec(schema)) !== null) {
    indexes.add(match[1]);
  }

  return { tables, indexes };
}

/**
 * Get the live schema from the database.
 */
async function getLiveSchema(pool: Pool): Promise<{
  tables: Map<string, Set<string>>;
  indexes: Set<string>;
}> {
  const tables = new Map<string, Set<string>>();
  const indexes = new Set<string>();

  // Get all tables
  const { rows: tableRows } = await pool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_type = 'BASE TABLE'
    AND table_name != 'schema_migrations'
  `);

  for (const row of tableRows) {
    const tableName = row.table_name;
    const columns = new Set<string>();

    // Get columns for this table
    const { rows: colRows } = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND table_name = $1
    `, [tableName]);

    for (const colRow of colRows) {
      columns.add(colRow.column_name);
    }

    tables.set(tableName, columns);
  }

  // Get all indexes
  const { rows: indexRows } = await pool.query(`
    SELECT indexname 
    FROM pg_indexes 
    WHERE schemaname = 'public'
  `);

  for (const row of indexRows) {
    indexes.add(row.indexname);
  }

  return { tables, indexes };
}

/**
 * Compare live schema against expected schema and report differences.
 */
export function compareSchemas(
  expected: { tables: Map<string, Set<string>>; indexes: Set<string> },
  live: { tables: Map<string, Set<string>>; indexes: Set<string> }
): SchemaDifference[] {
  const differences: SchemaDifference[] = [];

  // Check for missing tables
  for (const [tableName, expectedColumns] of expected.tables) {
    if (!live.tables.has(tableName)) {
      differences.push({
        type: 'missing_table',
        table: tableName,
        details: `Table "${tableName}" is missing from the database`
      });
      continue;
    }

    const liveColumns = live.tables.get(tableName)!;

    // Check for missing columns
    for (const column of expectedColumns) {
      if (!liveColumns.has(column)) {
        differences.push({
          type: 'missing_column',
          table: tableName,
          column,
          details: `Column "${column}" is missing from table "${tableName}"`
        });
      }
    }
  }

  // Check for missing indexes
  for (const index of expected.indexes) {
    if (!live.indexes.has(index)) {
      differences.push({
        type: 'missing_index',
        index,
        details: `Index "${index}" is missing from the database`
      });
    }
  }

  return differences;
}

/**
 * Validate database schema and throw if mismatches are found.
 * Exported for use in index.ts startup validation.
 */
export async function validateDatabaseSchema(pool: Pool): Promise<void> {
  const expected = parseExpectedSchema();
  const live = await getLiveSchema(pool);
  const differences = compareSchemas(expected, live);

  if (differences.length > 0) {
    const errorMessages = differences.map(d => d.details).join('; ');
    throw new Error(`Schema validation failed: ${errorMessages}`);
  }
}

async function main(): Promise<void> {
  const failOnMismatch = process.argv.includes('--fail-on-mismatch');

  const pool = createPool(DATABASE_URL);

  try {
    console.log('Validating database schema...');

    const expected = parseExpectedSchema();
    const live = await getLiveSchema(pool);
    const differences = compareSchemas(expected, live);

    if (differences.length === 0) {
      console.log('✓ Schema validation passed: database matches expected schema');
      process.exit(0);
    }

    console.error(`\n✗ Schema validation failed: ${differences.length} difference(s) found\n`);

    for (const diff of differences) {
      console.error(`  ${diff.type.toUpperCase()}: ${diff.details}`);
    }

    console.error('\nRun migrations to bring the database up to date:');
    console.error('  psql $DATABASE_URL -f db/migrations/*.sql');

    if (failOnMismatch) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Schema validation error:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Only run when invoked as a CLI (`ts-node src/validateSchema.ts` or
// `node dist/validateSchema.js`). index.ts imports `validateDatabaseSchema`
// from this module, and running main() on import would connect to the live
// database — and exit the process — in any consumer, including tests.
if (require.main === module) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
