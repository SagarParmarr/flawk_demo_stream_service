import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { MediaPreparationWorker } from '../src/application/media-preparation-worker.js';
import type { MediaPreparationJob, MediaPreparationQueue } from '../src/domain/media-preparation.js';
import type { MediaWorkerConfig } from '../src/infrastructure/media-config.js';
import { preparationArgs } from '../src/integrations/ffmpeg/square-preparation.js';
import { validatePreparationJob, PreparationStorage } from '../src/integrations/s3/preparation-storage.js';
import { MediaPreparationClient } from '../src/integrations/laravel/media-preparation-client.js';

const job: MediaPreparationJob = {
  asset_id: 123, generation: '12345678-1234-4234-8234-123456789abc', token: '23456789-1234-4234-8234-123456789abc',
  attempt: 1, requested_at: new Date(Date.now() - 5000).toISOString(), source_s3_uri: 's3://allowed/original.mp4',
  output_bucket: 'allowed', output_key: 'flawk_cms/adaptive_assets/123/prepared/square800-v1/12345678-1234-4234-8234-123456789abc-23456789-1234-4234-8234-123456789abc.mp4',
  crop_x: 0.8, crop_y: 0.1, media_profile: 'square800-v1',
};

test('untrusted jobs cannot choose arbitrary S3 buckets or output paths', () => {
  assert.doesNotThrow(() => validatePreparationJob(job, 'allowed', ['allowed']));
  for (const mutation of [{ output_bucket: 'other' }, { output_key: 'active/overwrite.mp4' }, { output_key: job.output_key.replace('flawk_cms/adaptive_assets/', 'adaptive-assets/') }, { crop_x: NaN },
    { source_s3_uri: 's3://other/private.mp4' }, { token: '../file' }, { crop_y: -0.2 }]) {
    assert.throws(() => validatePreparationJob({ ...job, ...mutation }, 'allowed', ['allowed']));
  }
});

async function fixture(options: { current?: boolean; accepted?: boolean; failConversion?: boolean; callbackFailure?: boolean; lostFirstCallback?: boolean; copyProfile?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'node-media-test-'));
  const config: MediaWorkerConfig = { laravelBaseUrl: 'https://cms.test', secret: 'secret', outputBucket: 'allowed', sourceBuckets: ['allowed'],
    directory, aws: 'aws', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', pollIntervalMs: 2000, threads: 2 };
  const calls: string[] = [];
  const entries: Record<string, unknown>[] = [];
  const log = { debug: (entry: Record<string, unknown>) => entries.push(entry), info: (entry: Record<string, unknown>) => entries.push(entry), warn: (entry: Record<string, unknown>) => entries.push(entry) } as unknown as FastifyBaseLogger;
  let callbacks = 0;
  const queue: MediaPreparationQueue = {
    claim: async () => options.copyProfile ? {...structuredClone(job),media_profile:'square800-copy-v2',output_key:job.output_key.replace('square800-v1','square800-copy-v2')} : structuredClone(job), current: async () => options.current ?? true,
    complete: async (_job, result) => {
      calls.push('complete'); callbacks++;
      assert.equal(result.duration_seconds, 3.25); assert.equal(result.media_profile, options.copyProfile ? 'square800-copy-v2' : 'square800-v1');
      if (options.callbackFailure || (options.lostFirstCallback && callbacks === 1)) throw new Error('SECRET_CALLBACK_TOKEN');
      return options.accepted ?? true;
    },
    fail: async () => { calls.push('fail'); },
  };
  const storage = { download: async () => { calls.push('download'); }, upload: async () => { calls.push('upload'); },
    discard: async () => { calls.push('discard'); } };
  const encoder = {
    probe: async () => { calls.push('probe'); return {}; },
    convert: async (_input: string, _output: string, _probe: unknown, cropX: number, cropY: number, _signal?: AbortSignal, profile?: string) => {
      assert.equal(profile,options.copyProfile ? 'square800-copy-v2' : 'square800-v1');
      calls.push('convert'); assert.equal(cropX, job.crop_x); assert.equal(cropY, job.crop_y);
      if (options.failConversion) throw new Error('SECRET_FFMPEG_COMMAND');
    },
    verify: async () => { calls.push('verify'); return 3.25; },
  };
  const worker = new MediaPreparationWorker(config, queue, storage, encoder, log);
  try {
    await worker.once();
    assert.deepEqual(await readdir(directory), []);
    assert.ok(!JSON.stringify(entries).includes('SECRET_'));
    return { calls, entries };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('preparation verifies before upload and activation, with correlated stage timing', async () => {
  const { calls, entries } = await fixture();
  assert.deepEqual(calls, ['download', 'probe', 'convert', 'verify', 'upload', 'complete']);
  assert.ok(entries.some(e => e.event === 'adaptive_media_result' && e.outcome === 'ready'));
  for (const stage of ['preparation_s3_download', 'preparation_input_probe', 'preparation_ffmpeg_conversion', 'preparation_output_verify', 'preparation_s3_upload', 'preparation_laravel_activation']) {
    assert.ok(entries.some(e => e.stage === stage && e.outcome === 'completed' && e.generation === job.generation && typeof e.durationMs === 'number'));
  }
});

test('a new crop/deletion during conversion prevents obsolete upload', async () => {
  const { calls } = await fixture({ current: false });
  assert.deepEqual(calls, ['download', 'probe', 'convert', 'verify']);
});

test('superseded completion discards only the obsolete uploaded output', async () => {
  const { calls } = await fixture({ accepted: false });
  assert.deepEqual(calls.slice(-3), ['upload', 'complete', 'discard']);
});

test('lost completion response retries activation without re-encoding or deleting playable output', async () => {
  const { calls } = await fixture({ lostFirstCallback: true });
  assert.equal(calls.filter(c => c === 'convert').length, 1);
  assert.equal(calls.filter(c => c === 'complete').length, 2);
  assert.ok(!calls.includes('discard') && !calls.includes('fail'));
});

test('ambiguous completion never deletes a possibly activated output', async () => {
  const { calls } = await fixture({ callbackFailure: true });
  assert.equal(calls.filter(c => c === 'complete').length, 3);
  assert.ok(calls.includes('fail') && !calls.includes('discard'));
});

test('conversion failure reports retry without uploading an invalid file', async () => {
  const { calls } = await fixture({ failConversion: true });
  assert.deepEqual(calls, ['download', 'probe', 'convert', 'fail']);
});

test('preparation uses chosen square crop, CBR H264/AAC, bounded threads and MP4 faststart', () => {
  const args = preparationArgs('/in.mp4', '/out.mp4', false, 3.25, 0.8, 0.1);
  assert.ok(args.includes('anullsrc=channel_layout=stereo:sample_rate=44100'));
  assert.ok(args[args.indexOf('-vf') + 1]?.includes('crop=800:800:(iw-ow)*0.800000:(ih-oh)*0.100000'));
  assert.ok(!args.join(' ').includes('pad=') && !args.includes('-re'));
  assert.equal(args[args.indexOf('-threads') + 1], '2');
  assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
  assert.throws(() => preparationArgs('/in', '/out', true, 0, 0.5, 0.5));
});

test('Laravel media client uses the protected fixed callback and excludes arbitrary callback URLs', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: unknown; secret: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: JSON.parse(String(init?.body)), secret: new Headers(init?.headers).get('X-Demo-Stream-Secret') });
    return new Response(JSON.stringify({ data: url.endsWith('/claim') ? { job } : { current: true, accepted: true } }));
  };
  try {
    const client = new MediaPreparationClient('https://cms.test', 'managed-secret');
    assert.deepEqual(await client.claim(), job);
    assert.equal(await client.current(job), true);
    assert.equal(await client.complete(job, { output_key: job.output_key, media_profile: 'square800-v1', width: 800, height: 800, duration_seconds: 3.25 }), true);
    assert.ok(requests.every(r => r.url.startsWith('https://cms.test/api/internal/demo-media/') && r.secret === 'managed-secret'));
    assert.deepEqual(requests[1]?.body, { asset_id: job.asset_id, generation: job.generation, token: job.token });
  } finally { globalThis.fetch = originalFetch; }
});

test('S3 preparation checks size, uploads profile metadata and verifies it before completion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'media-s3-test-'));
  try {
    const binary = path.join(directory, 'aws');
    const calls = path.join(directory, 'calls.jsonl');
    const markerFile = path.join(directory, 'marker');
    const sizeFile = path.join(directory, 'size');
    await writeFile(markerFile, 'square800-v1'); await writeFile(sizeFile, '7');
    await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='s3api'&&args[1]==='head-object'){process.stdout.write(JSON.stringify({ContentLength:Number(fs.readFileSync(${JSON.stringify(sizeFile)},'utf8')),Metadata:{'media-profile':fs.readFileSync(${JSON.stringify(markerFile)},'utf8')}}));}else if(args[0]==='s3'&&args[2].startsWith('s3://')){fs.writeFileSync(args[3],'fixture');}\n`);
    await chmod(binary, 0o755);
    const storage = new PreparationStorage(binary);
    const local = path.join(directory, 'source.mp4');
    await storage.download(job, local);
    assert.equal(await readFile(local, 'utf8'), 'fixture');
    await storage.upload(job, local);
    const argumentsList: string[][] = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const upload = argumentsList.find(args => args[0] === 's3' && args[2] === local)!;
    assert.equal(upload[3], `s3://${job.output_bucket}/${job.output_key}`);
    assert.equal(upload[upload.indexOf('--metadata') + 1], 'media-profile=square800-v1');
    await writeFile(markerFile, 'missing');
    await assert.rejects(storage.upload(job, local), /marker/);
    await writeFile(sizeFile, String(101 * 1024 * 1024));
    await assert.rejects(storage.download(job, local), /size limit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('explicit v2 jobs select the new encoder profile and report the same profile to CMS', async () => {
  const {calls}=await fixture({copyProfile:true});
  assert.ok(calls.includes('complete') && !calls.includes('fail'));
});
