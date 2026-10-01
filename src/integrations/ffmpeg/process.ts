import { performance } from 'node:perf_hooks';
import type { FastifyBaseLogger } from 'fastify';
import type { TimingContext } from '../../observability/timing.js';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Publisher, PublisherCredentials } from '../../domain/demo.js';

export function ingestUrl(ingest: PublisherCredentials, priority: number, keyframeInterval: number | null = null): string {
  const endpoint = new URL(ingest.ingest_server.startsWith('rtmps://')
    ? ingest.ingest_server : `rtmps://${ingest.ingest_server}`);
  if (endpoint.protocol !== 'rtmps:') throw new Error('IVS ingest must use RTMPS');
  endpoint.port ||= '443';
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/app';
  endpoint.search = '';
  const streamUrl = `${endpoint.toString().replace(/\/$/, '')}/${encodeURIComponent(ingest.stream_key)}`;
  const query = new URLSearchParams();
  if (priority > 0) query.set('priority', String(priority));
  if (keyframeInterval !== null) {
    if (!Number.isInteger(keyframeInterval) || keyframeInterval < 2 || keyframeInterval > 6) throw new Error('Invalid IVS keyframe interval');
    query.set('keyframeInterval', String(keyframeInterval));
  }
  return query.size ? `${streamUrl}?${query}` : streamUrl;
}

export function ffmpegArgs(input: string, output: string, hasAudio: boolean, publishMode: 'copy' | 'encode' = 'encode'): string[] {
  if (publishMode === 'copy' && !hasAudio) throw new Error('Prepared copy requires both tracks');
  return [
    '-hide_banner', '-loglevel', 'warning', '-re', '-stream_loop', '-1', '-i', input,
    ...(!hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'] : []),
    '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0', '-map_metadata', '-1',
    ...(publishMode === 'copy' ? ['-c:v', 'copy', '-c:a', 'copy'] : [
      '-vf', 'scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=800:800:force_original_aspect_ratio=increase,crop=800:800,setsar=1',
      '-r', '30', '-fps_mode', 'cfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'main',
      '-preset', 'veryfast', '-b:v', '3000k', '-maxrate', '3000k', '-minrate', '3000k',
      '-bufsize', '3000k', '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '44100', '-af', 'aresample=async=1:first_pts=0,apad', '-shortest']), '-f', 'flv', output,
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
  constructor(private readonly binary: string, private readonly log?: FastifyBaseLogger, private readonly keyframeInterval: number | null = null) {}

  async start(input: string, hasAudio: boolean, durationSeconds: number | null,
    ingest: PublisherCredentials, priority: number, context: TimingContext = {}, publishMode: 'copy' | 'encode' = 'encode'): Promise<Publisher> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const args = ffmpegArgs(input, ingestUrl(ingest, priority, this.keyframeInterval), hasAudio, publishMode);
    this.log?.info?.({ ...context, event: 'demo_publisher_start', publishMode, mediaProfile: publishMode === 'copy' ? 'square800-v1' : null }, 'Demo publisher mode selected');
    const child = spawn(this.binary, ['-progress', 'pipe:3', '-stats_period', '0.5', ...args], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'], detached: true,
    });
    // stderr can contain the ingest URL. Drain it but never write it to logs.
    child.stderr?.resume();
    // Read only numeric progress; never expose stderr or the RTMPS URL/stream key.
    const progress = child.stdio[3];
    let pending = '';
    let firstFrame = false;
    if (progress && 'on' in progress) progress.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = (lines.pop() ?? '').slice(-1024);
      for (const line of lines) {
        if (!firstFrame && /^frame=\s*[1-9]\d*\s*$/.test(line)) {
          firstFrame = true;
          this.log?.info?.({ ...context, event: 'demo_timing', stage: publishMode === 'copy' ? 'ffmpeg_first_published_progress' : 'ffmpeg_first_encoded_frame', publishMode,
            outcome: 'completed', publisherPid: child.pid, priority, startedAt, endedAt: new Date().toISOString(),
            durationMs: Math.round((performance.now() - start) * 100) / 100 }, 'FFmpeg first output progress observed');
        }
      }
    });
    child.once('exit', (exitCode, signal) => this.log?.info?.({ ...context, event: 'demo_publisher_exit',
      publisherPid: child.pid, priority, exitCode, signal, firstFrameObserved: firstFrame,
      endedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start) }, 'Demo FFmpeg publisher exited'));
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { child.off('error', onError); resolve(); };
      const onError = (error: Error) => { child.off('spawn', onSpawn); reject(error); };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    return new FfmpegPublisher(child, durationSeconds);
  }
}
