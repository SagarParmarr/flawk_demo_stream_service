export class UpstreamError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Upstream request failed (${status})`);
  }
}

export async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  if (!response.ok) throw new UpstreamError(response.status, body.slice(0, 1000));
  try { return JSON.parse(body) as T; }
  catch { throw new Error('Upstream returned invalid JSON'); }
}
