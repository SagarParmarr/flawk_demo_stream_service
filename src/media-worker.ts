import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import Fastify from 'fastify';
import { MediaPreparationWorker } from './application/media-preparation-worker.js';
import { loadMediaWorkerConfig } from './infrastructure/media-config.js';
import { SquarePreparation } from './integrations/ffmpeg/square-preparation.js';
import { MediaPreparationClient } from './integrations/laravel/media-preparation-client.js';
import { PreparationStorage } from './integrations/s3/preparation-storage.js';

const config = loadMediaWorkerConfig();
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());

try {
  for (const binary of [config.aws, config.ffmpeg, config.ffprobe]) {
    if (binary.includes('/')) await access(binary, constants.X_OK);
    const check = spawnSync(binary, [binary === config.aws ? '--version' : '-version'], { timeout: 5000, stdio: 'ignore' });
    if (check.error || check.status !== 0) throw new Error('Media binary unavailable');
  }
  await mkdir(config.directory, { recursive: true });
  await access(config.directory, constants.W_OK);
  const worker = new MediaPreparationWorker(config, new MediaPreparationClient(config.laravelBaseUrl, config.secret),
    new PreparationStorage(config.aws), new SquarePreparation(config.ffmpeg, config.ffprobe, config.threads), app.log);
  app.log.info({ event: 'adaptive_media_worker_ready', concurrency: 1, encoderThreads: config.threads }, 'Node media worker started');
  while (!controller.signal.aborted) {
    try { await worker.once(controller.signal); }
    catch (error) { app.log.warn({ event: 'adaptive_media_claim_failed', errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Media queue unavailable'); }
    await setTimeout(config.pollIntervalMs, undefined, { signal: controller.signal }).catch(() => {});
  }
} catch (error) {
  app.log.fatal({ event: 'adaptive_media_worker_start_failed', errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Node media worker failed');
  process.exitCode = 1;
} finally { await app.close(); }
