/**
 * An HTTP server that can be told to fail the way a real dependency does.
 *
 * The fakes for Horizon and Soroban RPC sit on top of this. Each failure mode
 * is what the services see on the wire during a real incident, not a thrown
 * exception inside a mock:
 *
 * - `throttle` — 429 with `Retry-After`, Horizon's answer to a client that is
 *   over its rate limit.
 * - `error`    — a 5xx, an upstream that is up but failing.
 * - `hang`     — the request is accepted and never answered. Clearing the
 *   fault does not rescue a request already hanging, any more than a real
 *   wedged upstream does: only the client's own timeout ends it.
 * - `down`     — the port stops listening and open sockets are reset, so a new
 *   request is refused outright.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { Socket } from 'net';

export type HttpFault =
  | { mode: 'ok' }
  | { mode: 'throttle'; retryAfterSeconds: number }
  | { mode: 'error'; status: number }
  | { mode: 'hang' }
  | { mode: 'down' };

export type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

export class FaultyHttpServer {
  private server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly hanging = new Set<ServerResponse>();
  private fault: HttpFault = { mode: 'ok' };
  private listening = false;
  port = 0;
  /** Responses sent, by status; `hang` counts requests that were never answered. */
  readonly responses = new Map<string, number>();

  constructor(private readonly handler: Handler) {
    this.server = this.build();
  }

  private build(): Server {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => this.dispatch(req, body, res));
    });
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    return server;
  }

  private count(key: string): void {
    this.responses.set(key, (this.responses.get(key) ?? 0) + 1);
  }

  private dispatch(req: IncomingMessage, body: string, res: ServerResponse): void {
    const fault = this.fault;
    switch (fault.mode) {
      case 'throttle':
        this.count('429');
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(fault.retryAfterSeconds) });
        res.end(JSON.stringify({ status: 429, title: 'Rate Limit Exceeded' }));
        return;
      case 'error':
        this.count(String(fault.status));
        res.writeHead(fault.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: fault.status, title: 'Injected failure' }));
        return;
      case 'hang':
        this.count('hang');
        this.hanging.add(res);
        res.on('close', () => this.hanging.delete(res));
        return;
      default: {
        const end = res.end.bind(res);
        res.end = ((...args: Parameters<typeof end>) => {
          this.count(String(res.statusCode));
          return end(...args);
        }) as typeof res.end;
        this.handler(req, body, res);
      }
    }
  }

  async listen(port = 0): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (address && typeof address === 'object') this.port = address.port;
    this.listening = true;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get currentFault(): HttpFault {
    return this.fault;
  }

  async setFault(fault: HttpFault): Promise<void> {
    const wasDown = this.fault.mode === 'down';
    this.fault = fault;
    if (fault.mode === 'down' && this.listening) {
      this.listening = false;
      const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
      for (const socket of this.sockets) socket.destroy();
      await closed;
    } else if (fault.mode !== 'down' && wasDown) {
      // A closed http.Server cannot listen again; a fresh one takes the port.
      this.server = this.build();
      await this.listen(this.port);
    }
  }

  async close(): Promise<void> {
    for (const res of this.hanging) res.destroy();
    for (const socket of this.sockets) socket.destroy();
    if (this.listening) {
      this.listening = false;
      await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
