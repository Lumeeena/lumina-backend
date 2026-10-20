/**
 * Runs a service the way a deployment does, restart policy included.
 *
 * docker/docker-compose.yml runs every service with `restart: unless-stopped`,
 * so a process that exits is started again with no operator involved. Some
 * recovery paths depend on that on purpose: the indexer exits non-zero when it
 * loses its leader lock and relies on being restarted into standby. A harness
 * that did not restart would report those paths as failures; one that did more
 * than restart would hide real ones. So this restarts exactly as Docker does —
 * a delay that starts at 100 ms, doubles per consecutive restart up to a
 * minute, and resets once the process has stayed up for ten seconds — and
 * records every exit, which is what "recovered without manual intervention"
 * is measured against.
 */
import { spawn, type ChildProcess } from 'child_process';
import { createWriteStream, type WriteStream } from 'fs';

const INITIAL_RESTART_DELAY_MS = 100;
const MAX_RESTART_DELAY_MS = 60_000;
const RESET_AFTER_UPTIME_MS = 10_000;
const STOP_GRACE_MS = 12_000;

export interface ExitRecord {
  at: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  uptimeMs: number;
  /** The last log lines before the exit, for the report. */
  lastLines: string[];
}

export interface ServiceOptions {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logFile: string;
}

export class SupervisedService {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartDelay = INITIAL_RESTART_DELAY_MS;
  private startedAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly recent: string[] = [];
  private readonly log: WriteStream;
  readonly exits: ExitRecord[] = [];
  starts = 0;

  constructor(readonly options: ServiceOptions) {
    // One log per run; restarts within the run append to it.
    this.log = createWriteStream(options.logFile);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Log lines seen since the process was first started, newest last (bounded). */
  get recentLines(): readonly string[] {
    return this.recent;
  }

  start(): void {
    this.stopping = false;
    this.spawn();
  }

  private spawn(): void {
    this.restartTimer = null;
    this.starts++;
    this.startedAt = Date.now();
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let partial = '';
    const onData = (chunk: Buffer) => {
      this.log.write(chunk);
      const text = partial + chunk.toString();
      const lines = text.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        this.recent.push(line);
        if (this.recent.length > 2_000) this.recent.splice(0, this.recent.length - 2_000);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code, signal) => {
      const uptimeMs = Date.now() - this.startedAt;
      this.child = null;
      this.exits.push({ at: Date.now(), code, signal, uptimeMs, lastLines: this.recent.slice(-15) });
      this.log.write(`--- ${this.options.name} exited (code ${code}, signal ${signal}) after ${uptimeMs} ms ---\n`);
      if (this.stopping) return;
      if (uptimeMs >= RESET_AFTER_UPTIME_MS) this.restartDelay = INITIAL_RESTART_DELAY_MS;
      const delay = this.restartDelay;
      this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_DELAY_MS);
      this.restartTimer = setTimeout(() => this.spawn(), delay);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (child) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      await exited;
      clearTimeout(timer);
    }
    await new Promise<void>(resolve => this.log.end(() => resolve()));
  }
}
