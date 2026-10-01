import type { CaptureSession, Decision } from '../../domain/demo.js';
import { requestJson } from '../http.js';

interface Data<T> { data: T }
interface Feed { owner_id: number; unit_ids: number[]; state: string; generated_at?: string; decisions: Decision[] }

export class LaravelClient {
  constructor(private readonly baseUrl: string, private readonly secret: string) {}

  async validate(sessionId: string, bearer: string): Promise<CaptureSession> {
    // The caller's token is used only in this request. It never enters durable worker state.
    const response = await requestJson<Data<CaptureSession>>(
      `${this.baseUrl}/api/mobile/adaptive-sessions/${encodeURIComponent(sessionId)}/status`,
      { headers: { Authorization: bearer, Accept: 'application/json' } },
    );
    return response.data;
  }

  async decisions(sessionId: string, afterCycle: number): Promise<Feed> {
    const query = new URLSearchParams({ after_cycle: String(afterCycle), limit: '20' });
    const response = await requestJson<Data<Feed>>(
      `${this.baseUrl}/api/internal/demo-sessions/${encodeURIComponent(sessionId)}/decisions?${query}`,
      { headers: this.headers() },
    );
    return response.data;
  }

  async bind(sessionId: string, demoId: string, goLiveId: string, ownerId: number, unitId: number): Promise<void> {
    await requestJson<unknown>(`${this.baseUrl}/api/internal/demo-sessions/${encodeURIComponent(sessionId)}/bind`, {
      method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ demo_stream_id: demoId, go_live_session_id: goLiveId, owner_id: ownerId, unit_id: unitId }),
    });
  }

  async stop(sessionId: string): Promise<void> {
    await requestJson<unknown>(`${this.baseUrl}/api/internal/demo-sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST', headers: this.headers() });
  }

  private headers(): HeadersInit {
    return { 'X-Demo-Stream-Secret': this.secret, Accept: 'application/json' };
  }
}
