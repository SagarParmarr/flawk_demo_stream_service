import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

// Explicitly allowed identifiers only. Never pass requests, credentials, URLs or command arguments.
export interface TimingContext {
  demoId?: string;
  adaptiveSessionId?: string;
  goLiveSessionId?: string | null;
  unitId?: number;
  assetType?: string;
  assetId?: number | null;
  decisionId?: string | null;
  cycleNumber?: number;
}

export async function timed<T>(log: FastifyBaseLogger | undefined, stage: string,
  context: TimingContext, work: () => Promise<T>, level: 'info' | 'debug' = 'info'): Promise<T> {
  const spanId = randomUUID();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  log?.[level]?.({ ...context, event: 'demo_timing', stage, spanId, outcome: 'started', startedAt }, 'Demo stage started');
  try {
    const result = await work();
    log?.[level]?.({ ...context, event: 'demo_timing', stage, spanId, outcome: 'completed', startedAt,
      endedAt: new Date().toISOString(), durationMs: Math.round((performance.now() - start) * 100) / 100 }, 'Demo stage completed');
    return result;
  } catch (error) {
    log?.warn?.({ ...context, event: 'demo_timing', stage, spanId, outcome: 'failed', startedAt,
      endedAt: new Date().toISOString(), durationMs: Math.round((performance.now() - start) * 100) / 100,
      errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Demo stage failed');
    throw error;
  }
}
