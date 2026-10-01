import type { FastifyBaseLogger } from 'fastify';
import type { PreparedMedia } from '../../domain/demo.js';
import { timed, type TimingContext } from '../../observability/timing.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export type { PreparedMedia } from '../../domain/demo.js';
export interface MediaProbe {
  streams?: Array<{ codec_type: string; codec_name?: string; profile?: string; width?: number; height?: number;
    pix_fmt?: string; sample_aspect_ratio?: string; avg_frame_rate?: string; r_frame_rate?: string;
    sample_rate?: string; channels?: number; duration?: string; bit_rate?: string;
    tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number }> }>;
  format?: { duration?: string };
}
export function verifySquareProfile(probe: MediaProbe, keyframes: number[]): void {
  const video = probe.streams?.find(s => s.codec_type === 'video');
  const audio = probe.streams?.find(s => s.codec_type === 'audio');
  const duration = Number(video?.duration ?? probe.format?.duration);
  const audioDuration = Number(audio?.duration);
  if (video?.codec_name !== 'h264' || video.profile !== 'Main' || video.width !== 800 || video.height !== 800
    || video.pix_fmt !== 'yuv420p' || video.sample_aspect_ratio !== '1:1'
    || !['30/1', '60/2'].includes(video.avg_frame_rate ?? '') || video.r_frame_rate !== '30/1'
    || !Number.isFinite(Number(video.bit_rate)) || Number(video.bit_rate) > 3500000 || Number(video.bit_rate) <= 0
    || Number(video.tags?.rotate ?? 0) !== 0 || video.side_data_list?.some(s => Number(s.rotation ?? 0) !== 0)
    || audio?.codec_name !== 'aac' || audio.profile !== 'LC' || audio.channels !== 2 || audio.sample_rate !== '44100'
    || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(audioDuration) || Math.abs(audioDuration - duration) > 0.15
    || keyframes.length === 0 || keyframes.some(t => !Number.isFinite(t)) || Math.abs(keyframes[0]!) > 0.1
    || keyframes.some((t, i) => i > 0 && (t <= keyframes[i - 1]! || t - keyframes[i - 1]! > 2.1))
    || duration - keyframes.at(-1)! > 2.1) throw new Error('Prepared asset does not match square800-v1');
}

export class MediaCache {
  constructor(private readonly directory: string, private readonly aws: string, private readonly ffprobe: string, private readonly log?: FastifyBaseLogger) {}

  async prepare(uri: string, version: string, context: TimingContext = {}, expectedProfile?: string | null): Promise<PreparedMedia> {
    const match = /^s3:\/\/([^/]+)\/(.+\.mp4)$/i.exec(uri);
    if (!match || uri.includes('\0')) throw new Error('Only S3 MP4 assets are supported');
    await mkdir(this.directory, { recursive: true });
    const { stdout: head } = await timed(this.log, 's3_metadata', context, () => execute(this.aws,
      ['s3api', 'head-object', '--bucket', match[1]!, '--key', match[2]!, '--output', 'json'], { timeout: 15000 }));
    const metadata = JSON.parse(head) as { ETag?: string; ContentLength?: number; LastModified?: string; Metadata?: Record<string, string> };
    const mediaProfile = metadata.Metadata?.['media-profile'] ?? null;
    if (expectedProfile && (expectedProfile !== 'square800-v1' || mediaProfile !== expectedProfile)) {
      throw new Error('Prepared asset profile marker is missing or unsupported');
    }
    if (mediaProfile && mediaProfile !== 'square800-v1') throw new Error('Unsupported prepared asset profile');
    const cacheVersion = version === 'default' ? `${metadata.ETag}:${metadata.ContentLength}:${metadata.LastModified}` : version;
    const filename = `${createHash('sha256').update(`${uri}\0${cacheVersion}`).digest('hex')}.mp4`;
    const destination = path.join(this.directory, filename);
    try { await access(destination); this.log?.info?.({ ...context, event: 'demo_media_cache', cacheHit: true }, 'Demo asset cache hit'); }
    catch {
      const partial = `${destination}.${randomUUID()}.partial`;
      try {
        this.log?.info?.({ ...context, event: 'demo_media_cache', cacheHit: false }, 'Demo asset cache miss');
        await timed(this.log, 's3_download', context, () => execute(this.aws, ['s3', 'cp', uri, partial, '--no-progress'], { timeout: 120000, maxBuffer: 1024 * 1024 }));
        await rename(partial, destination);
      } finally { await rm(partial, { force: true }); }
    }
    const { stdout } = await timed(this.log, 'media_probe', context, () => execute(this.ffprobe,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', destination], { timeout: 15000 }));
    const probe = JSON.parse(stdout) as MediaProbe;
    if (!probe.streams?.some(s => s.codec_type === 'video')) throw new Error('Asset has no video track');
    const durationSeconds = Number(probe.streams.find(s => s.codec_type === 'video')?.duration ?? probe.format?.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Asset duration is unavailable');
    if (mediaProfile === 'square800-v1') {
      const { stdout: packetJson } = await timed(this.log, 'media_profile_verify', context, () => execute(this.ffprobe,
        ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,flags', '-of', 'json', destination],
        { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }));
      const packets = JSON.parse(packetJson) as { packets: Array<{ pts_time: string; flags: string }> };
      verifySquareProfile(probe, packets.packets.filter(p => p.flags.includes('K')).map(p => Number(p.pts_time)));
    }
    const publishMode = mediaProfile === 'square800-v1' ? 'copy' : 'encode';
    this.log?.info?.({ ...context, event: 'demo_media_ready', publishMode, mediaProfile, durationSeconds }, 'Demo asset verified');
    return { path: destination, hasAudio: probe.streams.some(s => s.codec_type === 'audio'), durationSeconds, publishMode, mediaProfile };
  }
}
