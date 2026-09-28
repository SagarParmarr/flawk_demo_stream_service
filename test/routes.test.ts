import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerRoutes } from '../src/api/routes.js';
import { DemoError, type DemoService } from '../src/application/demo-service.js';
import type { DemoSession } from '../src/domain/demo.js';

test('creation schema accepts opt-in presence and defaults existing clients to false', async () => {
  const app = Fastify();
  const calls: boolean[] = [];
  const service = { start: async (_session: string, _unit: number, _key: string, _token: string, presence: boolean) => {
    calls.push(presence); return { id: 'demo-id', selectedExpiresAt: null, presenceExpiresAt: presence ? 'deadline' : null } as DemoSession;
  } } as unknown as DemoService;
  registerRoutes(app, service, () => true);
  try {
    const body = { unit_ids: [1], adaptive_session_id: '00000000-0000-0000-0000-000000000001' };
    const headers = { authorization: 'Bearer test', 'idempotency-key': 'test-key-123' };
    const first = await app.inject({ method: 'POST', url: '/demo-streams', headers, payload: body });
    const second = await app.inject({ method: 'POST', url: '/demo-streams', headers, payload: { ...body, mobile_presence_required: true } });
    assert.equal(first.statusCode, 202); assert.equal(second.statusCode, 202);
    assert.deepEqual(calls, [false, true]);
    assert.equal(first.json().data.selected_expires_at, null);
    const invalid = await app.inject({ method: 'POST', url: '/demo-streams', headers, payload: { ...body, mobile_presence_required: {} } });
    assert.equal(invalid.statusCode, 422);
  } finally { await app.close(); }
});

test('heartbeat requires bearer authorization and returns the status envelope', async () => {
  const app = Fastify();
  const calls: string[] = [];
  const service = { heartbeat: async (_id: string, token: string) => {
    if (token !== 'Bearer owner') throw new DemoError(403, 'Demo belongs to another user');
    calls.push(token); return { status: 'stopping', presenceExpiresAt: null, selectedExpiresAt: null } as DemoSession;
  } } as unknown as DemoService;
  registerRoutes(app, service, () => true);
  try {
    const url = '/demo-streams/demo_00000000-0000-0000-0000-000000000001/heartbeat';
    assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer other' } })).statusCode, 403);
    const response = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer owner' } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().data.status, 'stopping');
    assert.deepEqual(calls, ['Bearer owner']);
  } finally { await app.close(); }
});
