import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DemoSession } from '../src/domain/demo.js';
import { SqliteDemoRepository } from '../src/infrastructure/sqlite-repository.js';

const demo = (id: string, ownerId: number, status: DemoSession['status']): DemoSession => ({
  id, ownerId, unitId: 1, adaptiveSessionId: 'capture', goLiveSessionId: null, playbackUrl: null,
  idempotencyKey: id, status, operation: null, assetType: 'default', assetId: null, decisionId: null,
  decisionCursor: 0, priority: 0, takeoverCount: 0, selectedStartedAt: null, selectedDurationSeconds: null,
  selectedExpiresAt: null, presenceExpiresAt: null,
  nodeStopped: false, laravelStopped: false, startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(), error: null,
});

test('SQLite permits one active Demo per owner and persists the decision cursor', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'flawk-demo-test-'));
  const filename = path.join(directory, 'demo.sqlite');
  try {
    const first = new SqliteDemoRepository(filename);
    first.create(demo('demo-one', 4, 'starting'));
    assert.throws(() => first.create(demo('demo-two', 4, 'starting')));
    const row = first.find('demo-one')!;
    row.decisionCursor = 7;
    row.status = 'stopped';
    first.save(row);
    first.close();
    const reopened = new SqliteDemoRepository(filename);
    assert.equal(reopened.find('demo-one')?.decisionCursor, 7);
    reopened.create(demo('demo-two', 4, 'starting'));
    assert.equal(reopened.listNonterminal().length, 1);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('legacy JSON payloads normalize deadlines without a schema migration', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'flawk-demo-legacy-'));
  const repository = new SqliteDemoRepository(path.join(directory, 'demo.sqlite'));
  try {
    const legacy = demo('legacy', 4, 'default_live');
    delete (legacy as Partial<DemoSession>).selectedExpiresAt;
    delete (legacy as Partial<DemoSession>).presenceExpiresAt;
    repository.create(legacy);
    assert.equal(repository.find('legacy')?.selectedExpiresAt, null);
    assert.equal(repository.listNonterminal()[0]?.presenceExpiresAt, null);
  } finally { repository.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('legacy payload migration persists mode and content version across reopen', () => {
  const directory=mkdtempSync(path.join(tmpdir(),'demo-mode-'));
  const filename=path.join(directory,'demo.sqlite');
  try {
    const first=new SqliteDemoRepository(filename);
    const old=demo('old',4,'default_live'); old.takeoverCount=5;
    first.create(old); first.close();
    const upgraded=new SqliteDemoRepository(filename);
    const row=upgraded.find('old')!;
    assert.equal(row.publisherMode,'legacy'); assert.equal(row.sourceVersion,6);
    row.publisherMode='persistent-copy'; row.sourceVersion=14; upgraded.save(row); upgraded.close();
    const reopened=new SqliteDemoRepository(filename);
    assert.equal(reopened.find('old')?.publisherMode,'persistent-copy');
    assert.equal(reopened.find('old')?.sourceVersion,14);
    reopened.close();
  } finally {rmSync(directory,{recursive:true,force:true});}
});
