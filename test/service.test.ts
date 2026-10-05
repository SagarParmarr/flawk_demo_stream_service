import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import { DemoService, DemoError } from '../src/application/demo-service.js';
import type { Decision, DemoRepository, DemoSession, Publisher } from '../src/domain/demo.js';
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

function fixture(decisions: Decision[] = [],
  failure?: 'node-create' | 'slow-create' | 'download' | 'takeover', persistentMode = false) {
  let offset = 0;
  const clock = () => Date.now() + offset;
  const advance = (ms: number) => { offset += ms; };
  const repo = new MemoryRepository();
  const calls = { created: 0, stoppedNode: 0, stoppedLaravel: 0, publisherStarts: 0, persistentStarts: 0, switches: [] as string[], versions: [] as number[], content: [] as string[] };
  let publisherStarts = 0;
  const laravel = {
    validate: async (id: string) => ({ session_id: id, owner_id: 4, unit_ids: [1], state: 'READY_FOR_CAPTURE' }),
    bind: async () => undefined,
    decisions: async () => ({ owner_id: 4, unit_ids: [1], state: 'COMPLETE', generated_at: new Date().toISOString(), decisions }),
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
    content: async (_id: string, _owner: number, type: string, _asset: number | null, version: number) => { calls.content.push(type); calls.versions.push(version); },
    stop: async () => { calls.stoppedNode++; },
  } as GoLivePort;
  const config = { persistentPublisherEnabled: persistentMode, defaultS3Uri: 's3://media/default.mp4', pollIntervalMs: 500,
    heartbeatIntervalMs: 5000, maxDemoDurationMs: 600000, selectedAssetHoldSeconds: 30 } as Config;
  const media = { prepare: async (uri: string) => {
    if (failure === 'download' && !uri.includes('default')) throw new Error('S3 unavailable');
    return { path: uri, hasAudio: true, publishMode: persistentMode ? 'copy' : 'encode', mediaProfile: persistentMode ? 'square800-copy-v2' : null, durationSeconds: uri.includes('default') ? 10 : 0.1 };
  } } as MediaPort;
  const ffmpeg = { start: async (_path: string, _audio: boolean, duration: number) => {
    publisherStarts++;
    calls.publisherStarts++;
    return new FakePublisher(duration);
  } } as PublisherPort;
  const persistent = { start: async (_path: string, _audio: boolean, duration: number) => {
    calls.persistentStarts++;
    publisherStarts++;
    return Object.assign(new FakePublisher(duration), {
      switchSource: async (asset: { path: string }, _requestId: string, signal: AbortSignal) => {
        if (signal.aborted) throw new Error('cancelled');
        calls.switches.push(asset.path);
        return { committedAt: new Date().toISOString(), outputTimestamp: calls.switches.length * 2 };
      },
    });
  } } as PublisherPort;
  const logs: Record<string, unknown>[] = [];
  const record = (entry: Record<string, unknown>) => { logs.push(entry); };
  const log = { info: record, debug: record, warn: record, error: record } as unknown as FastifyBaseLogger;
  return { service: new DemoService(config, repo, laravel, node, media, ffmpeg, log, clock, persistent), repo, calls, advance, laravel, media, node, logs, config, ffmpeg, persistent, log, clock };
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
    decided_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    asset: { id: 7, name: 'Selected', s3_uri: 's3://media/selected.mp4' } };
  const { service, repo, calls, advance, logs } = fixture([choice]);
  const started = await service.start('capture-two', 1, 'choice-key', 'Bearer token');
  await until(() => repo.find(started.id)?.decisionCursor === 1);
  await until(() => calls.content.includes('selected'));
  advance(31_000);
  await until(() => repo.find(started.id)?.status === 'default_live' && calls.content.filter((type) => type === 'default').length >= 2);
  assert.equal(repo.find(started.id)?.playbackUrl, 'https://ivs.test/one.m3u8');
  assert.equal(repo.find(started.id)?.decisionCursor, 1);
  for (const stage of ['go_live_session_create', 'go_live_publisher_acquire', 'default_media_prepare',
    'ffmpeg_spawn', 'ivs_initial_live_confirmation', 'session_request_to_ivs_live', 'selected_media_prepare',
    'ivs_takeover_confirmation', 'asset_transition']) {
    assert.ok(logs.some((entry) => entry.stage === stage && entry.outcome === 'completed' && entry.demoId === started.id), stage);
  }
  assert.ok(logs.some((entry) => entry.event === 'demo_source_switched' && entry.assetType === 'default'
    && entry.fromAssetId === 7 && typeof entry.sourceVersion === 'number'));
  assert.ok(logs.some((entry) => entry.event === 'demo_decision_handled' && entry.outcome === 'switched' && entry.decisionId === 'choice-one'));
  assert.ok(logs.some((entry) => entry.event === 'demo_decision_received' && entry.decisionId === 'choice-one'
    && entry.decidedAt === choice.decided_at && typeof entry.pollRequestMs === 'number'
    && typeof entry.configuredPollIntervalMs === 'number' && typeof entry.feedGeneratedAt === 'string'
    && typeof entry.decisionToFeedMs === 'number'));
  assert.ok(logs.some((entry) => entry.event === 'demo_ivs_takeover_probe' && entry.assetId === 7
    && entry.result === 'confirmed' && typeof entry.requestDurationMs === 'number'));
  assert.ok(!JSON.stringify(logs).includes('Bearer token'));
  await service.stop(started.id, 'Bearer token');
  await until(() => repo.find(started.id)?.status === 'stopped');
});

test('only the newest valid backlog choice is selected', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  const { service, repo, calls, advance } = fixture([
    { decision_id: 'no-choice', cycle_number: 1, result: 'NO_DECISION', expires_at: null, asset: null },
    { decision_id: 'first-choice', cycle_number: 2, result: 'SELECT_ASSET', expires_at: expires,
      asset: { id: 11, name: 'First', s3_uri: 's3://media/first.mp4' } },
    { decision_id: 'second-choice', cycle_number: 3, result: 'SELECT_ASSET', expires_at: expires,
      asset: { id: 12, name: 'Second', s3_uri: 's3://media/second.mp4' } },
  ]);
  const started = await service.start('capture-ordered', 1, 'ordered-key', 'Bearer token');
  await until(() => repo.find(started.id)?.assetId === 12);
  assert.equal(repo.find(started.id)?.decisionCursor, 3);
  assert.deepEqual(calls.content, ['default', 'selected']);
  advance(31_000);
  await until(() => calls.content.length === 3);
  assert.deepEqual(calls.content, ['default', 'selected', 'default']);
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
    selectedExpiresAt: now.toISOString(), presenceExpiresAt: null,
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

const choice = (cycle: number, assetId: number) => ({ decision_id: `decision-${cycle}`, cycle_number: cycle,
  result: 'SELECT_ASSET' as const, expires_at: null,
  asset: { id: assetId, name: 'Selected', s3_uri: `s3://media/selected-${assetId}.mp4` } });

test('direct selected replacement and same-asset renewal never insert default', async () => {
  const feed = [choice(1, 7)];
  const { service, repo, calls, advance } = fixture(feed);
  const demo = await service.start('capture-replace', 1, 'replace-key', 'token');
  await until(() => repo.find(demo.id)?.assetId === 7);
  const firstDeadline = repo.find(demo.id)!.selectedExpiresAt!;
  advance(5000);
  feed.push(choice(2, 8));
  await until(() => repo.find(demo.id)?.assetId === 8);
  assert.deepEqual(calls.content, ['default', 'selected', 'selected']);
  const starts = calls.publisherStarts;
  advance(5000);
  feed.push(choice(3, 8));
  await until(() => repo.find(demo.id)?.decisionId === 'decision-3');
  const renewed = repo.find(demo.id)!.selectedExpiresAt!;
  assert.ok(Date.parse(renewed) > Date.parse(firstDeadline) + 9000);
  assert.equal(calls.publisherStarts, starts);
  feed.push({ ...choice(4, 8), decision_id: 'decision-3' });
  await until(() => repo.find(demo.id)?.decisionCursor === 4);
  assert.equal(repo.find(demo.id)?.selectedExpiresAt, renewed);
  feed.push({ decision_id: 'none', cycle_number: 5, result: 'NO_DECISION', expires_at: null, asset: null } as any);
  await until(() => repo.find(demo.id)?.decisionCursor === 5);
  assert.equal(repo.find(demo.id)?.selectedExpiresAt, renewed);
  advance(31_000);
  await until(() => repo.find(demo.id)?.status === 'default_live');
  await service.stop(demo.id, 'token');
});

test('deadline restoration is independent of a hung decision request', async () => {
  const { service, repo, laravel, advance } = fixture([choice(1, 7)]);
  const demo = await service.start('capture-slow-feed', 1, 'slow-feed', 'token');
  await until(() => repo.find(demo.id)?.status === 'selected_live');
  let release!: (feed: Awaited<ReturnType<LaravelPort['decisions']>>) => void;
  laravel.decisions = async () => new Promise((resolve) => { release = resolve; });
  await until(() => Boolean(release));
  advance(31_000);
  await until(() => repo.find(demo.id)?.status === 'default_live');
  await service.stop(demo.id, 'token');
  release({ owner_id: 4, unit_ids: [1], state: 'COMPLETE', decisions: [] });
});

test('slow media preparation cannot postpone expiry, and Stop discards prepared media', async () => {
  const feed = [choice(1, 7)];
  const { service, repo, media, calls, advance } = fixture(feed);
  const demo = await service.start('capture-slow-media', 1, 'slow-media', 'token');
  await until(() => repo.find(demo.id)?.assetId === 7);
  let release!: (media: Awaited<ReturnType<MediaPort['prepare']>>) => void;
  media.prepare = async () => new Promise((resolve) => { release = resolve; });
  feed.push(choice(2, 8));
  await until(() => Boolean(release));
  advance(31_000);
  await until(() => repo.find(demo.id)?.status === 'default_live');
  await service.stop(demo.id, 'token');
  const starts = calls.publisherStarts;
  release({ path: 'prepared', hasAudio: true, publishMode: 'encode', mediaProfile: null, durationSeconds: 120 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.publisherStarts, starts);
});

test('presence lease expires even with a hung feed; heartbeat cannot resurrect it', async () => {
  const { service, repo, laravel, advance } = fixture();
  laravel.decisions = async () => new Promise(() => undefined);
  const demo = await service.start('capture-lease', 1, 'lease-key', 'token', true);
  await until(() => repo.find(demo.id)?.status === 'default_live');
  advance(30_000);
  const renewed = await service.heartbeat(demo.id, 'token');
  assert.ok(Date.parse(renewed.presenceExpiresAt!) > Date.parse(demo.presenceExpiresAt!));
  advance(61_000);
  const expired = await service.heartbeat(demo.id, 'token');
  assert.equal(expired.status, 'stopping');
  await until(() => repo.find(demo.id)?.status === 'stopped');
  assert.equal((await service.heartbeat(demo.id, 'token')).status, 'stopped');
});

test('failed default restoration ends Demo instead of looping selected indefinitely', async () => {
  const { service, repo, node, advance } = fixture([choice(1, 7)]);
  const demo = await service.start('capture-failed-default', 1, 'failed-default', 'token');
  await until(() => repo.find(demo.id)?.status === 'selected_live');
  node.status = async () => { throw new Error('IVS unavailable'); };
  advance(31_000);
  await until(() => repo.find(demo.id)?.status === 'failed');
});


test('long assets are interrupted at the hold deadline; short assets do not restore early', async () => {
  const { service, repo, media, calls, advance } = fixture([choice(1, 7)]);
  media.prepare = async (uri) => ({ path: uri, hasAudio: true, publishMode: 'encode', mediaProfile: null, durationSeconds: 120 });
  const demo = await service.start('capture-long', 1, 'long-key', 'token');
  await until(() => repo.find(demo.id)?.status === 'selected_live');
  assert.equal(repo.find(demo.id)?.selectedDurationSeconds, 120);
  advance(20_000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(repo.find(demo.id)?.status, 'selected_live');
  assert.deepEqual(calls.content, ['default', 'selected']);
  advance(11_000);
  await until(() => repo.find(demo.id)?.status === 'default_live');
  await service.stop(demo.id, 'token');
});

test('presence watchdog expires on its own, and non-owner cannot renew a lease', async () => {
  const { service, repo, laravel, advance } = fixture();
  const demo = await service.start('capture-owner', 1, 'owner-key', 'token', true);
  await until(() => repo.find(demo.id)?.status === 'default_live');
  const deadline = repo.find(demo.id)?.presenceExpiresAt;
  laravel.validate = async (id) => ({ session_id: id, owner_id: 99, unit_ids: [1], state: 'COMPLETE' });
  await assert.rejects(service.heartbeat(demo.id, 'other-token'), (error: unknown) => error instanceof DemoError && error.code === 403);
  assert.equal(repo.find(demo.id)?.presenceExpiresAt, deadline);
  advance(61_000);
  await until(() => repo.find(demo.id)?.status === 'stopped');
});

test('deadline interrupts an in-flight selected takeover before restoring default', async () => {
  const feed = [choice(1, 7)];
  const { service, repo, node, calls, advance } = fixture(feed);
  const demo = await service.start('capture-race', 1, 'race-key', 'token');
  await until(() => repo.find(demo.id)?.assetId === 7);
  const status = node.status;
  let block = true;
  node.status = async (...args) => {
    if (block) return new Promise(() => undefined);
    return status(...args);
  };
  feed.push(choice(2, 8));
  await until(() => repo.find(demo.id)?.operation === 'switching_selected');
  block = false;
  advance(31_000);
  await until(() => repo.find(demo.id)?.status === 'default_live');
  assert.deepEqual(calls.content, ['default', 'selected', 'default']);
  await service.stop(demo.id, 'token');
});

test('a new prepared version of the same asset switches instead of renewing the old file', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  const decisions: Decision[] = [{ decision_id: 'version-one', cycle_number: 1, result: 'SELECT_ASSET', expires_at: expires,
    asset: { id: 1, name: 'same asset', s3_uri: 's3://media/one.mp4', media_profile: 'square800-v1' } }];
  const { service, repo, calls } = fixture(decisions);
  const session = await service.start('capture-versioned', 1, 'versioned', 'Bearer token');
  try {
    await until(() => repo.find(session.id)?.decisionId === 'version-one');
    decisions.push({ ...decisions[0]!, decision_id: 'version-two', cycle_number: 2,
      asset: { ...decisions[0]!.asset!, s3_uri: 's3://media/two.mp4' } });
    await until(() => repo.find(session.id)?.decisionId === 'version-two');
    assert.equal(calls.publisherStarts, 3);
  } finally { await service.stop(session.id, 'Bearer token'); }
});


test('persistent flag switches sources within one publisher and does not consume takeover capacity', async () => {
  const choices: Decision[] = [];
  const f = fixture(choices, undefined, true);
  const started = await f.service.start('persistent', 1, 'persistent-key', 'Bearer token');
  try {
    await until(() => f.repo.find(started.id)?.status === 'default_live');
    assert.equal(f.repo.find(started.id)?.publisherMode, 'persistent-copy');
    const row = f.repo.find(started.id)!;
    row.takeoverCount = 89; f.repo.save(row);
    choices.push({ decision_id: 'select-a', cycle_number: 1, result: 'SELECT_ASSET', expires_at: null,
      asset: { id: 1, name: 'A', s3_uri: 's3://media/a.mp4' } });
    await until(() => f.repo.find(started.id)?.assetId === 1);
    assert.equal(f.calls.persistentStarts, 1);
    assert.equal(f.calls.publisherStarts, 0);
    assert.equal(f.repo.find(started.id)?.takeoverCount, 89);
    assert.equal(f.repo.find(started.id)?.sourceVersion, 2);
    choices.push({ ...choices[0]!, decision_id: 'renew-a', cycle_number: 2 });
    await until(() => f.repo.find(started.id)?.decisionId === 'renew-a');
    assert.equal(f.calls.switches.length, 1);
    choices.push({ ...choices[0]!, decision_id: 'select-b', cycle_number: 3,
      asset: { id: 2, name: 'B', s3_uri: 's3://media/b.mp4' } });
    await until(() => f.repo.find(started.id)?.assetId === 2);
    f.advance(31000);
    await until(() => f.calls.switches.length === 3 && f.repo.find(started.id)?.status === 'default_live');
    assert.equal(f.calls.persistentStarts, 1);
    assert.deepEqual(f.calls.versions, [1,2,3,4]);
    assert.equal(f.repo.find(started.id)?.priority, 0);
  } finally { await f.service.stop(started.id, 'Bearer token'); await until(() => f.repo.find(started.id)?.status === 'stopped'); }
});

test('incompatible persistent selection retains the current source', async () => {
  const choices: Decision[] = [];
  const f = fixture(choices, undefined, true);
  const started = await f.service.start('persistent-reject', 1, 'persistent-reject-key', 'Bearer token');
  try {
    await until(() => f.repo.find(started.id)?.status === 'default_live');
    f.media.prepare = async () => ({path:'wrong',hasAudio:true,durationSeconds:2,publishMode:'copy',mediaProfile:'square800-v1'});
    choices.push({decision_id:'bad',cycle_number:1,result:'SELECT_ASSET',expires_at:null,
      asset:{id:1,name:'wrong',s3_uri:'s3://media/bad.mp4'}});
    await until(() => f.repo.find(started.id)?.decisionCursor === 1 && f.logs.some(l => l.error));
    assert.equal(f.repo.find(started.id)?.status,'default_live');
    assert.equal(f.calls.switches.length,0);
    assert.equal(f.calls.publisherStarts,0);
  } finally { await f.service.stop(started.id,'Bearer token'); await until(() => f.repo.find(started.id)?.status === 'stopped'); }
});

test('recovery uses the saved persistent mode even when the ENV flag is disabled', async () => {
  const f = fixture([], undefined, true);
  const started = await f.service.start('persistent-recovery',1,'persistent-recovery-key','Bearer token');
  await until(() => f.repo.find(started.id)?.status === 'default_live');
  await f.service.shutdown();
  f.config.persistentPublisherEnabled = false;
  f.config.persistentDefaultS3Uri = 's3://media/changed-default.mp4';
  const prepared: string[]=[];
  const oldPrepare=f.media.prepare;
  f.media.prepare=async (...args)=>{prepared.push(args[0]);return oldPrepare(...args);};
  const recovered = new DemoService(f.config,f.repo,f.laravel,f.node,f.media,f.ffmpeg,f.log,f.clock,f.persistent);
  try {
    await recovered.recover();
    await until(() => f.calls.persistentStarts === 2 && f.repo.find(started.id)?.operation === null);
    assert.equal(f.repo.find(started.id)?.publisherMode,'persistent-copy');
    assert.equal(f.repo.find(started.id)?.sourceVersion,2);
    assert.deepEqual(prepared,['s3://media/default.mp4']);
    assert.equal(f.calls.publisherStarts,0);
  } finally { await recovered.stop(started.id,'Bearer token'); await until(() => f.repo.find(started.id)?.status === 'stopped'); }
});

test('legacy recovery ignores an enabled persistent flag', async () => {
  const f = fixture();
  const started = await f.service.start('legacy-recovery',1,'legacy-recovery-key','Bearer token');
  await until(() => f.repo.find(started.id)?.status === 'default_live');
  await f.service.shutdown();
  f.config.persistentPublisherEnabled = true;
  const recovered = new DemoService(f.config,f.repo,f.laravel,f.node,f.media,f.ffmpeg,f.log,f.clock,f.persistent);
  try {
    await recovered.recover();
    await until(() => f.calls.publisherStarts === 2 && f.repo.find(started.id)?.operation === null);
    assert.equal(f.repo.find(started.id)?.publisherMode,'legacy');
    assert.equal(f.calls.persistentStarts,0);
  } finally { await recovered.stop(started.id,'Bearer token'); await until(() => f.repo.find(started.id)?.status === 'stopped'); }
});


test('persistent expiry restores default after a cancellation races a committed selection', async () => {
  const choices: Decision[]=[];
  const f=fixture(choices,undefined,true);
  let waiting: AbortSignal | undefined;
  let resolveRace: (()=>void) | undefined;
  const factoryStart=f.persistent.start;
  f.persistent.start=async (...args) => {
    const publisher=await factoryStart(...args);
    const original=publisher.switchSource!;
    publisher.switchSource=async (media,id,signal) => {
      if (media.path.includes('b.mp4')) {
        waiting=signal;
        await new Promise<void>(resolve=>{resolveRace=resolve;});
        f.calls.switches.push(media.path);
        return {committedAt:new Date().toISOString(),outputTimestamp:4};
      }
      return original(media,id,signal);
    };
    return publisher;
  };
  const started=await f.service.start('race',1,'race-key','Bearer token');
  try {
    await until(()=>f.repo.find(started.id)?.status==='default_live');
    choices.push({decision_id:'a',cycle_number:1,result:'SELECT_ASSET',expires_at:null,
      asset:{id:1,name:'A',s3_uri:'s3://media/a.mp4'}});
    await until(()=>f.repo.find(started.id)?.assetId===1);
    choices.push({...choices[0]!,decision_id:'b',cycle_number:2,asset:{id:2,name:'B',s3_uri:'s3://media/b.mp4'}});
    await until(()=>Boolean(waiting));
    f.advance(31000);
    await until(()=>waiting!.aborted);
    resolveRace!();
    await until(()=>f.repo.find(started.id)?.status==='default_live' && f.calls.switches.length===3);
    assert.equal(f.repo.find(started.id)?.sourceVersion,4);
    assert.deepEqual(f.calls.content,['default','selected','selected','default']);
  } finally {resolveRace?.();await f.service.stop(started.id,'Bearer token');await until(()=>f.repo.find(started.id)?.status==='stopped');}
});

test('persistent publisher death cleans up even while decision polling is hung', async () => {
  const f=fixture([],undefined,true);
  let die!: ()=>void;
  f.persistent.start=async (_p,_a,duration)=>{
    let running=true;
    let resolve!: (code:number|null)=>void;
    const exit=new Promise<number|null>(r=>{resolve=r;});
    die=()=>{running=false;resolve(1);};
    return {pid:555,startedAt:new Date().toISOString(),durationSeconds:duration,
      exit,alive:()=>running,stop:async()=>{running=false;resolve(0);}};
  };
  f.laravel.decisions=async()=>new Promise(()=>undefined);
  const started=await f.service.start('death',1,'death-key','Bearer token');
  await until(()=>f.repo.find(started.id)?.status==='default_live');
  die();
  await until(()=>f.repo.find(started.id)?.status==='failed');
  assert.equal(f.calls.stoppedNode,1);
  assert.equal(f.calls.stoppedLaravel,1);
});


test('flag-off legacy selections do not admit the new preparation profile', async () => {
  const choices: Decision[]=[];
  const f=fixture(choices);
  const started=await f.service.start('legacy-v2',1,'legacy-v2-key','Bearer token');
  try {
    await until(()=>f.repo.find(started.id)?.status==='default_live');
    choices.push({decision_id:'v2',cycle_number:1,result:'SELECT_ASSET',expires_at:null,
      asset:{id:1,name:'v2',s3_uri:'s3://media/v2.mp4',media_profile:'square800-copy-v2'}});
    await until(()=>f.repo.find(started.id)?.decisionCursor===1 && f.logs.some(l=>l.error));
    assert.equal(f.calls.publisherStarts,1);
    assert.equal(f.calls.persistentStarts,0);
    assert.equal(f.repo.find(started.id)?.status,'default_live');
  } finally {await f.service.stop(started.id,'Bearer token');await until(()=>f.repo.find(started.id)?.status==='stopped');}
});
