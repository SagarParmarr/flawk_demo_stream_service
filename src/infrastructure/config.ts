import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  laravelBaseUrl: string;
  nodeBaseUrl: string;
  laravelSecret: string;
  nodeSecret: string;
  defaultS3Uri: string;
  databasePath: string;
  cacheDirectory: string;
  ffmpegPath: string;
  ffprobePath: string;
  awsPath: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  maxDemoDurationMs: number;
  selectedAssetHoldSeconds: number;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const integer = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
};

export function loadConfig(): Config {
  const laravelSecret = required('DEMO_STREAM_SERVICE_SECRET');
  const nodeSecret = required('GO_LIVE_ADAPTIVE_INTERNAL_SECRET');
  if (laravelSecret.length < 32 || nodeSecret.length < 32) throw new Error('Internal secrets must contain at least 32 characters');
  const laravelBaseUrl = required('LARAVEL_API_BASE_URL');
  const nodeBaseUrl = required('GO_LIVE_API_BASE_URL');
  for (const url of [laravelBaseUrl, nodeBaseUrl]) {
    if (new URL(url).protocol !== 'https:') throw new Error('Upstream APIs must use HTTPS');
  }
  const defaultS3Uri = required('ADAPTIVE_DEFAULT_ASSET_S3_URI');
  if (!/^s3:\/\/[^/]+\/.+/.test(defaultS3Uri)) throw new Error('Default asset must be an S3 URI');
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port: integer('PORT', 4180, 1, 65535),
    laravelBaseUrl,
    nodeBaseUrl,
    laravelSecret,
    nodeSecret,
    defaultS3Uri,
    databasePath: path.resolve(process.env.DATABASE_PATH ?? './data/demo.sqlite'),
    cacheDirectory: path.resolve(process.env.ASSET_CACHE_DIRECTORY ?? './cache'),
    ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
    awsPath: process.env.AWS_PATH ?? 'aws',
    pollIntervalMs: integer('POLL_INTERVAL_MS', 2000, 500, 30000),
    heartbeatIntervalMs: integer('HEARTBEAT_INTERVAL_MS', 30000, 5000, 60000),
    maxDemoDurationMs: integer('MAX_DEMO_DURATION_MS', 1800000, 60000, 1800000),
    selectedAssetHoldSeconds: integer('SELECTED_ASSET_HOLD_SECONDS', 30, 20, 30),
  };
}
