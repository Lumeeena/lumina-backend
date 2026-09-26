import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { removeExpiredObjects, scheduledExportOptions } from './scheduledExport';

test('scheduled exports are disabled unless a destination bucket is configured', () => {
  assert.equal(scheduledExportOptions({} as NodeJS.ProcessEnv), null);
});

test('scheduled export destination, frequency, retention and credentials are configurable', () => {
  const options = scheduledExportOptions({
    S3_EXPORT_BUCKET: 'archive',
    S3_EXPORT_PREFIX: '/prod/daily/',
    S3_EXPORT_INTERVAL_MS: '3600000',
    S3_EXPORT_RETENTION_DAYS: '14',
    S3_ENDPOINT: 'http://minio:9000',
    S3_REGION: 'us-east-2',
    AWS_ACCESS_KEY_ID: 'access',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_SESSION_TOKEN: 'session',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(options, {
    bucket: 'archive', prefix: 'prod/daily', intervalMs: 3_600_000,
    retentionDays: 14, endpoint: 'http://minio:9000', region: 'us-east-2',
    forcePathStyle: true,
    credentials: { accessKeyId: 'access', secretAccessKey: 'secret', sessionToken: 'session' },
  });
});

test('scheduled export configuration rejects invalid interval, retention and half a credential pair', () => {
  assert.throws(() => scheduledExportOptions({ S3_EXPORT_BUCKET: 'bucket', S3_EXPORT_INTERVAL_MS: '1000' } as NodeJS.ProcessEnv), /at least 60000/);
  assert.throws(() => scheduledExportOptions({ S3_EXPORT_BUCKET: 'bucket', S3_EXPORT_RETENTION_DAYS: '0' } as NodeJS.ProcessEnv), /positive integer/);
  assert.throws(() => scheduledExportOptions({ S3_EXPORT_BUCKET: 'bucket', AWS_ACCESS_KEY_ID: 'only-one' } as NodeJS.ProcessEnv), /Set both/);
});

test('retention deletes only expired Lumina exports under the configured prefix', async () => {
  const deleted: string[] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) return { Contents: [
        { Key: 'prod/lumina-old.ndjson', LastModified: new Date(0) },
        { Key: 'prod/lumina-new.ndjson', LastModified: new Date(99_000_000) },
        { Key: 'prod/other-old.ndjson', LastModified: new Date(0) },
      ] };
      if (command instanceof DeleteObjectCommand) { deleted.push(command.input.Key!); return {}; }
      throw new Error('unexpected S3 command');
    },
  } as unknown as S3Client;
  await removeExpiredObjects(client, {
    bucket: 'archive', prefix: 'prod', intervalMs: 60_000, retentionDays: 1,
    region: 'us-east-1', forcePathStyle: true,
  }, 100_000_000);
  assert.deepEqual(deleted, ['prod/lumina-old.ndjson']);
});
