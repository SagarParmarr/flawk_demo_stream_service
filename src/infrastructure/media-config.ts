import path from 'node:path';

export interface MediaWorkerConfig {
  laravelBaseUrl: string;
  secret: string;
  outputBucket: string;
  sourceBuckets: string[];
  directory: string;
  aws: string;
  ffmpeg: string;
  ffprobe: string;
  pollIntervalMs: number;
  threads: number;
}

export function loadMediaWorkerConfig(): MediaWorkerConfig {
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const laravelBaseUrl = required('LARAVEL_API_BASE_URL').replace(/\/+$/, '');
  const secret = required('DEMO_STREAM_SERVICE_SECRET');
  const api = new URL(laravelBaseUrl);
  const localHttp = api.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
  if ((api.protocol !== 'https:' && !localHttp) || api.username || api.password || api.search || api.hash
    || secret.length < 32) throw new Error('Invalid media worker API configuration');
  const outputBucket = required('MEDIA_OUTPUT_BUCKET');
  const sourceBuckets = (process.env.MEDIA_SOURCE_BUCKETS ?? outputBucket).split(',').map(v => v.trim()).filter(Boolean);
  const pollIntervalMs = Number(process.env.MEDIA_POLL_INTERVAL_MS ?? 2000);
  const threads = Number(process.env.MEDIA_ENCODER_THREADS ?? 2);
  if (!sourceBuckets.length || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 30000
    || !Number.isInteger(threads) || threads < 1 || threads > 8) throw new Error('Invalid media worker limits');
  return { laravelBaseUrl, secret, outputBucket, sourceBuckets,
    directory: path.resolve(process.env.MEDIA_WORK_DIRECTORY ?? './cache/preparation'),
    aws: process.env.AWS_PATH ?? 'aws', ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg', ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe',
    pollIntervalMs, threads };
}
