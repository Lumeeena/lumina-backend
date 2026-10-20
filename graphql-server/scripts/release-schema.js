/**
 * Builds the GraphQL schema release artifacts for one version (issue #267).
 *
 *   node scripts/release-schema.js <tag> <outDir>
 *
 * `<tag>` is the release tag, `v<semver>`. The run fails unless:
 *   - the tag's version is the version every package.json declares, so a
 *     release's schema and the service that serves it carry the same number;
 *   - src/schema.graphql matches the committed snapshot (`schema:check`), so
 *     the published schema is the reviewed one.
 *
 * Writes into `<outDir>`:
 *   schema.graphql             the SDL as in the repository, LF line endings
 *   schema.introspection.json  `{ "__schema": ... }`, for codegen tools that
 *                              read introspection rather than SDL
 *   SHA256SUMS                 checksums of both, `sha256sum -c` format
 *   RELEASE_NOTES.md           the CHANGELOG section for this version, or a
 *                              pointer to the changelog when there is none
 *
 * The release workflow (.github/workflows/release.yml) attaches these to the
 * GitHub release; docs/API_GUIDE.md "API Versioning" says how to fetch them.
 */
const { createHash } = require('crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('fs');
const { join, resolve } = require('path');
const { buildSchema, introspectionFromSchema } = require('graphql');

const ROOT = resolve(__dirname, '..', '..');
const PACKAGES = ['package.json', 'graphql-server/package.json', 'indexer/package.json', 'shared/package.json'];
const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** The version a release tag names, or throw. */
function versionFromTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (!match) throw new Error(`Release tag must look like v1.2.3 (or v1.2.3-rc.1); got "${tag}".`);
  return match[1];
}

/** Throw unless every package declares `version`. */
function assertVersionsMatch(version, declared) {
  const mismatched = Object.entries(declared).filter(([, v]) => v !== version);
  if (mismatched.length) {
    throw new Error(
      `Tag version ${version} does not match ${mismatched.map(([file, v]) => `${file} (${v})`).join(', ')}. ` +
        'Bump every package.json to the release version before tagging; see docs/RELEASING.md.'
    );
  }
}

/** Line endings normalised, so a Windows checkout produces the same bytes as CI. */
function normalise(text) {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/u, '') + '\n';
}

/** The CHANGELOG section for `version` (`## [x.y.z] ...` up to the next `## `), or null. */
function changelogSection(changelog, version) {
  const lines = normalise(changelog).split('\n');
  const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start, end === -1 ? undefined : end).join('\n').trim() + '\n';
}

/** The release files for one schema, as `{ name: contents }`. */
function buildArtifacts(sdl, version, notes) {
  const schemaText = normalise(sdl);
  const schema = buildSchema(schemaText); // throws on an invalid schema
  const introspection = JSON.stringify(introspectionFromSchema(schema, { descriptions: true }), null, 2) + '\n';
  const files = {
    'schema.graphql': schemaText,
    'schema.introspection.json': introspection,
  };
  files.SHA256SUMS = Object.entries(files)
    .map(([name, body]) => `${createHash('sha256').update(body).digest('hex')}  ${name}`)
    .join('\n') + '\n';
  files['RELEASE_NOTES.md'] =
    (notes ?? `Lumina backend v${version}.\n\nSee CHANGELOG.md for changes.\n`) +
    `\nThe GraphQL schema for this version is attached as \`schema.graphql\` (SDL) and ` +
    '`schema.introspection.json`; see docs/API_GUIDE.md "API Versioning".\n';
  return files;
}

function main(argv) {
  const [tag, outDir] = argv;
  if (!tag || !outDir) {
    console.error('Usage: node scripts/release-schema.js <tag> <outDir>');
    process.exit(2);
  }
  const version = versionFromTag(tag);
  const declared = Object.fromEntries(
    PACKAGES.map(file => [file, JSON.parse(readFileSync(join(ROOT, file), 'utf8')).version])
  );
  assertVersionsMatch(version, declared);

  const sdl = readFileSync(join(ROOT, 'graphql-server/src/schema.graphql'), 'utf8');
  const snapshot = readFileSync(join(ROOT, 'graphql-server/src/schema.snapshot.graphql'), 'utf8');
  if (normalise(sdl) !== normalise(snapshot)) {
    throw new Error('src/schema.graphql differs from src/schema.snapshot.graphql; run `npm run schema:check`.');
  }

  const notes = changelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  const files = buildArtifacts(sdl, version, notes);
  mkdirSync(outDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(outDir, name), body);
  console.log(`Schema release artifacts for v${version} written to ${outDir}:`);
  for (const name of Object.keys(files)) console.log(`  ${name}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

module.exports = { versionFromTag, assertVersionsMatch, changelogSection, buildArtifacts, normalise };
