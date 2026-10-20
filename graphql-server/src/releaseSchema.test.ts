import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildClientSchema, buildSchema, printSchema } from 'graphql';

// eslint-disable-next-line @typescript-eslint/no-var-requires -- the script is plain CommonJS, like check-schema-snapshot.js
const release = require('../scripts/release-schema') as {
  versionFromTag(tag: string): string;
  assertVersionsMatch(version: string, declared: Record<string, string>): void;
  changelogSection(changelog: string, version: string): string | null;
  buildArtifacts(sdl: string, version: string, notes: string | null): Record<string, string>;
};

const SCRIPT = resolve(__dirname, '..', 'scripts', 'release-schema.js');
const SDL = readFileSync(resolve(__dirname, 'schema.graphql'), 'utf8');
const VERSION = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')).version as string;

test('a release tag is v + semver', () => {
  assert.equal(release.versionFromTag('v1.2.3'), '1.2.3');
  assert.equal(release.versionFromTag('v1.2.3-rc.1'), '1.2.3-rc.1');
  for (const bad of ['1.2.3', 'v1.2', 'release-1.2.3', 'v1.2.3+build']) {
    assert.throws(() => release.versionFromTag(bad), /must look like v1\.2\.3/, bad);
  }
});

test('the tag must match every package version', () => {
  assert.doesNotThrow(() => release.assertVersionsMatch('1.2.3', { 'package.json': '1.2.3', 'indexer/package.json': '1.2.3' }));
  assert.throws(
    () => release.assertVersionsMatch('1.2.3', { 'package.json': '1.2.3', 'indexer/package.json': '1.2.2' }),
    /does not match indexer\/package\.json \(1\.2\.2\)/
  );
});

test('release notes come from the matching CHANGELOG section', () => {
  const changelog = '# Changelog\r\n\r\n## [Unreleased]\r\n- next\r\n\r\n## [1.2.0] - 2026-10-01\r\n### Added\r\n- thing\r\n\r\n## [1.1.0] - 2026-09-01\r\n- older\r\n';
  assert.equal(release.changelogSection(changelog, '1.2.0'), '## [1.2.0] - 2026-10-01\n### Added\n- thing\n');
  assert.equal(release.changelogSection(changelog, '1.1.0'), '## [1.1.0] - 2026-09-01\n- older\n');
  assert.equal(release.changelogSection(changelog, '9.9.9'), null);
});

test('artifacts: SDL, introspection of the same schema, valid checksums', () => {
  const files = release.buildArtifacts(SDL, '1.2.3', null);
  assert.deepEqual(Object.keys(files).sort(), ['RELEASE_NOTES.md', 'SHA256SUMS', 'schema.graphql', 'schema.introspection.json']);

  const fromSdl = buildSchema(files['schema.graphql']!);
  const fromIntrospection = buildClientSchema(JSON.parse(files['schema.introspection.json']!));
  assert.equal(printSchema(fromIntrospection), printSchema(fromSdl));
  // Descriptions travel with the introspection, so generated clients keep their docs.
  assert.ok(fromIntrospection.getQueryType()?.getFields()['transactions']?.description);

  for (const line of files['SHA256SUMS']!.trim().split('\n')) {
    const [sum, name] = line.split(/\s+/);
    assert.equal(createHash('sha256').update(files[name!]!).digest('hex'), sum, name);
  }
  assert.match(files['RELEASE_NOTES.md']!, /Lumina backend v1\.2\.3/);
});

test('a CRLF checkout publishes the same bytes as an LF one', () => {
  const lf = SDL.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual(release.buildArtifacts(crlf, '1.2.3', null), release.buildArtifacts(lf, '1.2.3', null));
  assert.doesNotMatch(release.buildArtifacts(crlf, '1.2.3', null)['schema.graphql']!, /\r/);
});

test('an invalid schema is not published', () => {
  assert.throws(() => release.buildArtifacts('type Query { broken: NoSuchType }', '1.2.3', null));
});

test('CLI: writes the artifacts for the current version, refuses a mismatched tag', () => {
  const out = mkdtempSync(join(tmpdir(), 'lumina-schema-release-'));
  try {
    execFileSync(process.execPath, [SCRIPT, `v${VERSION}`, out], { encoding: 'utf8' });
    assert.equal(
      readFileSync(join(out, 'schema.graphql'), 'utf8'),
      SDL.replace(/\r\n/g, '\n').replace(/\s+$/u, '') + '\n'
    );

    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, 'v99.0.0', join(out, 'x')], { encoding: 'utf8', stdio: 'pipe' }),
      (err: { status: number; stderr: string }) => err.status === 1 && /does not match/.test(err.stderr)
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
