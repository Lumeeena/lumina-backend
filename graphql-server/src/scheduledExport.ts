import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import type { Pool } from 'pg';
import { exportRunDuration, exportRuns } from './metrics';
import { subsystem } from './logger';

const log = subsystem('scheduled-export');
const EXPORT_TABLES = [
  ['ledgers', 'sequence'], ['transactions', 'hash'], ['operations', 'id'],
  ['accounts', 'address'], ['contract_events', 'id'], ['contract_schemas', 'contract_id'],
  ['custom_events', 'event_id, event_name'],
] as const;
const BATCH_SIZE = 500;

async function* exportLines(pool: Pool): AsyncGenerator<string> {
  for (const [table, order] of EXPORT_TABLES) {
    let offset = 0;
    while (true) {
      const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY ${order} LIMIT $1 OFFSET $2`, [BATCH_SIZE, offset]);
      for (const record of rows) yield `${JSON.stringify({ table, record })}\n`;
      if (rows.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }
  }
}

export interface ScheduledExportOptions {
  bucket: string;
  prefix: string;
  intervalMs: number;
  retentionDays: number;
  endpoint?: string;
  region: string;
  forcePathStyle: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

export function scheduledExportOptions(env = process.env): ScheduledExportOptions | null {
  const bucket = env['S3_EXPORT_BUCKET']?.trim();
  if (!bucket) return null;
  const intervalMs = Number(env['S3_EXPORT_INTERVAL_MS'] ?? 86_400_000);
  const retentionDays = Number(env['S3_EXPORT_RETENTION_DAYS'] ?? 30);
  if (Boolean(env['AWS_ACCESS_KEY_ID']) !== Boolean(env['AWS_SECRET_ACCESS_KEY'])) {
    throw new Error('Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for static S3 credentials');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw new Error('S3_EXPORT_INTERVAL_MS must be an integer of at least 60000');
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new Error('S3_EXPORT_RETENTION_DAYS must be a positive integer');
  return {
    bucket,
    prefix: (env['S3_EXPORT_PREFIX'] ?? 'lumina/exports').replace(/^\/+|\/+$/g, ''),
    intervalMs,
    retentionDays,
    ...(env['S3_ENDPOINT'] ? { endpoint: env['S3_ENDPOINT'] } : {}),
    region: env['S3_REGION'] ?? 'us-east-1',
    forcePathStyle: env['S3_FORCE_PATH_STYLE'] !== 'false',
    ...(env['AWS_ACCESS_KEY_ID'] && env['AWS_SECRET_ACCESS_KEY'] ? { credentials: {
      accessKeyId: env['AWS_ACCESS_KEY_ID'],
      secretAccessKey: env['AWS_SECRET_ACCESS_KEY'],
      ...(env['AWS_SESSION_TOKEN'] ? { sessionToken: env['AWS_SESSION_TOKEN'] } : {}),
    } } : {}),
  };
}

export function startScheduledExports(
  pool: Pool,
  options: ScheduledExportOptions,
  client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    forcePathStyle: options.forcePathStyle,
    ...(options.credentials ? { credentials: options.credentials } : {}),
  })
): () => Promise<void> {
  let activeRun: Promise<void> | null = null;
  const run = async () => {
    if (activeRun) return activeRun;
    const stopTimer = exportRunDuration.startTimer();
    activeRun = (async () => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const key = `${options.prefix ? `${options.prefix}/` : ''}lumina-${timestamp}-${randomUUID()}.ndjson`;
        await new Upload({
          client,
          params: {
            Bucket: options.bucket,
            Key: key,
            Body: Readable.from(exportLines(pool)),
            ContentType: 'application/x-ndjson',
            ServerSideEncryption: 'AES256',
          },
        }).done();
        await removeExpiredObjects(client, options, Date.now());
        exportRuns.inc({ outcome: 'success' });
        log.info({ bucket: options.bucket, key }, 'scheduled database export completed');
      } catch (error) {
        exportRuns.inc({ outcome: 'failure' });
        log.error({ err: error instanceof Error ? error.message : String(error) }, 'scheduled database export failed');
      } finally {
        stopTimer();
        activeRun = null;
      }
    })();
    return activeRun;
  };
  const timer = setInterval(() => { void run(); }, options.intervalMs);
  timer.unref();
  void run();
  return async () => {
    clearInterval(timer);
    if (activeRun) await activeRun;
    client.destroy();
  };
}

export async function removeExpiredObjects(client: S3Client, options: ScheduledExportOptions, now: number): Promise<void> {
  const prefix = options.prefix ? `${options.prefix}/` : '';
  const cutoff = now - options.retentionDays * 24 * 60 * 60 * 1000;
  let continuationToken: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: options.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents ?? []) {
      if (object.Key?.startsWith(`${prefix}lumina-`) && object.LastModified && object.LastModified.getTime() < cutoff) {
        await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: object.Key }));
      }
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
}
