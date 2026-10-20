# Releasing

A release is a `vX.Y.Z` tag. Pushing it runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which
creates the GitHub release and attaches the GraphQL schema that version serves
(`schema.graphql`, `schema.introspection.json`, `SHA256SUMS`). Consumers fetch
it as described in [API_GUIDE.md](API_GUIDE.md#api-versioning).

## Choosing the version

Follow the policy at the top of [CHANGELOG.md](../CHANGELOG.md). The schema
decides it: `npm run schema:check` in `graphql-server` lists breaking changes
against the previous snapshot.

- Breaking schema change: major.
- New fields, queries, subscriptions: minor.
- No schema change: patch.

## Steps

1. **Bump every package to the version.** The release fails unless the tag
   matches all four, so the schema a release carries and the version the
   server reports (`GET /health`) are the same number:
   `package.json`, `graphql-server/package.json`, `indexer/package.json`,
   `shared/package.json`.

   ```bash
   npm version 1.2.3 --no-git-tag-version --workspaces --include-workspace-root
   ```

   This also updates `package-lock.json` and `indexer/package-lock.json`;
   commit them with the bump.

2. **Move the changelog entries.** Rename `## [Unreleased]` to
   `## [1.2.3] - YYYY-MM-DD` and open a new empty `## [Unreleased]` above it.
   That section becomes the release notes.

3. **Merge** the bump through a pull request as usual, so CI has passed on the
   commit being released.

4. **Tag the merged commit and push the tag:**

   ```bash
   git checkout main && git pull
   git tag -a v1.2.3 -m "v1.2.3"
   git push origin v1.2.3
   ```

   A prerelease tag (`v1.3.0-rc.1`) is published as a GitHub prerelease.

## What the workflow checks

Before anything is published, at the tagged commit:

- `npm run schema:check`: `schema.graphql` matches the committed snapshot.
- `npm run schema:release -- <tag> <dir>`
  ([`graphql-server/scripts/release-schema.js`](../graphql-server/scripts/release-schema.js)):
  the tag is `v` + semver, every package declares that version, and the
  schema parses. It then writes the assets and takes the release notes from
  the version's CHANGELOG section.

If a check fails, nothing is published. Fix the cause on `main`, delete the
tag (`git push --delete origin v1.2.3 && git tag -d v1.2.3`), and tag the
fixed commit.

## Re-publishing

Run the workflow by hand (Actions, "Release", "Run workflow") with an existing
tag to rebuild its assets. When the release already exists, only its schema
assets are replaced; the notes are left alone.

To check the artifacts locally before tagging:

```bash
cd graphql-server
npm run schema:release -- v1.2.3 /tmp/schema-release
```
