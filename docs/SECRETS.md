# Secrets and credentials

Database credentials come from an environment variable by default: `DATABASE_URL`
for the indexer and the GraphQL server, `BACKUP_DATABASE_URL` for the backup job.
This document explains why every one of those also accepts a file, how to wire
that up, and why a file is the production recommendation.

## Why not just the environment variable

An environment variable is the easiest place to put a connection string and the
worst place to keep one. Once it is set, the value is copied into every child
process the service spawns, it is readable from `/proc/<pid>/environ`, it is
printed by `docker inspect` and `kubectl describe pod`, and it is the first thing
a crash reporter or a debug dump serialises. The GraphQL server used to log the
full database URL at startup — password included — which is exactly the kind of
exposure this is about.

A file mounted from a secret store has none of those exits. It is not in the
process environment, it is not in `docker inspect`, and a crash dump that
serialises the environment does not contain it.

## The convention: `NAME` or `NAME_FILE`, never both

Every secret-bearing variable `NAME` also accepts `NAME_FILE` — a path whose
contents are the value. This is the same convention the official Postgres image
uses for `POSTGRES_PASSWORD_FILE`, and it is the shape every secret delivery
mechanism already produces: Docker and Compose secrets
(`/run/secrets/*`), a Kubernetes Secret volume, the Secrets Store CSI driver
(AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, Vault) and the Vault
Agent injector all write files. Supporting files rather than one vendor SDK is
what lets any of them work without this project depending on any of them.

Setting both `NAME` and `NAME_FILE` is an error rather than a precedence rule: a
deployment that sets both has two answers to one question, and silently picking
one is how a rotated credential keeps being ignored.

| Deployment            | Variable                | File variable                |
| --------------------- | ----------------------- | ---------------------------- |
| Indexer, GraphQL      | `DATABASE_URL`          | `DATABASE_URL_FILE`          |
| GraphQL (read replica) | `READ_DATABASE_URL`    | `READ_DATABASE_URL_FILE`     |
| Backup job            | `BACKUP_DATABASE_URL`   | `BACKUP_DATABASE_URL_FILE`   |

## Splitting the password out: `DATABASE_PASSWORD_FILE`

Often a secret manager rotates the password and the password only; the host,
port, database and user are ordinary configuration where they can be reviewed
and diffed. For that case each URL family also accepts a password file:

| URL variable           | Password file variable          |
| ---------------------- | ------------------------------- |
| `DATABASE_URL`         | `DATABASE_PASSWORD_FILE`        |
| `READ_DATABASE_URL`    | `READ_DATABASE_PASSWORD_FILE`   |
| `BACKUP_DATABASE_URL`  | `BACKUP_DATABASE_PASSWORD_FILE` |

When the password file is set, its contents replace any password already in the
URL:

```yaml
# The URL stays in ordinary configuration; only the password is a secret.
DATABASE_URL: postgresql://lumina_indexer@postgres:5432/lumina
DATABASE_PASSWORD_FILE: /var/run/secrets/lumina/database/password
```

A password file without a URL is an error, and so is a `NAME_FILE` that does not
exist, cannot be read, or is empty. All three are startup failures, reported by
variable name and path — never with the secret itself:

```
invalid database configuration: DATABASE_PASSWORD_FILE is set but DATABASE_URL is not a postgresql:// URL
```

## Resolution order

`resolveDatabaseUrl` in `shared/src/secrets.ts` resolves a Postgres connection
string from up to three sources:

1. `DATABASE_URL_FILE` — a file holding the whole URL, or
2. `DATABASE_URL` — the URL itself (the original, still-supported form), plus
3. `DATABASE_PASSWORD_FILE` — a file holding only the password, which replaces
   any password in the URL.

The plain variable keeps working unchanged, so existing deployments need no
migration. Each caller keeps its own default when nothing is configured —
`postgresql://localhost:5432/lumina` for the services — so an unset URL is not
an error, it is the local default.

The backup job's `db/backup/lumina-backup.sh` implements the same `NAME` /
`NAME_FILE` contract in shell, and hands a password file to libpq through a
private `pgpass` file rather than through `PGPASSWORD` or the URL — either of
which would put it back in the process environment or argument list the file
form exists to keep it out of.

## Wiring a secret store

Because the contract is "a file with the value", every store below works without
configuration here:

### Kubernetes Secret volume

```yaml
volumes:
  - name: database-credentials
    secret:
      secretName: lumina-indexer-db
      items:
        - key: password
          path: password
containers:
  - name: indexer
    volumeMounts:
      - name: database-credentials
        mountPath: /var/run/secrets/lumina/database
        readOnly: true
    env:
      - name: DATABASE_PASSWORD_FILE
        value: /var/run/secrets/lumina/database/password
```

`deploy/kubernetes/base/` does exactly this. The base contains no Secret
objects: the credentials come from whatever mechanism the cluster already uses.

### External Secrets Operator

`ExternalSecret` copies a value from AWS Secrets Manager, GCP Secret Manager,
Azure Key Vault or Vault into a Kubernetes Secret; mount that Secret as above.
Prefer a namespaced `SecretStore` with its own cloud role over a
`ClusterSecretStore` so one team's configuration cannot read another team's
secrets.

### Secrets Store CSI Driver

The CSI driver mounts the external value straight into the pod as a file,
keeping it out of `etcd` entirely. A `SecretProviderClass` names the object; the
pod mounts the CSI volume and reads the file, no `DATABASE_URL_FILE` change
needed beyond pointing it at the mount path.

### Vault Agent Injector

The injector renders Vault values into an in-memory volume and renews the lease.
The application reads the rendered file.

### Docker / Compose

```yaml
services:
  indexer:
    environment:
      DATABASE_URL_FILE: /run/secrets/database_url
    secrets:
      - database_url
secrets:
  database_url:
    file: ./secrets/database_url
```

## Rotation

A rotation is complete only when the running process uses the new value. Note
what each delivery mechanism does and does not do:

- A mounted Secret volume is rewritten in place by the kubelet after its sync
  delay. A file delivered by `subPath` is never updated, and the CSI driver and
  external-secrets operators do not restart pods on their own.
- An environment variable keeps its value for the life of the process.

So either the process re-reads the file on change (both services read it once at
startup), or the workload is rolled when the secret changes. On Kubernetes that
is a rolling restart — `kubectl rollout restart` (StatefulSet for the indexer,
Deployment for the GraphQL server) — or a controller such as Stakater Reloader
that watches the Secret and rolls the workload for you. Keep the old credential
valid until the slowest consumer has moved.

## What is not a secret

To keep the distinction clear:

- The database **host, port, database name and role name** are not secrets.
  They belong in a ConfigMap or the compose file where they can be reviewed.
- The **password** is the secret, and it belongs in a file, not the environment.
- An object-storage bucket name and region are not secrets; the identity that
  reaches them is, and a workload identity (IRSA, GKE Workload Identity, Azure
  Workload Identity) is better than a key because there is nothing to leak. The
  backup and export paths use the SDK credential chain for exactly this reason —
  see `docs/BACKUPS.md` and the ServiceAccount comments under `deploy/`.
