import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { type MediaPreparationJob, type MediaPreparationQueue } from '../domain/media-preparation.js';
import type { MediaWorkerConfig } from '../infrastructure/media-config.js';
import type { SquarePreparation } from '../integrations/ffmpeg/square-preparation.js';
import { validatePreparationJob, type PreparationStorage } from '../integrations/s3/preparation-storage.js';
import { timed } from '../observability/timing.js';

export class MediaPreparationWorker {
  constructor(private readonly config: MediaWorkerConfig, private readonly queue: MediaPreparationQueue,
    private readonly storage: Pick<PreparationStorage, 'download' | 'upload' | 'discard'>,
    private readonly encoder: Pick<SquarePreparation, 'probe' | 'convert' | 'verify'>, private readonly log: FastifyBaseLogger) {}

  // Exactly one in-flight conversion per worker process. The database lease prevents duplicate claims.
  async once(signal?: AbortSignal): Promise<boolean> {
    const job = await timed(this.log, 'preparation_job_claim', {}, () => this.queue.claim(), 'debug');
    if (!job) return false;
    const context = { assetId: job.asset_id, generation: job.generation, attempt: job.attempt };
    let directory: string | undefined;
    let uploadAttempted = false;
    let callbackAttempted = false;
    let validated = false;
    try {
      validatePreparationJob(job, this.config.outputBucket, this.config.sourceBuckets);
      validated = true;
      this.log.info({ ...context, event: 'adaptive_media_timing', stage: 'queue_wait', outcome: 'completed',
        startedAt: job.requested_at, endedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - Date.parse(job.requested_at)) }, 'Media queue wait');
      await timed(this.log, 'media_preparation_total', context, async () => {
        if (signal?.aborted) throw new Error('Worker stopping');
        await mkdir(this.config.directory, { recursive: true });
        directory = await mkdtemp(path.join(this.config.directory, 'job-'));
        const input = path.join(directory, 'source.mp4');
        const output = path.join(directory, 'prepared.mp4');
        await timed(this.log, 'preparation_s3_download', context, () => this.storage.download(job, input, signal));
        const probe = await timed(this.log, 'preparation_input_probe', context, () => this.encoder.probe(input, signal));
        await timed(this.log, 'preparation_ffmpeg_conversion', context,
          () => this.encoder.convert(input, output, probe, job.crop_x, job.crop_y, signal, job.media_profile));
        const duration = await timed(this.log, 'preparation_output_verify', context, () => this.encoder.verify(output, signal, job.media_profile));
        if (!await timed(this.log, 'preparation_lease_check', context, () => this.queue.current(job))) {
          this.log.info({ ...context, event: 'adaptive_media_superseded' }, 'Obsolete conversion skipped');
          return;
        }
        uploadAttempted = true;
        await timed(this.log, 'preparation_s3_upload', context, () => this.storage.upload(job, output, signal));
        callbackAttempted = true;
        const accepted = await timed(this.log, 'preparation_laravel_activation', context, () => this.complete(job, duration));
        if (!accepted) await this.discard(job);
        this.log.info({ ...context, event: 'adaptive_media_result', outcome: accepted ? 'ready' : 'superseded', mediaProfile: job.media_profile }, 'Media preparation result');
      });
    } catch (error) {
      this.log.warn({ ...context, event: 'adaptive_media_failed', errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Media preparation will retry or fail');
      // Never delete an output when a completion response is ambiguous: Laravel may already have activated it.
      if (validated && uploadAttempted && !callbackAttempted) await this.discard(job);
      try { await this.queue.fail(job); }
      catch { this.log.warn({ ...context, event: 'adaptive_media_report_deferred' }, 'Media lease will recover after API outage'); }
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
    return true;
  }

  private async complete(job: MediaPreparationJob, duration: number): Promise<boolean> {
    // Completion is idempotent. Retry the callback rather than encoding again after a lost response.
    for (let attempt = 0; ; attempt++) {
      try { return await this.queue.complete(job, { output_key: job.output_key, media_profile: job.media_profile,
        width: 800, height: 800, duration_seconds: duration }); }
      catch (error) { if (attempt >= 2) throw error; }
    }
  }

  private async discard(job: MediaPreparationJob): Promise<void> {
    try { await this.storage.discard(job); }
    catch { this.log.warn({ assetId: job.asset_id, generation: job.generation, event: 'adaptive_media_cleanup_failed' }, 'Unreferenced output cleanup failed'); }
  }
}
