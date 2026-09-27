# Shared

Code both services run, as one implementation.

`shared/` is an npm workspace package (`@lumina/shared`), consumed by the
indexer and the GraphQL server alike. It holds:

- `src/horizon.ts` — the Horizon client, throttled, timeout-bounded and retried,
  with the types both services read.
- `src/throttle.ts` — the request pacer the Horizon client and the indexer's
  Soroban RPC calls share.

It imports nothing from either service: configuration, the logger and the
metrics registry are injected by the caller, which is what keeps the dependency
arrow pointing one way.

