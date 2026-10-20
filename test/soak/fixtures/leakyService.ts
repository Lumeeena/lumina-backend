/**
 * A service that leaks slowly, in the three ways a Node service does, for the
 * test that proves the soak detector catches a leak by its trend.
 *
 * Healthy and leaking modes do the same work — allocate and drop garbage,
 * open sockets, reconnect to Postgres — and differ only in whether they let go:
 *
 * - memory: a slice of every allocation is retained;
 * - handles: a socket opened to itself each tick is never closed;
 * - connections: each reconnect opens a new Postgres client without ending the
 *   old one — the bug that once leaked one LISTEN connection per reconnect.
 *
 * Exposes prom-client's default metrics with the `leaky_` prefix on PORT.
 * LEAK=1 leaks; anything else is the healthy control.
 */
import { createServer, connect, type Socket } from 'net';
import { createServer as createHttpServer } from 'http';
import { Client } from 'pg';
import { collectDefaultMetrics, Registry } from 'prom-client';

const leaking = process.env['LEAK'] === '1';
const port = Number(process.env['PORT']);
const databaseUrl = process.env['DATABASE_URL'];
const tickMs = Number(process.env['TICK_MS'] ?? 1_000);

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'leaky_' });

const retained: Buffer[] = [];
const retainedObjects: unknown[][] = [];
const sockets: Socket[] = [];
let pg: Client | null = null;

const echo = createServer(socket => socket.on('error', () => undefined));
echo.listen(0, '127.0.0.1');

async function reconnect(): Promise<void> {
  if (!databaseUrl) return;
  const previous = pg;
  pg = new Client({ connectionString: databaseUrl });
  pg.on('error', () => undefined);
  await pg.connect();
  if (!leaking) await previous?.end().catch(() => undefined);
}

let tick = 0;
setInterval(() => {
  tick++;
  // Garbage every tick, so the healthy heap saws as a real one does.
  // Buffers live outside the V8 heap and objects inside it; a real leak can be
  // either, so both are made, and in the leaking mode a slice of each is kept.
  const garbage = Buffer.alloc(4 * 1024 * 1024, tick);
  const objects = Array.from({ length: 20_000 }, (_, i) => ({ tick, i, label: `row-${tick}-${i}` }));
  if (leaking) {
    retained.push(Buffer.from(garbage.subarray(0, 1024 * 1024)));
    retainedObjects.push(objects.slice(0, 5_000));
  }

  const address = echo.address();
  if (address && typeof address === 'object') {
    const socket = connect(address.port, '127.0.0.1');
    socket.on('error', () => undefined);
    if (leaking) sockets.push(socket);
    else setTimeout(() => socket.destroy(), tickMs / 2);
  }

  if (tick % 2 === 0) void reconnect().catch(() => undefined);
}, tickMs);

createHttpServer((_req, res) => {
  registry.metrics().then(body => {
    res.writeHead(200, { 'Content-Type': registry.contentType });
    res.end(body);
  });
}).listen(port, '127.0.0.1');
