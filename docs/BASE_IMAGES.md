# Base image pins

All container images are pinned as `tag@digest` (`.github/workflows/ci.yml`,
`docker/docker-compose.yml`, `docker/Dockerfile.indexer`,
`docker/Dockerfile.graphql`). A tag is mutable — two builds of the same
commit could otherwise pull different base layers, and a compromised upstream
tag would reach production silently. The digest makes the base layer
content-addressed: same commit, same bytes.

## Pinned images

| Image | Used in |
|---|---|
| `node:20-alpine@sha256:…` | `docker/Dockerfile.indexer`, `docker/Dockerfile.graphql` (both stages) |
| `postgres:16-alpine@sha256:…` | `docker/docker-compose.yml`, every `services.postgres.image` block in `.github/workflows/ci.yml` |
| `prom/prometheus:v2.54.1@sha256:…` | `docker/docker-compose.yml` (observability profile) |
| `grafana/grafana:11.2.0@sha256:…` | `docker/docker-compose.yml` (observability profile) |

## Update process

1. Resolve the new digest for the tag:
   ```bash
   docker buildx imagetools inspect <tag> \
     --format 'Digest: {{.Manifest.Digest}} MediaType: {{.Manifest.MediaType}}'
   ```
2. Confirm `MediaType` is a manifest **list/index**
   (`application/vnd.oci.image.index.v1+json` or
   `application/vnd.docker.distribution.manifest.list.v2+json`) — pin the
   root list digest, never a platform-specific (`linux/amd64`, `linux/arm64`)
   child, or builds break on the other architecture (x86_64 CI vs ARM dev
   machines).
3. Replace the old digest after the same tag in every file in the table
   above, keeping the tag prefix for readability. The postgres digest must
   match in compose **and** all CI service blocks.
4. Verify:
   ```bash
   docker compose -f docker/docker-compose.yml config > /dev/null
   docker build -f docker/Dockerfile.indexer .
   docker build -f docker/Dockerfile.graphql .
   ```

## Automation

`.github/dependabot.yml` enables the `docker` ecosystem, so Dependabot opens
weekly PRs bumping these digests. Dependabot covers Dockerfiles and compose
files only — after merging its PR, mirror the new postgres digest into the
`services.postgres.image` blocks in `.github/workflows/ci.yml` by hand.
