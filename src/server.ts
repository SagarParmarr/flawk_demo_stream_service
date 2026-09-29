import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import { registerRoutes } from './api/routes.js';
import { DemoService } from './application/demo-service.js';
import { FfmpegFactory } from './integrations/ffmpeg/process.js';
import { GoLiveClient } from './integrations/go-live/client.js';
import { LaravelClient } from './integrations/laravel/client.js';
import { MediaCache } from './integrations/s3/media-cache.js';
import { loadConfig } from './infrastructure/config.js';
import { SqliteDemoRepository } from './infrastructure/sqlite-repository.js';

const config = loadConfig();
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info',
  redact: ['req.headers.authorization', 'req.headers.x-adaptive-secret', 'req.headers.x-demo-stream-secret'] } });
const repository = new SqliteDemoRepository(config.databasePath);
const service = new DemoService(config, repository,
  new LaravelClient(config.laravelBaseUrl, config.laravelSecret),
  new GoLiveClient(config.nodeBaseUrl, config.nodeSecret),
  new MediaCache(config.cacheDirectory, config.awsPath, config.ffprobePath, app.log),
  new FfmpegFactory(config.ffmpegPath, app.log), app.log);
let ready = false;
registerRoutes(app, service, () => ready);

try {
  for (const binary of [config.ffmpegPath, config.ffprobePath, config.awsPath]) {
    if (binary.includes('/')) await access(binary, constants.X_OK);
    const checked = spawnSync(binary, [binary === config.awsPath ? '--version' : '-version'], { timeout: 5000, stdio: 'ignore' });
    if (checked.error || checked.status !== 0) throw new Error(`Required binary is unavailable: ${binary}`);
  }
  await mkdir(config.cacheDirectory, { recursive: true });
  await access(config.cacheDirectory, constants.W_OK);
  await service.recover();
  ready = true;
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Demo service failed to start');
  process.exitCode = 1;
}

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    void (async () => {
      await service.shutdown();
      await app.close();
      repository.close();
      process.exit(0);
    })().catch((error) => {
      app.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Demo shutdown failed');
      process.exit(1);
    });
  });
}
