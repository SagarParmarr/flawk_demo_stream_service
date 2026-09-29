import type { FastifyBaseLogger } from 'fastify';
import { timed, type TimingContext } from '../../observability/timing.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export interface PreparedMedia { path: string; hasAudio: boolean; durationSeconds: number }

export class MediaCache {
  constructor(private readonly directory: string, private readonly aws: string, private readonly ffprobe: string, private readonly log?: FastifyBaseLogger) {}

  async prepare(uri: string, version: string, context: TimingContext = {}): Promise<PreparedMedia> {
    const match = /^s3:\/\/([^/]+)\/(.+\.mp4)$/i.exec(uri);
    if (!match || uri.includes('\0')) throw new Error('Only S3 MP4 assets are supported');
    await mkdir(this.directory, { recursive: true });
    let cacheVersion = version;
    if (version === 'default') {
      const { stdout } = await timed(this.log, 's3_metadata', context, () => execute(this.aws, ['s3api', 'head-object', '--bucket', match[1]!, '--key', match[2]!, '--output', 'json'],
        { timeout: 15000 }));
      const metadata = JSON.parse(stdout) as { ETag?: string; ContentLength?: number; LastModified?: string };
      cacheVersion = `${metadata.ETag ?? ''}:${metadata.ContentLength ?? ''}:${metadata.LastModified ?? ''}`;
    }
    const filename = `${createHash('sha256').update(`${uri}\0${cacheVersion}`).digest('hex')}.mp4`;
    const destination = path.join(this.directory, filename);
    try { await access(destination); this.log?.info?.({ ...context, event: 'demo_media_cache', cacheHit: true }, 'Demo asset cache hit'); }
    catch {
      const partial = `${destination}.${process.pid}.partial`;
      try {
        this.log?.info?.({ ...context, event: 'demo_media_cache', cacheHit: false }, 'Demo asset cache miss');
        await timed(this.log, 's3_download', context, () => execute(this.aws, ['s3', 'cp', uri, partial, '--no-progress'], { timeout: 120000, maxBuffer: 1024 * 1024 }));
        await rename(partial, destination);
      } finally { await rm(partial, { force: true }); }
    }
    const { stdout } = await timed(this.log, 'media_probe', context, () => execute(this.ffprobe,
      ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', destination],
      { timeout: 15000 }));
    const probe = JSON.parse(stdout) as { streams?: { codec_type: string }[]; format?: { duration?: string } };
    if (!probe.streams?.some((stream) => stream.codec_type === 'video')) throw new Error('Asset has no video track');
    const durationSeconds = Number(probe.format?.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Asset duration is unavailable');
    return { path: destination, hasAudio: probe.streams.some((stream) => stream.codec_type === 'audio'), durationSeconds };
  }
}
