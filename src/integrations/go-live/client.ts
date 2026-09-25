import type { GoLiveSession, PublisherCredentials } from '../../domain/demo.js';
import { requestJson } from '../http.js';

interface Data<T> { data: T }
interface Created { session: GoLiveSession; playback_url: string }
interface Acquired { ingest: PublisherCredentials; session: GoLiveSession; playback_url: string }
export interface PublisherStatus { is_live: boolean; events: { name: string | null; code: string | null; event_time: string | null }[] }

export class GoLiveClient {
  constructor(private readonly baseUrl: string, private readonly secret: string) {}

  async create(unitId: number, bearer: string): Promise<Created> {
    return (await requestJson<Data<Created>>(`${this.baseUrl}/api/mobile/live-sessions`, {
      method: 'POST', headers: { Authorization: bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit_ids: [unitId] }),
    })).data;
  }

  async acquire(id: string, ownerId: number, unitId: number): Promise<Acquired> {
    return this.internal(id, ownerId, 'publisher', 'POST', { unit_ids: [unitId] });
  }

  async start(id: string, ownerId: number): Promise<void> {
    await this.internal(id, ownerId, 'start', 'PATCH');
  }

  async status(id: string, ownerId: number): Promise<PublisherStatus> {
    return this.internal(id, ownerId, 'status', 'GET');
  }

  async content(id: string, ownerId: number, type: 'default' | 'selected', assetId: number | null, version: number): Promise<void> {
    await this.internal(id, ownerId, 'content', 'PATCH', {
      content_type: type, adaptive_asset_id: assetId, source_version: Math.max(1, version), fallback_reason: null,
    });
  }

  async heartbeat(id: string, ownerId: number): Promise<void> {
    await this.internal(id, ownerId, 'heartbeat', 'PATCH');
  }

  async stop(id: string, ownerId: number): Promise<void> {
    await this.internal(id, ownerId, 'stop', 'PATCH');
  }

  private async internal<T>(id: string, ownerId: number, operation: string, method: string, body?: unknown): Promise<T> {
    const suffix = operation === 'publisher' ? 'publisher' : operation;
    const response = await requestJson<Data<T>>(
      `${this.baseUrl}/api/internal/adaptive/live-sessions/${encodeURIComponent(id)}/${suffix}`,
      { method, headers: { 'X-Adaptive-Secret': this.secret, 'X-Adaptive-Owner-Id': String(ownerId), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    );
    return response.data;
  }
}
