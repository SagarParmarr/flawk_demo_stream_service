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
    while (!entries.some(entry => entry.stage === 'ffmpeg_first_encoded_frame') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
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

import { ffmpegArgs } from '../src/integrations/ffmpeg/process.js';
import { verifySquareProfile, type MediaProbe } from '../src/integrations/s3/media-cache.js';

test('prepared publisher copies both tracks without filtering or encoding options', () => {
  const args = ffmpegArgs('/prepared.mp4', 'rtmps://example.test', true, 'copy');
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  for (const option of ['-vf', '-af', '-r', '-g', '-b:v', '-profile:v']) assert.ok(!args.includes(option));
  assert.ok(args.includes('-re') && args.includes('-stream_loop'));
});

test('legacy fallback fills and crops to a square, with silent audio when absent', () => {
  const args = ffmpegArgs('/legacy.mp4', 'rtmps://example.test', false);
  assert.ok(args[args.indexOf('-vf') + 1]?.includes('crop=800:800'));
  assert.ok(!args.join(' ').includes('pad=') && !args.join(' ').includes('1280:720'));
  assert.ok(args.some(arg => arg.includes('anullsrc')));
});

const validProbe: MediaProbe = { format: { duration: '5' }, streams: [
  { codec_type: 'video', codec_name: 'h264', profile: 'Main', width: 800, height: 800,
    pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1', avg_frame_rate: '30/1', r_frame_rate: '30/1', duration: '5', bit_rate: '3000000' },
  { codec_type: 'audio', codec_name: 'aac', profile: 'LC', sample_rate: '44100', channels: 2, duration: '5' },
] };

test('profile verification rejects wrong shape, missing audio and excessive keyframe spacing', () => {
  assert.doesNotThrow(() => verifySquareProfile(validProbe, [0, 2, 4]));
  const wrong = structuredClone(validProbe); wrong.streams![0]!.width = 1280;
  assert.throws(() => verifySquareProfile(wrong, [0, 2, 4]));
  assert.throws(() => verifySquareProfile({ ...validProbe, streams: validProbe.streams?.slice(0, 1) }, [0, 2, 4]));
  assert.throws(() => verifySquareProfile(validProbe, [0, 4]));
  assert.throws(() => verifySquareProfile(validProbe, [0, Number.NaN]));
  const rotated = structuredClone(validProbe); rotated.streams![0]!.side_data_list = [{ rotation: 90 }];
  assert.throws(() => verifySquareProfile(rotated, [0, 2, 4]));
});

test('optional IVS keyframe parameter preserves takeover priority and validates bounds', () => {
  assert.ok(ingestUrl(ingest, 2, 2).endsWith('?priority=2&keyframeInterval=2'));
  assert.ok(ingestUrl(ingest, 0, 2).endsWith('?keyframeInterval=2'));
  assert.throws(() => ingestUrl(ingest, 2, 1));
  assert.throws(() => ffmpegArgs('/missing-audio.mp4', 'rtmps://example.test', false, 'copy'));
});

import { MediaCache } from '../src/integrations/s3/media-cache.js';

test('S3 marker and local verification must both succeed before copy mode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'demo-media-profile-'));
  try {
    const aws = path.join(directory, 'aws');
    const probe = path.join(directory, 'ffprobe');
    await writeFile(aws, `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] === 's3api') { const key = process.argv[process.argv.indexOf('--key')+1]; process.stdout.write(JSON.stringify({ETag:'one',ContentLength:1,Metadata:key.includes('raw')?{}:{'media-profile':'square800-v1'}})); } else fs.writeFileSync(process.argv[5], 'fixture');\n`);
    await writeFile(probe, `#!${process.execPath}\nconst fs = require('node:fs');\nprocess.stdout.write(JSON.stringify(process.argv.includes('-show_packets')?{packets:[{pts_time:'0',flags:'K_'},{pts_time:'2',flags:'K_'},{pts_time:'4',flags:'K_'}]}:${JSON.stringify(validProbe)}));\n`);
    await chmod(aws, 0o755); await chmod(probe, 0o755);
    const cache = new MediaCache(path.join(directory, 'cache'), aws, probe);
    assert.equal((await cache.prepare('s3://bucket/prepared.mp4', 'one', {}, 'square800-v1')).publishMode, 'copy');
    assert.equal((await cache.prepare('s3://bucket/raw.mp4', 'one')).publishMode, 'encode');
    await assert.rejects(cache.prepare('s3://bucket/raw.mp4', 'two', {}, 'square800-v1'), /marker/);
    const invalid = structuredClone(validProbe); invalid.streams![0]!.height = 720;
    await writeFile(probe, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.includes('-show_packets')?{packets:[{pts_time:'0',flags:'K_'}]}:${JSON.stringify(invalid)}));\n`);
    await assert.rejects(cache.prepare('s3://bucket/prepared.mp4', 'two', {}, 'square800-v1'), /square800/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('very short prepared clips may have low startup average bitrate', () => {
  const probe = structuredClone(validProbe);
  probe.streams![0]!.duration = '0.1'; probe.streams![0]!.bit_rate = '83440';
  probe.streams![1]!.duration = '0.1'; probe.format!.duration = '0.1';
  assert.doesNotThrow(() => verifySquareProfile(probe, [0]));
  probe.streams![0]!.bit_rate = 'invalid';
  assert.throws(() => verifySquareProfile(probe, [0]));
});
