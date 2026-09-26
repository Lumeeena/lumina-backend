# Local Development Setup Guide

This guide walks you through setting up a complete local development environment for Lumina backend, from initial clone to running services with real data.

**Time estimate:** 15 minutes

## Prerequisites

- **Node.js 18+** — required by the project
- **PostgreSQL 12+** — required for the indexer and GraphQL server
- **Basic UNIX shell** — for running commands
- **Git** — for cloning the repository

## 1. Clone and Install Dependencies

```bash
git clone https://github.com/Lumeeena/lumina-backend.git
cd lumina-backend

npm install
```

This installs dependencies for the root workspace and both sub-packages (indexer and graphql-server).

## 2. Set Up PostgreSQL

### Start PostgreSQL

**Using Docker (simplest):**

```bash
docker run -d \
  --name lumina-postgres \
  -e POSTGRES_DB=lumina \
  -e POSTGRES_USER=lumina \
  -e POSTGRES_PASSWORD=lumina_test \
  -p 5432:5432 \
  postgres:16-alpine
```

**Using Homebrew (macOS):**

```bash
brew services start postgresql@16
createdb -U postgres lumina
```

**Using apt (Linux):**

```bash
sudo systemctl start postgresql
sudo -u postgres createdb lumina
sudo -u postgres psql -c "CREATE USER lumina WITH PASSWORD 'lumina_test'; ALTER USER lumina CREATEDB;"
```

### Apply Database Schema

Once PostgreSQL is running:

```bash
export DATABASE_URL=postgresql://lumina:lumina_test@localhost:5432/lumina
psql $DATABASE_URL -f db/schema.sql
```

This creates all tables, indexes, and functions needed by the indexer and GraphQL server.

**Verify:** Connect to verify the schema loaded:

```bash
psql $DATABASE_URL -c "\dt"  # Lists tables
```

You should see tables like `ledgers`, `transactions`, `operations`, `accounts`, etc.

## 3. Start the Indexer

In one terminal window:

```bash
cd indexer
npm run dev
```

The indexer starts by default at the latest ledger on mainnet. You'll see logs like:

```
indexing ledger 52481234...
indexed ledger 52481234 (25 txs, 142 ops)
indexing ledger 52481235...
```

The first ledger takes ~5 seconds; subsequent ones ~5 seconds apart (the indexer polls every 5 seconds by default).

**Common startup issues:**

- `Error: connect ECONNREFUSED 127.0.0.1:5432` — PostgreSQL is not running; start it first.
- `error: database "lumina" does not exist` — Run `psql $DATABASE_URL -f db/schema.sql` again.
- `HORIZON_URL: connection refused` — Your network is down or Horizon is unreachable; check connectivity.

## 4. Start the GraphQL Server

In another terminal window:

```bash
cd graphql-server
npm run dev
```

The GraphQL server listens on `http://localhost:4000`. You'll see:

```
🚀 GraphQL server ready at http://localhost:4000/graphql
📡 Subscriptions ready at ws://localhost:4000/graphql
```

### Test the GraphQL Server

Open a browser to `http://localhost:4000/graphql` and run a query:

```graphql
query {
  ledgers(limit: 10) {
    items {
      sequence
      closedAt
      transactionCount
    }
  }
}
```

The ledgers you see are live data the indexer fetched and indexed into Postgres. If nothing appears, wait a moment—the indexer may still be catching up from the starting ledger.

## 5. Check Health

Both services expose health endpoints:

```bash
# Indexer
curl http://localhost:9090/health

# GraphQL server
curl http://localhost:4000/health
```

A healthy response is `{"status":"ok","checks":...}`. An unhealthy one includes `"status":"error"` and names the problem.

## Environment Variables

### Indexer (`indexer/.env` or shell export)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://localhost:5432/lumina` | PostgreSQL connection |
| `NETWORKS` | unset | Comma-separated networks to index (e.g. `mainnet,testnet`); each needs `<NAME>_HORIZON_URL`. See [`MULTI_NETWORK.md`](MULTI_NETWORK.md) |
| `HORIZON_URL` | `https://horizon.stellar.org` | Mainnet Horizon API (change for testnet). Single-network deployments only — ignored when `NETWORKS` is set |
| `START_LEDGER` | Latest ledger | Initial ledger to index; useful for backfilling |
| `POLL_INTERVAL_MS` | `5000` | Delay between ledger polls |
| `HORIZON_MIN_REQUEST_INTERVAL_MS` | `100` | Minimum spacing between Horizon requests (raises if 429 rate-limit errors appear) |
| `HEALTH_PORT` | `9090` | Port for `/health` endpoint |
| `LOG_LEVEL` | `info` | `debug` for verbose per-ledger logging |
| `LOG_PRETTY` | unset | Set to `true` for human-readable logs |

### GraphQL Server (`graphql-server/.env` or shell export)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://localhost:5432/lumina` | Same PostgreSQL connection |
| `PORT` | `4000` | HTTP port for Apollo server |
| `LOG_LEVEL` | `info` | `debug` for per-request GraphQL detail |
| `LOG_PRETTY` | unset | Set to `true` for human-readable logs |
| `MAX_SUBSCRIPTIONS` | `500` | Max concurrent GraphQL subscriptions |
| `NETWORKS` | unset | Same scheme as the indexer; queries then accept a `network` argument |
| `PERSISTED_QUERIES` | `true` | Automatic persisted queries; `false` refuses hash-only requests |

## Switching to Testnet

To index Stellar's **testnet** instead of mainnet:

1. **Stop the indexer** (Ctrl+C in its terminal).

2. **Clear the ledgers table** (data is testnet-specific):

```bash
psql $DATABASE_URL -c "TRUNCATE TABLE ledgers CASCADE;"
```

3. **Start the indexer on testnet:**

```bash
export HORIZON_URL=https://horizon-testnet.stellar.org
export START_LEDGER=1  # Re-index from the first testnet ledger
cd indexer && npm run dev
```

The server keeps running — queries now return testnet data. The GraphQL query syntax is identical; only the data changes.

**Common mistake:** Forgetting to truncate tables. If you query after switching and get empty results, or if queries time out, clear the database and re-start.

To keep **both** at once instead of switching, declare them and point each at
its own endpoint — rows are keyed by network, so they share one database
without mixing (and nothing needs truncating):

```bash
export NETWORKS=mainnet,testnet
export MAINNET_HORIZON_URL=https://horizon.stellar.org
export TESTNET_HORIZON_URL=https://horizon-testnet.stellar.org
```

The GraphQL server reads the same variables; queries then take
`network: TESTNET`, and omitting the argument serves the primary network.
Full scheme, error cases and the one-time relabel of existing rows:
[`MULTI_NETWORK.md`](MULTI_NETWORK.md).

## Running Tests

### Unit Tests

```bash
npm test          # Both packages
npm run test:indexer   # Indexer only
npm run test:graphql   # GraphQL server only
```

Tests use mocked services; they don't need Postgres or Horizon.

### Integration Tests

Integration tests run against a real Postgres instance and verify subscriptions and custom schemas work end-to-end:

```bash
npm run test:integration -w @lumina/graphql-server
npm run test:integration -w @lumina/indexer
```

Set `TEST_DATABASE_URL` if your test database differs from the development one:

```bash
TEST_DATABASE_URL=postgresql://lumina:lumina_test@localhost:5432/lumina_test \
  npm run test:integration -w @lumina/graphql-server
```

## Running with Docker Compose

For a fully self-contained setup (Postgres, indexer, and GraphQL server):

```bash
docker compose -f docker/docker-compose.yml up
```

Then:

- **GraphQL:** `http://localhost:4000/graphql`
- **Postgres:** `postgresql://lumina:lumina_test@localhost:5432/lumina`

To include Prometheus and Grafana dashboards:

```bash
docker compose -f docker/docker-compose.yml --profile observability up
```

Then:

- **Grafana:** `http://localhost:3001` (admin/admin)
- **Prometheus:** `http://localhost:9091`

## Troubleshooting

### "Postgres is not reachable"

**Problem:** Both services fail immediately with `error: database not reachable` or connection refused.

**Fixes:**

1. Verify Postgres is running: `psql postgresql://lumina:lumina_test@localhost:5432/lumina -c "SELECT 1"`
2. Check `DATABASE_URL` is correct and matches your Postgres setup.
3. If using Docker, ensure the container is running: `docker ps | grep postgres`

### "Indexer lag is high / indexing stalls"

**Problem:** Indexer logs show ledgers are not being fetched, or lag climbs indefinitely.

**Fixes:**

1. **Check Horizon connectivity:** `curl https://horizon.stellar.org/ledgers`
2. **Check database writes:** Verify `ledgers` table is growing: `psql $DATABASE_URL -c "SELECT MAX(sequence) FROM ledgers"`
3. **Check for 429s:** Look for "horizon rate limited" in logs; if present, raise `HORIZON_MIN_REQUEST_INTERVAL_MS` to 500–1000.
4. **Check database performance:** If `psql` is slow, the pool may be exhausted; check `LOG_LEVEL=debug` logs for pool warnings.

### "GraphQL queries return empty even though indexer is running"

**Problem:** Queries like `{ ledgers { items { sequence } } }` return empty lists.

**Fixes:**

1. Verify the indexer is actually indexing: check its logs for `indexed ledger N`.
2. Check Postgres directly: `psql $DATABASE_URL -c "SELECT COUNT(*) FROM ledgers"`
3. If switching between mainnet/testnet, **truncate tables**: `psql $DATABASE_URL -c "TRUNCATE TABLE ledgers CASCADE;"`
4. Wait a moment—the indexer may still be fetching the first ledger; this takes ~5 seconds.

### "Subscriptions not connecting"

**Problem:** GraphQL subscriptions connect but never receive updates.

**Fixes:**

1. Verify the LISTEN connection is alive: Check logs for `listener connected`.
2. Verify the indexer is running and indexing ledgers.
3. Try a fresh subscription by opening a new GraphQL connection—cached subscriptions may stall.

## Next Steps

- **Explore the GraphQL API:** See [docs/API_GUIDE.md](API_GUIDE.md) for query examples.
- **Custom schemas:** Learn to index your own Soroban contracts in [docs/CUSTOM_SCHEMAS.md](CUSTOM_SCHEMAS.md).
- **Observability:** Run with Prometheus and Grafana for live metrics and dashboards.

## Getting Help

- **Schema issues:** Check that `psql $DATABASE_URL -c "\dt"` shows all expected tables.
- **Horizon issues:** Open `https://horizon.stellar.org/ledgers` in a browser to verify it's reachable.
- **GraphQL issues:** Test with `curl http://localhost:4000/health` to check the server is responding.
