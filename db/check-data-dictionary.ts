import { readFileSync } from 'fs';
import { join } from 'path';

interface TableSchema {
  name: string;
  columns: string[];
}

function parseSchemaSql(schemaSql: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  
  // Match top-level CREATE TABLE blocks
  // e.g. CREATE TABLE IF NOT EXISTS table_name ( ... );
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\n\);/gi;
  let match: RegExpExecArray | null;

  while ((match = tableRegex.exec(schemaSql)) !== null) {
    const tableName = match[1].toLowerCase();
    const body = match[2];

    const columns: string[] = [];
    const lines = body.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--')) continue;

      const upper = line.toUpperCase();
      if (
        upper.startsWith('PRIMARY KEY') ||
        upper.startsWith('FOREIGN KEY') ||
        upper.startsWith('CONSTRAINT') ||
        upper.startsWith('UNIQUE') ||
        upper.startsWith('CHECK')
      ) {
        continue;
      }

      // Column definition starts with identifier followed by type
      const colMatch = line.match(/^([a-zA-Z0-9_]+)\s+/);
      if (colMatch) {
        const colName = colMatch[1].toLowerCase();
        // Guard against any leftover SQL keywords
        if (!['primary', 'foreign', 'constraint', 'check', 'unique'].includes(colName)) {
          columns.push(colName);
        }
      }
    }

    if (columns.length > 0) {
      tables.set(tableName, columns);
    }
  }

  return tables;
}

function parseDataDictionary(docMarkdown: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  
  // Split markdown by table sections: "### [0-9]+. `<table_name>`"
  const sections = docMarkdown.split(/###\s+\d+\.\s+`([a-zA-Z0-9_]+)`/g);
  
  for (let i = 1; i < sections.length; i += 2) {
    const tableName = sections[i].toLowerCase();
    const sectionBody = sections[i + 1];

    const columns = new Set<string>();
    // Columns are defined in markdown table rows like: | `column_name` | Type | ...
    const rowRegex = /\|\s*`([a-zA-Z0-9_]+)`\s*\|/g;
    let colMatch: RegExpExecArray | null;
    while ((colMatch = rowRegex.exec(sectionBody)) !== null) {
      columns.add(colMatch[1].toLowerCase());
    }

    tables.set(tableName, columns);
  }

  return tables;
}

export function checkDrift(): { success: boolean; errors: string[] } {
  const rootDir = process.cwd();
  const schemaPath = join(rootDir, 'db/schema.sql');
  const dictPath = join(rootDir, 'docs/DATA_DICTIONARY.md');

  const schemaSql = readFileSync(schemaPath, 'utf-8');
  const dictMd = readFileSync(dictPath, 'utf-8');

  const schemaTables = parseSchemaSql(schemaSql);
  const dictTables = parseDataDictionary(dictMd);

  const errors: string[] = [];

  for (const [table, expectedColumns] of schemaTables.entries()) {
    const docColumns = dictTables.get(table);
    if (!docColumns) {
      errors.push(`Table '${table}' exists in db/schema.sql but is missing from docs/DATA_DICTIONARY.md`);
      continue;
    }

    for (const col of expectedColumns) {
      if (!docColumns.has(col)) {
        errors.push(`Column '${table}.${col}' in db/schema.sql is missing from docs/DATA_DICTIONARY.md`);
      }
    }
  }

  // Check for tables in dictionary that do not exist in schema.sql
  for (const table of dictTables.keys()) {
    if (!schemaTables.has(table)) {
      errors.push(`Table '${table}' is in docs/DATA_DICTIONARY.md but does not exist in db/schema.sql`);
    }
  }

  return {
    success: errors.length === 0,
    errors,
  };
}

const result = checkDrift();
if (!result.success) {
  console.error('❌ Data Dictionary Drift Detected:');
  for (const err of result.errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
} else {
  console.log('✅ Data Dictionary is in 100% sync with db/schema.sql (all tables and columns verified).');
}
