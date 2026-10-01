import type { Publisher } from '../domain/demo.js';
import type { PublisherStatus } from '../integrations/go-live/client.js';
import { performance } from 'node:perf_hooks';

export interface TakeoverProbe {
  attempt: number;
  requestDurationMs: number;
  elapsedMs: number;
  result: 'pending' | 'confirmed' | 'failed';
}

function eventKey(event: PublisherStatus['events'][number]): string {
  return `${event.name ?? ''}\0${event.code ?? ''}\0${event.event_time ?? ''}`;
}

export function takeoverResult(status: PublisherStatus, baseline: PublisherStatus): 'confirmed' | 'failed' | 'pending' {
  const previous = new Map<string, number>();
  for (const event of baseline.events) {
    const key = eventKey(event);
    previous.set(key, (previous.get(key) ?? 0) + 1);
  }
  // IVS event timestamps may only have second precision. Compare against the
  // pre-publisher snapshot so an earlier takeover cannot confirm this one.
  const events = status.events.filter((event) => {
    const key = eventKey(event);
    const count = previous.get(key) ?? 0;
    if (count === 0) return true;
    previous.set(key, count - 1);
    return false;
  });
  if (events.some((event) => event.name === 'Stream Takeover Failure')) return 'failed';
  if (events.some((event) => event.name === 'Stream Takeover')) return 'confirmed';
  return 'pending';
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Publisher operation cancelled'));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('Publisher operation cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export async function waitForTakeover(replacement: Publisher,
  status: () => Promise<PublisherStatus>, baseline: PublisherStatus, timeoutMs = 12000, signal?: AbortSignal,
  onProbe?: (probe: TakeoverProbe) => void): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const started = performance.now();
  let attempt = 0;
  while (Date.now() < deadline) {
    if (!replacement.alive()) throw new Error('Replacement publisher exited before takeover');
    if (signal?.aborted) throw new Error('Publisher operation cancelled');
    const requestStarted = performance.now();
    const current = signal ? await abortable(status(), signal) : await status();
    const outcome = takeoverResult(current, baseline);
    onProbe?.({ attempt: ++attempt, requestDurationMs: Math.round((performance.now() - requestStarted) * 100) / 100,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100, result: outcome });
    if (outcome === 'confirmed') return;
    if (outcome === 'failed') throw new Error('IVS rejected publisher takeover');
    const delay = new Promise<void>((resolve) => setTimeout(resolve, 750));
    await (signal ? abortable(delay, signal) : delay);
  }
  throw new Error('IVS did not confirm publisher takeover');
}

export function millisecondsToBoundary(startedAt: string, durationSeconds: number): number {
  const durationMs = durationSeconds * 1000;
  const elapsed = Math.max(0, Date.now() - Date.parse(startedAt));
  return Math.max(0, durationMs - elapsed % durationMs);
}

export function hasSelectedCapacity(takeoverCount: number): boolean {
  // A selected clip needs one takeover to begin and one to return to default.
  return takeoverCount + 2 <= 90;
}
