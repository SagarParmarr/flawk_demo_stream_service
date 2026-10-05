import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { SQUARE_PROFILE, COPY_PROFILE, type MediaPreparationJob } from '../../domain/media-preparation.js';

const execute = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function validatePreparationJob(job: MediaPreparationJob, outputBucket: string, sourceBuckets: string[]): void {
  const source = /^s3:\/\/([^/]+)\/(.+\.mp4)$/i.exec(job.source_s3_uri);
  if (!Number.isSafeInteger(job.asset_id) || job.asset_id < 1 || !uuid.test(job.generation) || !uuid.test(job.token)
    || ![SQUARE_PROFILE, COPY_PROFILE].includes(job.media_profile) || job.output_bucket !== outputBucket
    || !source || !sourceBuckets.includes(source[1]!) || job.source_s3_uri.includes('\0')
    || job.output_key !== `flawk_cms/adaptive_assets/${job.asset_id}/prepared/${job.media_profile}/${job.generation}-${job.token}.mp4`
    || ![job.crop_x, job.crop_y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)
    || !Number.isInteger(job.attempt) || job.attempt < 1 || job.attempt > 3
    || !Number.isFinite(Date.parse(job.requested_at))) throw new Error('Invalid media preparation job');
}

export class PreparationStorage {
  constructor(private readonly aws: string) {}

  async download(job: MediaPreparationJob, destination: string, signal?: AbortSignal): Promise<void> {
    const source = /^s3:\/\/([^/]+)\/(.+)$/.exec(job.source_s3_uri)!;
    const { stdout } = await execute(this.aws, ['s3api', 'head-object', '--bucket', source[1]!, '--key', source[2]!, '--output', 'json'],
      { timeout: 15000, signal });
    const size = Number((JSON.parse(stdout) as { ContentLength: number }).ContentLength);
    if (!Number.isFinite(size) || size < 1 || size > 100 * 1024 * 1024) throw new Error('MP4 exceeds preparation size limit');
    await execute(this.aws, ['s3', 'cp', job.source_s3_uri, destination, '--no-progress'],
      { timeout: 120000, maxBuffer: 1024 * 1024, signal });
    if ((await stat(destination)).size > 100 * 1024 * 1024) throw new Error('Downloaded MP4 exceeds preparation size limit');
  }

  async upload(job: MediaPreparationJob, input: string, signal?: AbortSignal): Promise<void> {
    await execute(this.aws, ['s3', 'cp', input, `s3://${job.output_bucket}/${job.output_key}`, '--no-progress',
      '--content-type', 'video/mp4', '--metadata', `media-profile=${job.media_profile}`],
    { timeout: 120000, maxBuffer: 1024 * 1024, signal });
    const { stdout } = await execute(this.aws, ['s3api', 'head-object', '--bucket', job.output_bucket, '--key', job.output_key, '--output', 'json'],
      { timeout: 15000, signal });
    if ((JSON.parse(stdout) as { Metadata?: Record<string, string> }).Metadata?.['media-profile'] !== job.media_profile) {
      throw new Error('Uploaded media profile marker is missing');
    }
  }

  async discard(job: MediaPreparationJob): Promise<void> {
    await execute(this.aws, ['s3api', 'delete-object', '--bucket', job.output_bucket, '--key', job.output_key], { timeout: 15000 });
  }
}
