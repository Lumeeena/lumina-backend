import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { makeExecutableSchema } from '@graphql-tools/schema';
import cors from 'cors';
import express from 'express';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { join } from 'path';
import { Pool } from 'pg';
import { GraphQLError } from 'graphql';
import { useServer } from 'graphql-ws/lib/use/ws';
import { WebSocketServer } from 'ws';
import { Context, createContext, resolvers } from './resolvers';
import { LedgerNotifier, SubscriberLimitError } from './pubsub';
import { subsystem } from './logger';
import { buildServerHealth, metricsPlugin, samplePool, serverHealthStatusCode } from './observability';
import { v4 as uuidv4 } from 'uuid'; // TODO: Ensure 'uuid' is a dependency

interface Context extends BaseContext {
  correlationId: string;
  requestLogger: ReturnType<typeof subsystem>;
}
import {
  listenerConnected,
  metricsContentType,
  renderMetrics,
  subscriptionsActive,
  subscriptionsRejected,
} from './metrics';
import { initTracing, shutdownTracing } from './tracing';
import { initErrorTracking, shutdownErrorTracking } from './errorTracking';
import { loadMigrations, runMigrations } from './migrations';
import { ExportLimiter, hasExportPermission, writeDatabaseExport } from './export';
import { hashApiKey } from './keys';

const log = subsystem('server');
const startedAt = Date.now();

// Read version from package.json for logging and API reporting
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
const VERSION = packageJson.version;

const typeDefs = readFileSync(join(__dirname, 'schema.graphql'), 'utf-8');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/lumina';
const PORT = parseInt(process.env.PORT ?? '4000', 10);
const MAX_SUBSCRIPTIONS = parseInt(process.env.MAX_SUBSCRIPTIONS ?? '500', 10);
const SUBSCRIPTION_QUEUE_LIMIT = parseInt(process.env.SUBSCRIPTION_QUEUE_LIMIT ?? '64', 10);
const exportRateLimit = parseInt(process.env.EXPORT_RATE_LIMIT_PER_MINUTE ?? '2', 10);
const exportConcurrency = parseInt(process.env.MAX_CONCURRENT_EXPORTS ?? '2', 10);
const exportLimiter = new ExportLimiter(exportRateLimit, exportConcurrency);

const pool = new Pool({ connectionString: DATABASE_URL });
const schema = makeExecutableSchema({ typeDefs, resolvers });

const notifier = new LedgerNotifier({
  connectionString: DATABASE_URL,
  maxSubscribers: MAX_SUBSCRIPTIONS,
  queueLimit: SUBSCRIPTION_QUEUE_LIMIT,
  log: (message, detail) => subsystem('pubsub').info({ detail }, message),
});

async function main() {
  if (process.env.RUN_MIGRATIONS_ON_STARTUP === 'true') {
    const status = await runMigrations(pool, loadMigrations());
    log.info({ applied: status.applied, pending: status.pending }, 'database migrations ready');
  }
  initErrorTracking();
  initTracing();

  const app = express();
  const httpServer = createServer(app);

  // Subscriptions need a real HTTP server to upgrade from, which
  // `startStandaloneServer` does not expose — hence Express here. The GraphQL
  // endpoint is mounted at both paths the previous standalone server answered
  // on, so no existing client has to change its URL.
  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });

  const wsCleanup = useServer(
    {
      schema,
      context: async (): Promise<Context> => createContext(pool, { notifier }),
      onError: (_ctx: unknown, _message: unknown, errors: readonly Error[]) => {
        for (const error of errors) {
          log.error({ err: error.message }, 'subscription error');
        }
      },
      // A subscription refused for being over the cap should close cleanly with
      // a reason, not surface as an unhandled server error.
      onComplete: () => {
        subscriptionsActive.set(notifier.subscriberCount);
      },
      onSubscribe: () => {
        subscriptionsActive.set(notifier.subscriberCount);
        if (notifier.subscriberCount >= MAX_SUBSCRIPTIONS) {
          subscriptionsRejected.inc();
          log.warn({ limit: MAX_SUBSCRIPTIONS }, 'subscription refused at concurrency ceiling');
          // Returned as a GraphQLError so graphql-ws sends the client a proper
          // `error` message and closes the operation, rather than the
          // subscription failing later as an unhandled server error.
          return [new GraphQLError(new SubscriberLimitError(MAX_SUBSCRIPTIONS).message)];
        }
        return undefined;
      },
    },
    wsServer
  );

  const server = new ApolloServer<Context>({
    schema,
    plugins: [
      metricsPlugin(),
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        // Draining the websocket layer on shutdown as well, so a deploy does
        // not leave sockets hanging.
        async serverWillStart() {
          return {
            async drainServer() {
              await wsCleanup.dispose();
              await notifier.stop();
            },
          };
        },
      },
    ],
  });

  await server.start();
  await notifier.start();

  // Ahead of the GraphQL middleware so an operator can always reach them, even
  // while the schema layer is unhappy.
  app.get('/health', (_req, res) => {
    buildServerHealth({
      pool,
      startedAt,
      listenerConnected: notifier.connected,
      subscriptionCount: notifier.subscriberCount,
    })
      .then(report => {
        listenerConnected.set(notifier.connected ? 1 : 0);
        res.status(serverHealthStatusCode(report)).json(report);
      })
      .catch(err => {
        log.error({ err: err instanceof Error ? err.message : err }, 'health check failed');
        res.status(500).json({ status: 'degraded', error: 'health check failed' });
      });
  });

  app.get('/metrics', (_req, res) => {
    // Sampled at scrape time so the numbers describe this instant rather than
    // whenever a background timer last fired.
    samplePool(pool);
    subscriptionsActive.set(notifier.subscriberCount);
    listenerConnected.set(notifier.connected ? 1 : 0);

    renderMetrics()
      .then(body => res.set('Content-Type', metricsContentType()).send(body))
      .catch(err => {
        log.error({ err: err instanceof Error ? err.message : err }, 'failed to render metrics');
        res.status(500).send('metrics unavailable');
      });
  });

  app.get('/export', async (req, res) => {
    const match = /^Bearer\s+(lum_[a-f0-9]{64})$/i.exec(req.header('authorization') ?? '');
    let authorized = false;
    try { authorized = Boolean(match && await hasExportPermission(pool, match[1])); }
    catch (error) {
      log.error({ err: error instanceof Error ? error.message : error }, 'export authorization failed');
      res.status(503).json({ error: 'Export authorization is temporarily unavailable' });
      return;
    }
    if (!authorized || !match) {
      res.status(403).json({ error: 'A valid API key with export permission is required' });
      return;
    }
    const keyHash = hashApiKey(match[1]);
    if (!exportLimiter.allow(keyHash)) {
      res.set('Retry-After', '60').status(429).json({ error: 'Export rate limit exceeded' });
      return;
    }
    const release = exportLimiter.acquire();
    if (!release) {
      res.set('Retry-After', '30').status(429).json({ error: 'Concurrent export limit reached' });
      return;
    }
    res.status(200).set({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': 'attachment; filename="lumina-export.ndjson"',
      'Cache-Control': 'no-store',
    });
    try {
      await writeDatabaseExport(pool, line => new Promise<boolean>(resolve => {
        if (res.destroyed) { resolve(false); return; }
        if (res.write(line)) { resolve(true); return; }
        const drained = () => { cleanup(); resolve(true); };
        const closed = () => { cleanup(); resolve(false); };
        const cleanup = () => { res.off('drain', drained); res.off('close', closed); };
        res.once('drain', drained);
        res.once('close', closed);
      }));
      if (!res.destroyed) res.end();
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : error }, 'database export failed');
      if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
      else res.destroy(error instanceof Error ? error : undefined);
    } finally { release(); }
  });

  const middleware = [
    cors(),
    express.json(),
    expressMiddleware(server, { context: async () => createContext(pool) }),
  ];
  app.use('/graphql', ...middleware);
  app.use('/', ...middleware);

  await new Promise<void>(resolve => httpServer.listen({ port: PORT }, resolve));

  log.info(
    {
      version: VERSION,
      graphql: `http://localhost:${PORT}/graphql`,
      subscriptions: `ws://localhost:${PORT}/graphql`,
      health: `http://localhost:${PORT}/health`,
      metrics: `http://localhost:${PORT}/metrics`,
      database: redactUrl(DATABASE_URL),
    },
    'lumina graphql server listening'
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'shutting down');
      void server.stop()
        .then(() => shutdownTracing())
        .then(() => shutdownErrorTracking())
        .then(() => process.exit(0));
    });
  }
}

main().catch(err => {
  log.fatal({ err: err instanceof Error ? err.message : err }, 'failed to start graphql server');
  process.exit(1);
});

/** Never log a database URL with its password in it. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable)';
  }
}
