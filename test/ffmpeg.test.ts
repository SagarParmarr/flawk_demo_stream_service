import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestUrl } from '../src/integrations/ffmpeg/process.js';

const ingest = {
  ingest_server: 'example.global-contribute.live-video.net',
  stream_key: 'sk_test/key',
};

test('initial IVS publisher omits takeover priority', () => {
  assert.equal(
    ingestUrl(ingest, 0),
    'rtmps://example.global-contribute.live-video.net:443/app/sk_test%2Fkey',
  );
});

test('replacement IVS publisher uses a positive takeover priority', () => {
  assert.equal(
    ingestUrl(ingest, 2),
    'rtmps://example.global-contribute.live-video.net:443/app/sk_test%2Fkey?priority=2',
  );
});

import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { FfmpegFactory } from '../src/integrations/ffmpeg/process.js';

test('publisher logs first encoded frame once and drains sensitive stderr', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'demo-progress-'));
  let publisher;
  try {
    const binary = path.join(directory, 'fake-ffmpeg');
    await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nprocess.stderr.write('SECRET_STREAM_KEY');\nfs.writeSync(3, 'frame=0\\nframe=1\\nframe=2\\n');\nsetInterval(() => {}, 1000);\n`);
    await chmod(binary, 0o755);
    const entries: Record<string, unknown>[] = [];
    const log = { info: (entry: Record<string, unknown>) => entries.push(entry) } as unknown as FastifyBaseLogger;
    publisher = await new FfmpegFactory(binary, log).start('/fake.mp4', true, 5, ingest, 1, { demoId: 'demo-progress', decisionId: 'choice-one' });
    const deadline = Date.now() + 2000;
    while (!entries.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const frames = entries.filter((entry) => entry.stage === 'ffmpeg_first_encoded_frame');
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.demoId, 'demo-progress');
    assert.equal(frames[0]?.decisionId, 'choice-one');
    assert.ok(Number(frames[0]?.durationMs) >= 0);
    await publisher.stop();
    assert.ok(entries.some((entry) => entry.event === 'demo_publisher_exit' && entry.firstFrameObserved === true));
    assert.ok(!JSON.stringify(entries).includes('SECRET_STREAM_KEY'));
  } finally {
    await publisher?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
