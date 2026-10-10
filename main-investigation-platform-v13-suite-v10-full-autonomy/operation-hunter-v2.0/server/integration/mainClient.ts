import type { FetchLike } from '../collectors/http.js';
import { sleep } from '../core/util.js';

export interface MainConfig {
  url: string;
  apiKey: string;
  sitesToken?: string;
  hunterUrl?: string;
  enabled: boolean;
  syncDemo?: boolean;
  autoIngest?: boolean;
  /** v2.0: give each reconstructed operation (2+ member sites) its own Main investigation. */
  autoInvestigation?: boolean;
}

export class MainApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public retryable = false) {
    super(message);
  }
}

export const MODULE_NAME = 'operation_hunter';

/** Thin, retrying client for the Main Investigation Platform API (module: operation_hunter). */
export class MainClient {
  constructor(public config: MainConfig, private fetchImpl: FetchLike) {}

  private base() {
    return this.config.url.replace(/\/+$/, '');
  }

  async request<T = any>(method: string, path: string, body?: unknown, opts: { auth?: boolean; retries?: number; allow404?: boolean } = {}): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'OperationHunter/2.0' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false) headers['x-api-key'] = this.config.apiKey;
    if (this.config.sitesToken) headers['OAI-Sites-Authorization'] = `Bearer ${this.config.sitesToken}`;
    const retries = opts.retries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.base()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        const text = await res.text();
        let parsed: any = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        if (res.status === 204) return { status: 204, body: null as T };
        if (res.status === 404 && opts.allow404) return { status: 404, body: parsed as T };
        if (res.status === 429 || res.status >= 500) throw new MainApiError(res.status, parsed?.error?.message ?? `HTTP ${res.status}`, parsed?.error?.code, true);
        if (!res.ok) throw new MainApiError(res.status, parsed?.error?.message ?? `HTTP ${res.status}`, parsed?.error?.code, false);
        return { status: res.status, body: parsed as T };
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof MainApiError ? err.retryable : true;
        if (!retryable || attempt >= retries) break;
        await sleep(400 * 2 ** attempt);
      }
    }
    if (lastErr instanceof MainApiError) throw lastErr;
    throw new MainApiError(0, lastErr instanceof Error ? lastErr.message : 'Main Platform unreachable', 'NETWORK', true);
  }

  register(meta: { version: string; uiUrl?: string; instanceId?: string }) {
    return this.request('POST', `/api/v1/modules/${MODULE_NAME}/register`, {
      module_version: meta.version, schema_version: '3.0',
      capabilities: ['operation:hunt', 'operation:reconstruct', 'operation:reappearance', 'operation:monitor', 'operation:model'],
      supported_event_types: ['site.discovered', 'site.triaged', 'site.investigated', 'wallet.observed', 'wallet.validated', 'wallet.analyzed', 'evidence.added', 'relationship.discovered', 'investigation.updated'],
      metadata: { ui_url: meta.uiUrl, instance_id: meta.instanceId, product: 'Operation Hunter', sync_schema: '2.0', job_types: ['HUNT_OPERATION'] },
    });
  }

  heartbeat(meta: { version: string; status: 'idle' | 'running' | 'error'; error?: string | null }) {
    return this.request('POST', `/api/v1/modules/${MODULE_NAME}/heartbeat`, {
      module_version: meta.version, schema_version: '3.0', status: meta.status,
      capabilities: ['operation:hunt', 'operation:reconstruct', 'operation:reappearance', 'operation:monitor', 'operation:model'], error: meta.error ?? null,
    });
  }

  pendingEvents(limit = 50) {
    return this.request<{ events: any[] }>('GET', `/api/v1/modules/${MODULE_NAME}/events?limit=${limit}`);
  }

  ackEvent(deliveryId: string) {
    return this.request('POST', `/api/v1/modules/${MODULE_NAME}/events/${encodeURIComponent(deliveryId)}`, {});
  }

  claimJob() {
    return this.request<{ job: any } | null>('POST', `/api/v1/modules/${MODULE_NAME}/jobs/claim`, {});
  }

  updateJob(id: string, action: 'progress' | 'complete' | 'fail' | 'needs-review', body: { progress?: number; message?: string; result?: unknown; error?: string; retry?: boolean } = {}) {
    return this.request('PATCH', `/api/v1/modules/${MODULE_NAME}/jobs/${encodeURIComponent(id)}`, { action, ...body });
  }

  syncOperation(payload: unknown) {
    return this.request<{ operation_id: string; created: boolean; campaign_id?: string | null; proposals?: any; changes?: any; members?: any; contradictions?: number }>('POST', '/api/v1/operations/sync', payload);
  }

  operationRequest(hunterOperationId: string, payload: unknown) {
    return this.request('POST', `/api/v1/operations/${encodeURIComponent(hunterOperationId)}/requests`, payload);
  }

  ingest(batch: unknown) {
    return this.request('POST', `/api/v1/ingest/${MODULE_NAME}`, batch);
  }

  search(q: string) {
    return this.request<{ results: any[] }>('GET', `/api/v1/search?q=${encodeURIComponent(q)}`, undefined, { auth: false });
  }

  context(investigationId: string) {
    return this.request<any>('GET', `/api/v1/investigations/${encodeURIComponent(investigationId)}/context?module=${MODULE_NAME}`, undefined, { allow404: true });
  }

  decisions(after: string) {
    return this.request<{ decisions: any[]; next_cursor: string }>('GET', `/api/v1/inbox/decisions?module=${MODULE_NAME}&after=${encodeURIComponent(after)}&limit=200`);
  }

  health() {
    return this.request<any>('GET', '/api/v1/health', undefined, { auth: false, retries: 0 });
  }
}
