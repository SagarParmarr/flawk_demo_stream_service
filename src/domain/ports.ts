import type { TimingContext } from '../observability/timing.js';
import type { CaptureSession, Decision, PreparedMedia, Publisher, PublisherCredentials } from './demo.js';

export interface LaravelPort {
  validate(sessionId: string, bearer: string): Promise<CaptureSession>;
  bind(sessionId: string, demoId: string, goLiveId: string, ownerId: number, unitId: number): Promise<void>;
  decisions(sessionId: string, afterCycle: number): Promise<{
    owner_id: number; unit_ids: number[]; state: string; generated_at?: string; decisions: Decision[];
  }>;
  stop(sessionId: string): Promise<void>;
}

export interface GoLivePort {
  create(unitId: number, bearer: string): Promise<{ session: { public_id: string }; playback_url: string }>;
  acquire(id: string, ownerId: number, unitId: number): Promise<{ ingest: PublisherCredentials }>;
  start(id: string, ownerId: number): Promise<void>;
  status(id: string, ownerId: number): Promise<{
    is_live: boolean; events: { name: string | null; code: string | null; event_time: string | null }[];
  }>;
  content(id: string, ownerId: number, type: 'default' | 'selected', assetId: number | null, version: number): Promise<void>;
  heartbeat(id: string, ownerId: number): Promise<void>;
  stop(id: string, ownerId: number): Promise<void>;
}

export interface MediaPort {
  prepare(uri: string, version: string, context?: TimingContext, expectedProfile?: string | null): Promise<PreparedMedia>;
}

export interface PublisherPort {
  start(input: string, hasAudio: boolean, durationSeconds: number | null,
    ingest: PublisherCredentials, priority: number, context?: TimingContext, publishMode?: 'copy' | 'encode'): Promise<Publisher>;
}
