import { spawn, type ChildProcess } from 'node:child_process';
import type { Publisher, PublisherCredentials } from '../../domain/demo.js';

export function ingestUrl(ingest: PublisherCredentials, priority: number): string {
  const endpoint = new URL(ingest.ingest_server.startsWith('rtmps://')
    ? ingest.ingest_server : `rtmps://${ingest.ingest_server}`);
  if (endpoint.protocol !== 'rtmps:') throw new Error('IVS ingest must use RTMPS');
  endpoint.port ||= '443';
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/app';
  endpoint.search = '';
  const streamUrl = `${endpoint.toString().replace(/\/$/, '')}/${encodeURIComponent(ingest.stream_key)}`;
  return priority > 0 ? `${streamUrl}?priority=${priority}` : streamUrl;
}

export function ffmpegArgs(input: string, output: string, hasAudio: boolean): string[] {
  return [
    '-hide_banner', '-loglevel', 'warning', '-re', '-stream_loop', '-1', '-i', input,
    ...(!hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'] : []),
    '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
    '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    '-preset', 'veryfast', '-b:v', '3000k', '-maxrate', '3000k', '-minrate', '3000k',
    '-bufsize', '3000k', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '44100', '-shortest', '-f', 'flv', output,
  ];
}

class FfmpegPublisher implements Publisher {
  readonly pid: number;
  readonly startedAt = new Date().toISOString();
  readonly exit: Promise<number | null>;
  private running = true;

  constructor(private readonly child: ChildProcess, readonly durationSeconds: number | null) {
    if (!child.pid) throw new Error('FFmpeg did not start');
    this.pid = child.pid;
    this.running = child.exitCode === null && child.signalCode === null;
    this.exit = new Promise((resolve) => {
      if (!this.running) { resolve(child.exitCode); return; }
      child.once('exit', (code) => { this.running = false; resolve(code); });
      child.once('error', () => { this.running = false; resolve(null); });
    });
  }

  alive(): boolean { return this.running; }

  async stop(): Promise<void> {
    if (!this.running) return;
    // FFmpeg is spawned into its own process group so its descendants are also terminated.
    try { process.kill(-this.pid, 'SIGTERM'); } catch { /* Process already exited. */ }
    await Promise.race([this.exit, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
    if (this.running) {
      try { process.kill(-this.pid, 'SIGKILL'); } catch { /* Process already exited. */ }
      await this.exit;
    }
  }
}

export class FfmpegFactory {
  constructor(private readonly binary: string) {}

  async start(input: string, hasAudio: boolean, durationSeconds: number | null,
    ingest: PublisherCredentials, priority: number): Promise<Publisher> {
    const child = spawn(this.binary, ffmpegArgs(input, ingestUrl(ingest, priority), hasAudio), {
      stdio: ['ignore', 'ignore', 'pipe'], detached: true,
    });
    // stderr can contain the ingest URL. Drain it but never write it to logs.
    child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { child.off('error', onError); resolve(); };
      const onError = (error: Error) => { child.off('spawn', onSpawn); reject(error); };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    return new FfmpegPublisher(child, durationSeconds);
  }
}
