import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { PreparedMedia, Publisher, PublisherCredentials } from '../../domain/demo.js';
import type { PublisherPort } from '../../domain/ports.js';
import type { TimingContext } from '../../observability/timing.js';
import { ingestUrl } from './process.js';

export function checkPersistentBinary(binary: string): void {
  const result = spawnSync(binary, ['--version'], { timeout: 5000, encoding: 'utf8', maxBuffer: 4096 });
  let protocol = 0;
  try { protocol = JSON.parse(result.stdout ?? '{}').protocol; } catch { /* Invalid binary. */ }
  if (result.error || result.status !== 0 || protocol !== 1) throw new Error('Persistent publisher binary is unavailable');
}

interface Receipt { committedAt: string; outputTimestamp: number }
interface Event { event: string; requestId?: string; outputTimestamp?: number }

class PersistentPublisher implements Publisher {
  readonly pid: number;
  readonly startedAt = new Date().toISOString();
  readonly exit: Promise<number | null>;
  readonly ready: Promise<void>;
  private running = true;
  private stopping = false;
  private pending: { id: string; resolve: (r: Receipt) => void; reject: (e: Error) => void } | null = null;
  private send(message: object): void {
    if (!this.running || this.child.stdin.destroyed) throw new Error('Persistent publisher exited');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  constructor(private readonly child: ChildProcessWithoutNullStreams, readonly durationSeconds: number | null,
    log?: FastifyBaseLogger, context: TimingContext = {}) {
    if (!child.pid) throw new Error('Persistent publisher failed to spawn');
    this.pid = child.pid;
    // Both library errors and local paths can contain credentials. Never relay them.
    child.stderr.resume();
    child.stdin.on('error', () => { void this.stop(); });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.exit = new Promise((resolve) => {
      const finish = (code: number | null) => {
        this.running = false;
        rejectReady(new Error('Persistent publisher exited before ready'));
        this.pending?.reject(new Error('Persistent publisher exited'));
        this.pending = null;
        resolve(code);
      };
      child.once('exit', finish);
      child.once('error', () => finish(null));
    });
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 65536) { void this.stop(); return; }
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        let event: Event;
        try { event = JSON.parse(line) as Event; } catch { void this.stop(); continue; }
        if (event.event === 'ready') resolveReady();
        if (event.event === 'fatal') { rejectReady(new Error('Persistent publisher failed')); void this.stop(); }
        if (event.event === 'progress' && Number.isFinite(event.outputTimestamp)) {
          log?.debug({ ...context, event: 'persistent_publisher_progress', publisherPid: this.pid,
            outputTimestamp: event.outputTimestamp }, 'Persistent output progress');
        }
        if (!this.pending || event.requestId !== this.pending.id) continue;
        const pending = this.pending;
        if (event.event === 'switch_committed' && Number.isFinite(event.outputTimestamp)) {
          this.pending = null;
          pending.resolve({ committedAt: new Date().toISOString(), outputTimestamp: event.outputTimestamp! });
        } else if (event.event === 'cancelled' || event.event === 'switch_rejected') {
          this.pending = null;
          pending.reject(new Error(event.event === 'cancelled' ? 'Publisher operation cancelled' : 'Persistent asset rejected'));
        }
      }
    });
  }
  alive(): boolean { return this.running; }
  async switchSource(media: PreparedMedia, requestId: string, signal: AbortSignal): Promise<Receipt> {
    if (signal.aborted) throw new Error('Publisher operation cancelled');
    if (this.stopping || this.pending) throw new Error('Persistent publisher is busy or stopping');
    if (media.mediaProfile !== 'square800-copy-v2' || media.publishMode !== 'copy') throw new Error('Persistent asset rejected');
    const cancelled = () => { try { this.send({ type: 'cancel', requestId }); } catch { /* Exit settles pending. */ } };
    // A timeout kills the publisher: continuing with unknown output state is unsafe.
    const timer = setTimeout(() => { void this.stop(); }, 12000);
    try {
      return await new Promise<Receipt>((resolve, reject) => {
        this.pending = { id: requestId, resolve, reject };
        signal.addEventListener('abort', cancelled, { once: true });
        try { this.send({ type: 'switch', requestId, path: media.path }); }
        catch (error) { this.pending = null; reject(error); }
      });
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancelled); }
  }
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    try { this.send({ type: 'stop', requestId: randomUUID() }); } catch { /* Already exited. */ }
    // Signal interrupts validation and network writes, even if the control reader is busy.
    try { process.kill(-this.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    await Promise.race([this.exit, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
    if (this.running) { try { process.kill(-this.pid, 'SIGKILL'); } catch { /* Already exited. */ } await this.exit; }
  }
  initialize(input: string, output: string): void { this.send({ type: 'start', path: input, output }); }
}

export class PersistentFactory implements PublisherPort {
  constructor(private readonly binary: string, private readonly log?: FastifyBaseLogger,
    private readonly keyframeInterval: number | null = null) {}
  async start(input: string, hasAudio: boolean, durationSeconds: number | null, ingest: PublisherCredentials,
    priority: number, context: TimingContext = {}, publishMode: 'copy' | 'encode' = 'copy'): Promise<Publisher> {
    if (!hasAudio || publishMode !== 'copy') throw new Error('Persistent publisher requires prepared tracks');
    checkPersistentBinary(this.binary);
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new Error('Persistent publisher failed to spawn')));
    });
    const publisher = new PersistentPublisher(child, durationSeconds, this.log, context);
    const timer = setTimeout(() => { void publisher.stop(); }, 60000);
    try {
      publisher.initialize(input, ingestUrl(ingest, priority, this.keyframeInterval));
      await publisher.ready;
      return publisher;
    } catch { await publisher.stop(); throw new Error('Persistent publisher could not start'); }
    finally { clearTimeout(timer); }
  }
}
