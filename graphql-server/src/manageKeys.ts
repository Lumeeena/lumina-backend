#!/usr/bin/env node
/**
 * CLI for API key management on the Lumina GraphQL server.
 *
 * Keys are hashed using SHA-256 before insertion. Plaintext keys are shown
 * exactly once at creation time and cannot be recovered thereafter.
 *
 * Usage:
 *   manage-keys create <label> [rateLimit]    Generate and store a new API key
 *   manage-keys list                          List all existing API keys
 *   manage-keys show <id|hash>                Display metadata for a key (refuses to show plaintext)
 *   manage-keys revoke <id|hash>              Revoke a key immediately
 *   manage-keys set-limit <id|hash> <limit>   Update a key's rate limit (req/min)
 *
 * Reads DATABASE_URL from environment (default: postgresql://localhost:5432/lumina).
 */
import { Pool } from 'pg';
import {
  createApiKey,
  listApiKeys,
  getApiKey,
  revokeApiKey,
  setApiKeyLimit,
} from './keys';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/lumina';

function usage(): never {
  console.error(
    [
      'Usage:',
      '  manage-keys create <label> [rateLimit]    Create a new API key (default: 60 req/min)',
      '  manage-keys list                          List all API keys',
      '  manage-keys show <id|hash>                Show key metadata (cannot print plaintext key)',
      '  manage-keys revoke <id|hash>              Revoke an API key immediately',
      '  manage-keys set-limit <id|hash> <limit>   Set key rate limit in requests per minute',
    ].join('\n')
  );
  process.exit(1);
}

function formatDate(date: Date | null): string {
  if (!date) return '-';
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

export function parsePositiveInteger(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const num = Number(trimmed);
  if (!Number.isInteger(num) || num <= 0 || !Number.isSafeInteger(num)) return null;
  return num;
}

export async function runCli(args: string[], pool: Pool): Promise<void> {
  const [command, arg1, arg2] = args;
  if (!command) usage();

  switch (command) {
    case 'create': {
      if (!arg1) {
        console.error('Error: "create" requires a label for the API key.');
        usage();
      }
      const label = arg1;
      let rateLimit = 60;
      if (arg2) {
        const parsed = parsePositiveInteger(arg2);
        if (parsed === null) {
          console.error(`Error: Invalid rate limit "${arg2}". Must be a positive integer.`);
          process.exit(1);
        }
        rateLimit = parsed;
      }

      const created = await createApiKey(pool, label, rateLimit);

      console.log('✓ API key created successfully!\n');
      console.log(`  ID:          ${created.id}`);
      console.log(`  Label:       ${created.label}`);
      console.log(`  Rate Limit:  ${created.rateLimit} req/min`);
      console.log(`  Key Prefix:  ${created.keyPrefix}`);
      console.log(`  Created At:  ${formatDate(created.createdAt)}\n`);
      console.log('='.repeat(78));
      console.log('Plaintext API Key:');
      console.log(`  ${created.plaintextKey}\n`);
      console.log('IMPORTANT: Copy this key now! It is stored ONLY as a cryptographic hash');
      console.log('and will NEVER be shown again.');
      console.log('='.repeat(78));
      break;
    }

    case 'list': {
      const keys = await listApiKeys(pool);
      if (keys.length === 0) {
        console.log('No API keys registered in the database.');
        break;
      }

      const headers = [
        'ID'.padEnd(5),
        'PREFIX'.padEnd(16),
        'LABEL'.padEnd(22),
        'LIMIT'.padEnd(10),
        'STATUS'.padEnd(10),
        'CREATED'.padEnd(20),
        'REVOKED',
      ].join(' ');

      console.log(headers);
      console.log('-'.repeat(95));

      for (const k of keys) {
        const status = k.revokedAt ? 'REVOKED' : 'ACTIVE';
        const row = [
          String(k.id).padEnd(5),
          k.keyPrefix.padEnd(16),
          k.label.slice(0, 20).padEnd(22),
          `${k.rateLimit}/min`.padEnd(10),
          status.padEnd(10),
          formatDate(k.createdAt).padEnd(20),
          formatDate(k.revokedAt),
        ].join(' ');
        console.log(row);
      }
      break;
    }

    case 'show': {
      if (!arg1) {
        console.error('Error: "show" requires a key ID or hash.');
        usage();
      }
      const key = await getApiKey(pool, arg1);
      if (!key) {
        console.error(`Error: API key "${arg1}" not found.`);
        process.exit(1);
      }

      const status = key.revokedAt ? 'REVOKED' : 'ACTIVE';
      console.log(`API Key #${key.id} Metadata:`);
      console.log(`  ID:          ${key.id}`);
      console.log(`  Label:       ${key.label}`);
      console.log(`  Status:      ${status}`);
      console.log(`  Rate Limit:  ${key.rateLimit} req/min`);
      console.log(`  Key Prefix:  ${key.keyPrefix}`);
      console.log(`  Key Hash:    ${key.keyHash}`);
      console.log(`  Created At:  ${formatDate(key.createdAt)}`);
      console.log(`  Revoked At:  ${formatDate(key.revokedAt)}`);
      console.log(`  Updated At:  ${formatDate(key.updatedAt)}\n`);
      console.log('[SECURITY NOTICE] Plaintext key cannot be shown: only the SHA-256 hash is stored.');
      break;
    }

    case 'revoke': {
      if (!arg1) {
        console.error('Error: "revoke" requires a key ID or hash.');
        usage();
      }
      const key = await revokeApiKey(pool, arg1);
      console.log(`✓ Revoked API key #${key.id} ("${key.label}"). Requests with this key will now be rejected.`);
      break;
    }

    case 'set-limit': {
      if (!arg1 || !arg2) {
        console.error('Error: "set-limit" requires a key ID/hash and a new limit.');
        usage();
      }
      const parsedLimit = parsePositiveInteger(arg2);
      if (parsedLimit === null) {
        console.error(`Error: Invalid rate limit "${arg2}". Must be a positive integer.`);
        process.exit(1);
      }
      const key = await setApiKeyLimit(pool, arg1, parsedLimit);
      console.log(`✓ Updated rate limit for API key #${key.id} ("${key.label}") to ${key.rateLimit} req/min.`);
      break;
    }

    default:
      usage();
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await runCli(process.argv.slice(2), pool);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
