/**
 * A TCP proxy between the services and Postgres that can make the database
 * disappear.
 *
 * - `down`  — every open connection is reset and the port stops listening, so
 *   a reconnect is refused. To a service this is Postgres crashing or failing
 *   over: a transaction in flight dies with its connection.
 * - `stall` — connections stay open but no byte moves in either direction,
 *   and new connections are accepted and held. This is a network partition:
 *   nothing fails, everything waits. Traffic resumes intact when it clears.
 *
 * The services are pointed at the proxy, the observers in the harness are
 * not, so the harness can still see the database while the services cannot.
 */
import { createConnection, createServer, type Server, type Socket } from 'net';

export type ProxyMode = 'ok' | 'down' | 'stall';

interface Pair {
  client: Socket;
  upstream: Socket;
}

export class TcpFaultProxy {
  private server: Server | null = null;
  private readonly pairs = new Set<Pair>();
  private mode: ProxyMode = 'ok';
  port = 0;
  /** Connections accepted over the proxy's lifetime. */
  accepted = 0;

  constructor(private readonly upstreamHost: string, private readonly upstreamPort: number) {}

  get active(): number {
    return this.pairs.size;
  }

  get currentMode(): ProxyMode {
    return this.mode;
  }

  private accept(client: Socket): void {
    this.accepted++;
    const upstream = createConnection({ host: this.upstreamHost, port: this.upstreamPort });
    const pair = { client, upstream };
    this.pairs.add(pair);
    const close = () => {
      if (!this.pairs.delete(pair)) return;
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', close);
    client.on('close', close);
    upstream.on('close', close);
    client.pipe(upstream);
    upstream.pipe(client);
    if (this.mode === 'stall') this.pause(pair);
  }

  private pause(pair: Pair): void {
    pair.client.pause();
    pair.upstream.pause();
  }

  private resume(pair: Pair): void {
    pair.client.resume();
    pair.upstream.resume();
  }

  async listen(port = this.port): Promise<void> {
    const server = createServer(socket => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address && typeof address === 'object') this.port = address.port;
    this.server = server;
  }

  async setMode(mode: ProxyMode): Promise<void> {
    const previous = this.mode;
    this.mode = mode;
    if (mode === 'down') {
      const server = this.server;
      this.server = null;
      for (const pair of [...this.pairs]) {
        // resetAndDestroy sends an RST where the platform allows it, which is
        // what a crashed peer looks like; destroy() alone sends a clean FIN.
        (pair.client as Socket & { resetAndDestroy?: () => void }).resetAndDestroy?.() ?? pair.client.destroy();
        pair.upstream.destroy();
      }
      this.pairs.clear();
      if (server) await new Promise<void>(resolve => server.close(() => resolve()));
      return;
    }
    if (previous === 'down') await this.listen(this.port);
    for (const pair of this.pairs) {
      if (mode === 'stall') this.pause(pair);
      else this.resume(pair);
    }
  }

  async close(): Promise<void> {
    for (const pair of this.pairs) {
      pair.client.destroy();
      pair.upstream.destroy();
    }
    this.pairs.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
