# Running Lumina on Kubernetes

`deploy/kubernetes/` holds the production shape of the stack: an indexer
StatefulSet, a GraphQL Deployment, the Services and configuration around them,
and the backup CronJobs. It is a kustomize base with overlays for the parts that
differ per cluster.

```
deploy/kubernetes/
  base/                    the workloads, identical everywhere
    indexer/               StatefulSet, Service, ConfigMap, ServiceAccount
    graphql/               Deployment, Service, ConfigMap, ServiceAccount, PDB
    backup/                CronJobs, ConfigMap, ServiceAccount
    policy/                the admission policy that pins the indexer at one
    networkpolicy.yaml
    namespace.yaml
  overlays/
    <yours>/               image registry, ingress, secret store, storage class
```

There is deliberately no overlay committed beyond the base: an Ingress, a
StorageClass and a secret store are the three things that are different on every
cluster, and a checked-in guess at them would be wrong for everyone.

## Applying it

```sh
kubectl apply -k deploy/kubernetes/overlays/<yours>
```

An overlay does at least these three things:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
# 1. Point the images at a registry and pin them.
images:
  - name: lumina-indexer
    newName: ghcr.io/<org>/lumina-indexer
    digest: sha256:…
  - name: lumina-graphql
    newName: ghcr.io/<org>/lumina-graphql
    digest: sha256:…
  - name: lumina-backup
    newName: ghcr.io/<org>/lumina-backup
    digest: sha256:…
# 2. Supply credentials. See docs/SECRETS.md.
```

The base itself contains no `Secret` objects and no database. Credentials come
from whatever the cluster already uses — a Kubernetes Secret, the External
Secrets Operator, the Secrets Store CSI driver, the Vault Agent Injector — all
of which produce a file, which is what the workloads read. PostgreSQL is
expected to be a managed or separately operated service; only the compose setup
runs one in-cluster.

## The indexer is a single writer

This is the part of the deployment that is not negotiable, so it is worth
stating why before stating how.

Each polling loop keeps its cursor in memory and walks ledgers in order. Two
indexers against one database would each walk the same ledgers, double the
Horizon request rate against a per-IP limit the system is already paced for,
race each other's account refreshes and retention prunes, and emit every
`NOTIFY` twice. The inserts survive that only because they are idempotent;
nothing else in the design is. See `docs/INDEXER_CONTROL_FLOW.md` and
`docs/INDEXING_GUARANTEES.md` for the full account.

`replicas: 1` is a default, not a guarantee: `kubectl scale`, an autoscaler or a
well-meaning edit changes it without anyone reading the comment that explains
why it must not. Three layers hold it at one, from weakest to strongest:

1. **A StatefulSet, not a Deployment.** A Deployment's ReplicaSet creates a
   replacement as soon as a pod starts terminating — even with the `Recreate`
   strategy — so for a moment there are two. The Kubernetes documentation points
   to a StatefulSet for an "at most one" guarantee: `lumina-indexer-0` is not
   recreated until the old `lumina-indexer-0` is gone.
2. **`replicas: 1` in the manifest, and no HorizontalPodAutoscaler anywhere.**
   The headless Service and the StatefulSet's identity work the same at one
   replica as at three.
3. **A `ValidatingAdmissionPolicy`** (`base/policy/indexer-single-replica.yaml`)
   that rejects any request setting `replicas` above 1 — `kubectl scale`, an
   edited manifest, an autoscaler — at the API server, through both the
   StatefulSet and its `/scale` subresource. `ValidatingAdmissionPolicy` is
   built in and GA since Kubernetes 1.30, so no webhook or extra controller is
   involved. Applying it is cluster-scoped and needs cluster-admin; it matches
   the StatefulSet by name, so a `namePrefix` in an overlay must be reflected in
   the policy's expression.

There is deliberately **no PodDisruptionBudget for the indexer**. With exactly
one replica, any budget that protects it (`minAvailable: 1`) blocks every drain
of its node forever. A brief indexer restart costs nothing but a short catch-up,
which is the trade the single-writer design already makes. The GraphQL server,
being stateless and read-only, scales horizontally and does get a
PodDisruptionBudget.

## Probes

The two services have different failure modes and so different probes. Both
distinguish **liveness** (is this process wedged?) from **readiness** (should
this replica take work?).

### GraphQL server

- `startupProbe` / `livenessProbe` → `/live`, which answers whenever the process
  is serving HTTP and checks nothing else.
- `readinessProbe` → `/health`, which runs a real query.

A replica that cannot reach Postgres leaves the Service's endpoints rather than
being restarted. Restarting every replica during a database outage repairs
nothing and stampedes the database with reconnects when it returns.

### Indexer

- `startupProbe` → `/live`. `VALIDATE_SCHEMA_ON_STARTUP` runs before the HTTP
  server is up, so the failure threshold is generous (five minutes).
- `livenessProbe` → `/live`, which fails only when the loop has stopped making
  progress: no ledger indexed within `HEALTH_MAX_SECONDS_SINCE_INDEX`, or none
  ever within `HEALTH_START_TOLERANCE_SECONDS`. It ignores lag and the database
  on purpose: after a restore the indexer is legitimately far behind while it
  catches up, and a lag-based liveness probe would restart it in a loop and
  throw that catch-up away.
- `readinessProbe` → `/ready`, the strict check (database reachable, lag within
  `HEALTH_MAX_LAG_LEDGERS`). Nothing routes traffic to the indexer, so "ready"
  here reads as "caught up" in `kubectl get`.

The headless indexer Service sets `publishNotReadyAddresses: true`, so an
indexer that is unready because it is catching up is still discoverable by
Prometheus — which is exactly when its metrics matter most.

## Resources and scheduling

Requests and limits are sized from the services' steady state against mainnet
with one network and public Horizon pacing. The memory limit is not arbitrary
where `NODE_OPTIONS=--max-old-space-size=…` is set: the V8 heap ceiling is
chosen below the container limit so memory pressure surfaces as garbage
collection rather than an OOM kill.

| Workload        | CPU request | CPU limit | Memory request | Memory limit |
| --------------- | ----------- | --------- | -------------- | ------------ |
| indexer         | 100m        | 1         | 256Mi          | 512Mi        |
| graphql         | 250m        | 1         | 256Mi          | 512Mi        |
| backup job      | 250m        | 2         | 256Mi          | 1Gi          |
| backup verify   | 1           | 4         | 1Gi            | 4Gi          |

Size the GraphQL server's `DB_POOL_MAX` against Postgres `max_connections`:
replicas × pool, plus the indexer's pool, plus the `LISTEN` connection each
replica holds.

The GraphQL Deployment spreads replicas across nodes with a
`topologySpreadConstraints` skewed at 1 and `whenUnsatisfiable: ScheduleAnyway`,
so a single-node cluster still schedules. Every pod runs `runAsNonRoot`,
`readOnlyRootFilesystem`, with all capabilities dropped and the `RuntimeDefault`
seccomp profile; the namespace enforces the `restricted` Pod Security Standard
rather than auditing it. The backup `verify` job needs a larger `/dev/shm` than
the 64Mi default for parallel index builds and mounts one explicitly.

## Configuration

Non-secret configuration lives in one ConfigMap per workload
(`indexer/configmap.yaml`, `graphql/configmap.yaml`, `backup/configmap.yaml`).
Every variable is described in the README's environment-variable tables; only
the ones a cluster needs to think about are set in the base. Anything
cluster-specific — a different Horizon URL, more retention — is an overlay
patch.

## What the base does not do

Left to an overlay or to the operator on purpose:

- **Ingress.** Exposing the GraphQL Service outside the cluster is
  cluster-specific. Whatever fronts it must support WebSocket upgrades on
  `/graphql` for subscriptions.
- **Storage.** The backup jobs use `emptyDir` sized from the figures in
  `docs/DISASTER_RECOVERY.md`. A database large enough to want a persistent
  volume for a restore wants a `PersistentVolumeClaim` template in the overlay
  instead of node disk.
- **Secret material.** See `docs/SECRETS.md`.
- **Egress policy.** The base ships ingress-only `NetworkPolicy`. The services
  reach Horizon, Soroban RPC, Postgres and object storage at addresses the base
  cannot know, so egress is left open rather than guessed at; a cluster with a
  known egress range should add one.
