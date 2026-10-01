import assert from 'node:assert/strict';
import test from 'node:test';
import { transition, type DemoSession } from '../src/domain/demo.js';
import { hasSelectedCapacity, millisecondsToBoundary, takeoverResult, waitForTakeover } from '../src/application/takeover.js';
import type { Publisher } from '../src/domain/demo.js';

const session = { status: 'starting' } as DemoSession;

test('only valid lifecycle transitions are accepted', () => {
  assert.equal(transition(session, 'default_live').status, 'default_live');
  assert.throws(() => transition(session, 'selected_live'));
});

test('reserves a second takeover for returning to default', () => {
  assert.equal(hasSelectedCapacity(88), true);
  assert.equal(hasSelectedCapacity(89), false);
});

test('requires a new IVS takeover event, even within the same second', () => {
  const baseline = { is_live: true, events: [
    { name: 'Stream Takeover', code: null, event_time: '2026-09-25T10:00:00Z' },
  ] };
  assert.equal(takeoverResult(baseline, baseline), 'pending');
  assert.equal(takeoverResult({ ...baseline, events: [...baseline.events, baseline.events[0]!] }, baseline), 'confirmed');
  assert.ok(millisecondsToBoundary(new Date(Date.now() - 1000).toISOString(), 2) <= 1000);
});

test('takeover probe reports request time and confirmed attempt without stream credentials', async () => {
  const publisher = { alive: () => true } as Publisher;
  const probes: Array<{ attempt: number; requestDurationMs: number; elapsedMs: number; result: string }> = [];
  await waitForTakeover(publisher,
    async () => ({ is_live: true, events: [{ name: 'Stream Takeover', code: null, event_time: 'now' }] }),
    { is_live: true, events: [] }, 12000, undefined, (probe) => probes.push(probe));
  assert.equal(probes.length, 1);
  assert.equal(probes[0]?.attempt, 1);
  assert.equal(probes[0]?.result, 'confirmed');
  assert.ok(probes[0]!.requestDurationMs >= 0);
  assert.ok(probes[0]!.elapsedMs >= probes[0]!.requestDurationMs);
});
