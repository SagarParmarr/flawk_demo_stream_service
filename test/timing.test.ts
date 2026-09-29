import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import { timed } from '../src/observability/timing.js';

function logger() {
  const entries: Record<string, unknown>[] = [];
  const write = (entry: Record<string, unknown>) => entries.push(entry);
  return { entries, log: { info: write, debug: write, warn: write } as unknown as FastifyBaseLogger };
}

test('timing pairs correlated timestamps and preserves results', async () => {
  const { log, entries } = logger();
  const result = await timed(log, 's3_download', { demoId: 'demo-one', decisionId: 'choice-one' }, async () => 42);
  assert.equal(result, 42);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.spanId, entries[1]?.spanId);
  assert.equal(entries[1]?.outcome, 'completed');
  assert.equal(entries[1]?.demoId, 'demo-one');
  assert.ok(Number(entries[1]?.durationMs) >= 0);
  assert.ok(Number.isFinite(Date.parse(String(entries[1]?.startedAt))));
  assert.ok(Number.isFinite(Date.parse(String(entries[1]?.endedAt))));
});

test('timing preserves failures without logging sensitive error details', async () => {
  const { log, entries } = logger();
  const error = new Error('rtmps://example/app/SECRET_STREAM_KEY');
  await assert.rejects(timed(log, 'ffmpeg_spawn', { demoId: 'demo-one' }, async () => { throw error; }), (caught) => caught === error);
  assert.equal(entries[1]?.outcome, 'failed');
  assert.equal(entries[1]?.errorName, 'Error');
  assert.ok(Number(entries[1]?.durationMs) >= 0);
  assert.ok(!JSON.stringify(entries).includes('SECRET_STREAM_KEY'));
});
