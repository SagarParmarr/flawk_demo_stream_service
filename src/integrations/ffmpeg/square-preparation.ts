import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MediaProbe } from '../s3/media-cache.js';
import { verifySquareProfile } from '../s3/media-cache.js';

const execute = promisify(execFile);

export function preparationArgs(input: string, output: string, hasAudio: boolean, duration: number,
  cropX: number, cropY: number, threads = 2): string[] {
  if (![cropX, cropY].every(v => Number.isFinite(v) && v >= 0 && v <= 1)
    || !Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('Invalid media preparation parameters');
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', input,
    ...(!hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'] : []),
    '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0', '-map_metadata', '-1',
    '-vf', `scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=800:800:force_original_aspect_ratio=increase:out_range=tv,crop=800:800:(iw-ow)*${cropX.toFixed(6)}:(ih-oh)*${cropY.toFixed(6)},setsar=1,fps=30`,
    '-filter_threads', String(threads), '-threads', String(threads), '-r', '30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-profile:v', 'main', '-preset', 'veryfast',
    '-b:v', '3000k', '-minrate', '3000k', '-maxrate', '3000k', '-bufsize', '3000k',
    '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '44100', '-af', 'aresample=async=1:first_pts=0,apad',
    '-t', String(duration), '-movflags', '+faststart', '-f', 'mp4', output];
}

export class SquarePreparation {
  constructor(private readonly ffmpeg: string, private readonly ffprobe: string, private readonly threads = 2) {}

  async probe(input: string, signal?: AbortSignal): Promise<MediaProbe> {
    const { stdout } = await execute(this.ffprobe,
      ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', input],
      { timeout: 30000, maxBuffer: 1024 * 1024, signal });
    const probe = JSON.parse(stdout) as MediaProbe;
    const video = probe.streams?.find(s => s.codec_type === 'video');
    const duration = Number(video?.duration ?? probe.format?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || duration > 3600
      || !(Number(video.width) > 0 && Number(video.height) > 0)) throw new Error('Unsupported input video');
    return probe;
  }

  async convert(input: string, output: string, probe: MediaProbe, cropX: number, cropY: number, signal?: AbortSignal): Promise<void> {
    const video = probe.streams?.find(s => s.codec_type === 'video');
    await execute(this.ffmpeg, preparationArgs(input, output, probe.streams?.some(s => s.codec_type === 'audio') ?? false,
      Number(video?.duration ?? probe.format?.duration), cropX, cropY, this.threads),
    { timeout: 900000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', signal });
  }

  async verify(input: string, signal?: AbortSignal): Promise<number> {
    const probe = await this.probe(input, signal);
    const { stdout } = await execute(this.ffprobe,
      ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,flags', '-of', 'json', input],
      { timeout: 60000, maxBuffer: 16 * 1024 * 1024, signal });
    const packets = JSON.parse(stdout) as { packets: Array<{ pts_time: string; flags: string }> };
    verifySquareProfile(probe, packets.packets.filter(p => p.flags.includes('K')).map(p => Number(p.pts_time)));
    return Number(probe.streams?.find(s => s.codec_type === 'video')?.duration ?? probe.format?.duration);
  }
}
