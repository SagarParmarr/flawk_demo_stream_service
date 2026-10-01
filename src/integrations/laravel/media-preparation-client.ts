import type { MediaPreparationJob, MediaPreparationQueue, MediaPreparationResult } from '../../domain/media-preparation.js';
import { requestJson } from '../http.js';

export class MediaPreparationClient implements MediaPreparationQueue {
  constructor(private readonly baseUrl: string, private readonly secret: string) {}

  async claim(): Promise<MediaPreparationJob | null> {
    const response = await this.request<{ job: MediaPreparationJob | null }>('claim', {});
    return response.data.job;
  }

  async current(job: MediaPreparationJob): Promise<boolean> {
    return (await this.request<{ current: boolean }>('current', this.identity(job))).data.current;
  }

  async complete(job: MediaPreparationJob, result: MediaPreparationResult): Promise<boolean> {
    return (await this.request<{ accepted: boolean }>('complete', { ...this.identity(job), ...result })).data.accepted;
  }

  async fail(job: MediaPreparationJob): Promise<void> {
    await this.request('fail', this.identity(job));
  }

  private identity(job: MediaPreparationJob): Record<string, unknown> {
    return { asset_id: job.asset_id, generation: job.generation, token: job.token };
  }

  private request<T>(action: string, body: Record<string, unknown>): Promise<{ data: T }> {
    return requestJson(`${this.baseUrl}/api/internal/demo-media/${action}`, {
      method: 'POST', headers: { 'X-Demo-Stream-Secret': this.secret, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
