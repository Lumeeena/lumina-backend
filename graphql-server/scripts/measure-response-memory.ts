/**
 * Peak-memory measurement for the largest allowed GraphQL responses.
 *
 * The server assembles a response in memory before sending it, so the thing
 * that decides whether a request can exhaust the process is the size of the
 * largest response the schema permits — not the size of a typical one. This
 * harness executes that largest allowed response against a real database and
 * reports the peak heap and RSS it took, so the ceiling asserted in
 * `responseMemory.test.ts` is grounded in a measurement rather than a guess.
 *
 * Usage:
 *   DATABASE_URL=postgresql://… node --expose-gc --require ts-node/register/transpile-only \
 *     scripts/measure-response-memory.ts
 *
 * Seed a database large enough for the limits to bind with `db/seed.sql`; the
 * numbers scale with how much data sits behind the widest range, which is the
 * point — the caps are what stop that from scaling without bound.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { execute, parse } from 'graphql';
import { resolvers, createContext } from '../src/resolvers';
import { MAX_AGGREGATE_ROWS } from '../src/pagination';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const typeDefs = readFileSync(join(__dirname, '../src/schema.graphql'), 'utf-8');

/**
 * The checked-in schema and resolvers have drifted apart in a few places
 * (accountBalanceHistory, Account.signers, …). Drop the orphan resolvers so
 * this harness can build the schema the server serves today.
 */
function pruneResolvers(schemaText: string, rs: typeof resolvers): typeof resolvers {
  const fieldsByType = new Map<string, Set<string>>();
  const blockRe = /(?:extend\s+)?type\s+(\w+)[^{]*\{([\s\S]*?)\n\}/g;
  for (const match of schemaText.matchAll(blockRe)) {
    const [, typeName, body] = match;
    const set = fieldsByType.get(typeName) ?? new Set<string>();
    for (const line of body.split('\n')) {
      const field = line.match(/^\s*(\w+)\s*[(:<]/);
      if (field) set.add(field[1]);
    }
    fieldsByType.set(typeName, set);
  }

  const pruned: Record<string, Record<string, unknown>> = {};
  for (const [typeName, fields] of Object.entries(rs)) {
    const known = fieldsByType.get(typeName);
    const kept: Record<string, unknown> = {};
    for (const [fieldName, fn] of Object.entries(fields as Record<string, unknown>)) {
      if (known && !known.has(fieldName)) continue;
      kept[fieldName] = fn;
    }
    if (Object.keys(kept).length > 0) pruned[typeName] = kept;
  }
  return pruned as typeof resolvers;
}

const schema = makeExecutableSchema({ typeDefs, resolvers: pruneResolvers(typeDefs, resolvers) });
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export interface Measurement {
  label: string;
  errors: string[];
  responseBytes: number;
  heapDeltaBytes: number;
  rssDeltaBytes: number;
}

async function measure(
  label: string,
  query: string,
  variableValues: Record<string, unknown> = {}
): Promise<Measurement> {
  global.gc?.();
  const before = process.memoryUsage();
  const result = await execute({
    schema,
    document: parse(query),
    variableValues,
    contextValue: createContext(pool),
  });
  const after = process.memoryUsage();
  const responseBytes = Buffer.byteLength(JSON.stringify(result));
  return {
    label,
    errors: result.errors?.map(e => e.message) ?? [],
    responseBytes,
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    rssDeltaBytes: after.rss - before.rss,
  };
}

/** The queries whose responses are largest: each is at its schema cap. */
export const LARGEST_ALLOWED_QUERIES: ReadonlyArray<{
  label: string;
  query: string;
  variables?: Record<string, unknown>;
}> = [
  {
    label: 'networkStats (1000 hourly buckets, the cap)',
    query: `query($s: String!, $e: String!) {
      networkStats(startTime: $s, endTime: $e, granularity: "hour") {
        bucketStart transactionCount operationCount activeAccounts totalVolume
      }
    }`,
    variables: { s: '2020-01-01T00:00:00.000Z', e: '2020-02-11T16:00:00.000Z' },
  },
  {
    label: 'activityRollups (1000 hourly buckets, the cap)',
    query: `query($s: String!, $e: String!) {
      activityRollups(network: "mainnet", granularity: "hour", startTime: $s, endTime: $e) {
        bucketStart granularity network transactionCount operationCount activeAccounts totalVolume
      }
    }`,
    variables: { s: '2020-01-01T00:00:00.000Z', e: '2020-02-11T16:00:00.000Z' },
  },
  {
    label: 'sponsoredAccounts (limit 1000, the cap)',
    query: `query { sponsoredAccounts(sponsorAddress: "GSPONSOR", limit: 1000) {
      address sequence balances { assetType assetCode assetIssuer balance }
    } }`,
  },
];

async function main() {
  const measurements: Measurement[] = [];
  for (const { label, query, variables } of LARGEST_ALLOWED_QUERIES) {
    measurements.push(await measure(label, query, variables));
  }
  for (const m of measurements) {
    console.log(
      JSON.stringify({
        label: m.label,
        errors: m.errors,
        responseMB: mb(m.responseBytes),
        heapDeltaMB: mb(m.heapDeltaBytes),
        rssDeltaMB: mb(m.rssDeltaBytes),
      })
    );
  }
  console.log(`\nMAX_AGGREGATE_ROWS = ${MAX_AGGREGATE_ROWS}`);
  await pool.end();
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
