import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import { DemoService, DemoError } from '../src/application/demo-service.js';
import type { DemoRepository, DemoSession, Publisher } from '../src/domain/demo.js';
import type { Config } from '../src/infrastructure/config.js';
import type { LaravelPort, GoLivePort, MediaPort, PublisherPort } from '../src/domain/ports.js';

class MemoryRepository implements DemoRepository {
  rows = new Map<string, DemoSession>();
  find(id: string) { return structuredClone(this.rows.get(id) ?? null); }
  findActiveByOwner(ownerId: number) { return structuredClone([...this.rows.values()].find((r) => r.ownerId === ownerId && !['failed', 'stopped'].includes(r.status)) ?? null); }
  findByIdempotencyKey(ownerId: number, key: string) { return structuredClone([...this.rows.values()].find((r) => r.ownerId === ownerId && r.idempotencyKey === key) ?? null); }
  listNonterminal() { return [...this.rows.values()].filter((r) => !['failed', 'stopped'].includes(r.status)); }
  create(session: DemoSession) { this.rows.set(session.id, structuredClone(session)); }
  save(session: DemoSession) { this.rows.set(session.id, structuredClone(session)); }
}

class FakePublisher implements Publisher {
  pid = 123;
  startedAt = new Date().toISOString();
  durationSeconds: number | null;
  exit = Promise.resolve(0);
  private running = true;
  constructor(durationSeconds: number) { this.durationSeconds = durationSeconds; }
  alive() { return this.running; }
  async stop() { this.running = false; }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3500;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), 'expected state was not reached');
}

function fixture(decisions: Array<{ decision_id: string; cycle_number: number; result: 'SELECT_ASSET' | 'NO_DECISION'; expires_at: string | null; asset: { id: number; name: string; s3_uri: string } | null }> = [],
  failure?: 'node-create' | 'slow-create' | 'download' | 'takeover') {
  const repo = new MemoryRepository();
  const calls = { created: 0, stoppedNode: 0, stoppedLaravel: 0, publisherStarts: 0, content: [] as string[] };
  let publisherStarts = 0;
  const laravel = {
    validate: async (id: string) => ({ session_id: id, owner_id: 4, unit_ids: [1], state: 'READY_FOR_CAPTURE' }),
    bind: async () => undefined,
    decisions: async () => ({ owner_id: 4, unit_ids: [1], state: 'COMPLETE', decisions }),
    stop: async () => { calls.stoppedLaravel++; },
  } as LaravelPort;
  const node = {
    create: async () => {
      calls.created++;
      if (failure === 'slow-create') await new Promise((resolve) => setTimeout(resolve, 100));
      if (failure === 'node-create') throw new Error('Node unavailable');
      return { session: { public_id: 'lss-one', playback_url: 'https://ivs.test/one.m3u8' }, playback_url: 'https://ivs.test/one.m3u8' };
    },
    acquire: async () => ({ ingest: { ingest_server: 'ivs.test', stream_key: 'secret' } }),
    start: async () => undefined,
    status: async () => ({ is_live: true, events: Array.from({ length: publisherStarts }, (_, index) =>
      ({ name: failure === 'takeover' && index > 0 ? 'Stream Takeover Failure' : 'Stream Takeover',
        code: null, event_time: '2026-09-25T10:00:00Z' })) }),
    heartbeat: async () => undefined,
    content: async (_id: string, _owner: number, type: string) => { calls.content.push(type); },
    stop: async () => { calls.stoppedNode++; },
  } as GoLivePort;
  const config = { defaultS3Uri: 's3://media/default.mp4', pollIntervalMs: 500,
    heartbeatIntervalMs: 5000, maxDemoDurationMs: 60000 } as Config;
  const media = { prepare: async (uri: string) => {
    if (failure === 'download' && !uri.includes('default')) throw new Error('S3 unavailable');
    return { path: uri, hasAudio: true, durationSeconds: uri.includes('default') ? 10 : 0.1 };
  } } as MediaPort;
  const ffmpeg = { start: async (_path: string, _audio: boolean, duration: number) => {
    publisherStarts++;
    calls.publisherStarts++;
    return new FakePublisher(duration);
  } } as PublisherPort;
  const log = { warn: () => undefined, error: () => undefined } as unknown as FastifyBaseLogger;
  return { service: new DemoService(config, repo, laravel, node, media, ffmpeg, log), repo, calls };
}

test('Start is idempotent and Stop ends both downstream sessions', async () => {
  const { service, repo, calls } = fixture();
  const first = await service.start('capture-one', 1, 'same-key', 'Bearer token');
  const second = await service.start('capture-one', 1, 'same-key', 'Bearer token');
  assert.equal(second.id, first.id);
  await until(() => repo.find(first.id)?.status === 'default_live');
  assert.equal(calls.created, 1);
  await service.stop(first.id, 'Bearer token');
  await until(() => repo.find(first.id)?.status === 'stopped');
  assert.equal(calls.stoppedNode, 1);
  assert.equal(calls.stoppedLaravel, 1);
  await service.stop(first.id, 'Bearer token');
  assert.equal(calls.stoppedNode, 1);
});

test('selected decision is consumed once, shown live, then restored to default', async () => {
  const choice = { decision_id: 'choice-one', cycle_number: 1, result: 'SELECT_ASSET' as const,
    expires_at: new Date(Date.now() + 60000).toISOString(),
    asset: { id: 7, name: 'Selected', s3_uri: 's3://media/selected.mp4' } };
  const { service, repo, calls } = fixture([choice]);
  const started = await service.start('capture-two', 1, 'choice-key', 'Bearer token');
  await until(() => repo.find(started.id)?.decisionCursor === 1);
  await until(() => calls.content.includes('selected'));
  await until(() => repo.find(started.id)?.status === 'default_live' && calls.content.filter((type) => type === 'default').length >= 2);
  assert.equal(repo.find(started.id)?.playbackUrl, 'https://ivs.test/one.m3u8');
  assert.equal(repo.find(started.id)?.decisionCursor, 1);
  await service.stop(started.id, 'Bearer token');
  await until(() => repo.find(started.id)?.status === 'stopped');
});

test('ordered decisions skip no-decision outcomes and play later choices once each', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  const { service, repo, calls } = fixture([
    { decision_id: 'no-choice', cycle_number: 1, result: 'NO_DECISION', expires_at: null, asset: null },
    { decision_id: 'first-choice', cycle_number: 2, result: 'SELECT_ASSET', expires_at: expires,
      asset: { id: 11, name: 'First', s3_uri: 's3://media/first.mp4' } },
    { decision_id: 'second-choice', cycle_number: 3, result: 'SELECT_ASSET', expires_at: expires,
      asset: { id: 12, name: 'Second', s3_uri: 's3://media/second.mp4' } },
  ]);
  const started = await service.start('capture-ordered', 1, 'ordered-key', 'Bearer token');
  await until(() => calls.content.filter((type) => type === 'selected').length === 2);
  await until(() => calls.content.filter((type) => type === 'default').length === 3);
  assert.equal(repo.find(started.id)?.decisionCursor, 3);
  assert.deepEqual(calls.content, ['default', 'selected', 'default', 'selected', 'default']);
  await service.stop(started.id, 'Bearer token');
  await until(() => repo.find(started.id)?.status === 'stopped');
});

test('another active Demo for the owner is rejected', async () => {
  const { service, repo } = fixture();
  const first = await service.start('capture-one', 1, 'first-key', 'Bearer token');
  await assert.rejects(service.start('capture-other', 1, 'other-key', 'Bearer token'), DemoError);
  await until(() => repo.find(first.id)?.status === 'default_live');
  await service.stop(first.id, 'Bearer token');
  await until(() => repo.find(first.id)?.status === 'stopped');
});

test('recovery restarts default without replaying an already processed decision', async () => {
  const previous = { decision_id: 'old-choice', cycle_number: 7, result: 'SELECT_ASSET' as const,
    expires_at: new Date(Date.now() + 60000).toISOString(),
    asset: { id: 5, name: 'Old asset', s3_uri: 's3://media/old.mp4' } };
  const { service, repo, calls } = fixture([previous]);
  const now = new Date();
  repo.create({ id: 'demo_00000000-0000-0000-0000-000000000001', ownerId: 4, unitId: 1,
    adaptiveSessionId: 'capture-old', goLiveSessionId: 'lss-one', playbackUrl: 'https://ivs.test/one.m3u8',
    idempotencyKey: 'old-key', status: 'selected_live', operation: null, assetType: 'selected',
    assetId: 5, decisionId: 'old-choice', decisionCursor: 7, priority: 2, takeoverCount: 2,
    selectedStartedAt: now.toISOString(), selectedDurationSeconds: 10,
    nodeStopped: false, laravelStopped: false, startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60000).toISOString(), error: null });
  await service.recover();
  await until(() => repo.find('demo_00000000-0000-0000-0000-000000000001')?.status === 'default_live');
  assert.equal(repo.find('demo_00000000-0000-0000-0000-000000000001')?.decisionCursor, 7);
  assert.equal(calls.content.includes('selected'), false);
  await service.stop('demo_00000000-0000-0000-0000-000000000001', 'Bearer token');
  await until(() => repo.find('demo_00000000-0000-0000-0000-000000000001')?.status === 'stopped');
});

test('Node creation failure compensates the reserved Demo and Laravel capture', async () => {
  const { service, repo, calls } = fixture([], 'node-create');
  await assert.rejects(service.start('capture-failed', 1, 'failure-key', 'Bearer token'));
  const failed = [...repo.rows.values()][0];
  assert.equal(failed?.status, 'failed');
  assert.equal(calls.stoppedLaravel, 1);
  assert.equal(calls.stoppedNode, 0);
});

test('failed media preparation consumes the decision without interrupting default playback', async () => {
  const choice = { decision_id: 'choice-fail', cycle_number: 1, result: 'SELECT_ASSET' as const,
    expires_at: new Date(Date.now() + 60000).toISOString(),
    asset: { id: 9, name: 'Missing', s3_uri: 's3://media/missing.mp4' } };
  const { service, repo, calls } = fixture([choice], 'download');
  const started = await service.start('capture-fail-download', 1, 'download-key', 'Bearer token');
  await until(() => repo.find(started.id)?.decisionCursor === 1);
  assert.equal(repo.find(started.id)?.status, 'default_live');
  assert.deepEqual(calls.content, ['default']);
  await service.stop(started.id, 'Bearer token');
  await until(() => repo.find(started.id)?.status === 'stopped');
});

test('IVS takeover failure keeps the confirmed default publisher live', async () => {
  const choice = { decision_id: 'choice-rejected', cycle_number: 1, result: 'SELECT_ASSET' as const,
    expires_at: new Date(Date.now() + 60000).toISOString(),
    asset: { id: 10, name: 'Rejected', s3_uri: 's3://media/rejected.mp4' } };
  const { service, repo, calls } = fixture([choice], 'takeover');
  const started = await service.start('capture-rejected', 1, 'rejected-key', 'Bearer token');
  await until(() => calls.publisherStarts === 2 && repo.find(started.id)?.operation === null);
  assert.equal(repo.find(started.id)?.status, 'default_live');
  assert.equal(repo.find(started.id)?.takeoverCount, 0);
  assert.deepEqual(calls.content, ['default']);
  await service.stop(started.id, 'Bearer token');
  await until(() => repo.find(started.id)?.status === 'stopped');
});

test('Stop during Node creation waits for the new downstream session and cleans it up', async () => {
  const { service, repo, calls } = fixture([], 'slow-create');
  const starting = service.start('capture-stop-race', 1, 'stop-race-key', 'Bearer token');
  await until(() => repo.rows.size === 1);
  const id = [...repo.rows.keys()][0]!;
  await service.stop(id, 'Bearer token');
  await starting;
  await until(() => repo.find(id)?.status === 'stopped');
  assert.equal(calls.stoppedNode, 1);
  assert.equal(calls.stoppedLaravel, 1);
});
