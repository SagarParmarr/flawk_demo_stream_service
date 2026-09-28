import type { FastifyInstance } from 'fastify';
import { publicDemo } from '../domain/demo.js';
import { DemoError, DemoService } from '../application/demo-service.js';
import { UpstreamError } from '../integrations/http.js';

const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const demoId = '^demo_[0-9a-fA-F-]{36}$';

function credentials(headers: Record<string, unknown>): { bearer: string; key: string } {
  const bearer = headers.authorization;
  if (typeof bearer !== 'string' || !/^Bearer\s+\S+$/i.test(bearer)) throw new DemoError(401, 'Bearer token required');
  const key = headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw new DemoError(422, 'Idempotency-Key is required');
  return { bearer, key };
}

function bearer(headers: Record<string, unknown>): string {
  const value = headers.authorization;
  if (typeof value !== 'string' || !/^Bearer\s+\S+$/i.test(value)) throw new DemoError(401, 'Bearer token required');
  return value;
}

export function registerRoutes(app: FastifyInstance, service: DemoService, ready: () => boolean): void {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!ready()) return reply.code(503).send({ status: 'unavailable' });
    return { status: 'ok' };
  });

  app.post<{ Body: { unit_ids: number[]; adaptive_session_id: string; mobile_presence_required?: boolean } }>('/demo-streams', {
    schema: { body: { type: 'object', required: ['unit_ids', 'adaptive_session_id'], additionalProperties: false,
      properties: { unit_ids: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'integer', minimum: 1 } },
        adaptive_session_id: { type: 'string', pattern: uuid }, mobile_presence_required: { type: 'boolean', default: false } } } },
  }, async (request, reply) => {
    const auth = credentials(request.headers);
    const session = await service.start(request.body.adaptive_session_id, request.body.unit_ids[0]!, auth.key, auth.bearer, request.body.mobile_presence_required);
    return reply.code(202).send({ data: publicDemo(session) });
  });

  app.get<{ Params: { id: string } }>('/demo-streams/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: demoId } } } },
  }, async (request) => ({ data: publicDemo(await service.get(request.params.id, bearer(request.headers))) }));

  app.post<{ Params: { id: string } }>('/demo-streams/:id/stop', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: demoId } } } },
  }, async (request, reply) => reply.code(202).send({ data: publicDemo(await service.stop(request.params.id, bearer(request.headers))) }));

  app.post<{ Params: { id: string } }>('/demo-streams/:id/heartbeat', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: demoId } } } },
  }, async (request) => ({ data: publicDemo(await service.heartbeat(request.params.id, bearer(request.headers))) }));

  app.setErrorHandler((error, _request, reply) => {
    const failure = error instanceof Error ? error : new Error('Unknown failure');
    const status = failure instanceof DemoError ? failure.code
      : failure instanceof UpstreamError && failure.status < 500 ? failure.status
        : 'validation' in failure ? 422 : 500;
    if (status >= 500) app.log.error({ errorName: failure.name }, 'Demo request failed');
    reply.code(status).send({ message: status >= 500 ? 'Demo service is temporarily unavailable' : failure.message });
  });
}
