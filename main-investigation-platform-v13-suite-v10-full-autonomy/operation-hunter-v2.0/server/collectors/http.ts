import type { HunterStore } from '../core/store.js';
import { sha256, sleep } from '../core/util.js';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;

export interface HttpRequest {
  url: string;
  collector: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  ttlSeconds?: number;      // response cache lifetime; 0 disables caching
  timeoutMs?: number;
  bypassCache?: boolean;
  accept404?: boolean;      // treat 404 as an empty (cacheable) answer
}

export interface HttpResponse<T = any> { status: number; body: T; cached: boolean; url: string }

export class HttpError extends Error {
  constructor(public status: number, message: string, public url: string, public retryable: boolean) {
    super(message);
  }
}

const USER_AGENT = 'OperationHunter/1.0 (passive public-source research; +https://localhost)';
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Outbound HTTP for passive collectors: per-host pacing, retry with backoff on
 * 429/5xx, response caching in SQLite (so repeated pursuits and monitors do not
 * re-query sources), a size cap, and a timeout. Tests inject `fetchImpl`.
 */
export class HttpClient {
  private lastRequestAt = new Map<string, number>();
  private hostQueues = new Map<string, Promise<void>>();
  requestCount = 0;

  constructor(
    private store: HunterStore,
    public fetchImpl: FetchLike = (globalThis.fetch as unknown as FetchLike),
    private minIntervalMs: Record<string, number> = {},
  ) {}

  setPacing(host: string, ms: number) {
    this.minIntervalMs[host] = ms;
  }

  async json<T = any>(req: HttpRequest): Promise<HttpResponse<T>> {
    return this.request<T>(req, true);
  }

  async text(req: HttpRequest): Promise<HttpResponse<string>> {
    return this.request<string>(req, false);
  }

  private async request<T>(req: HttpRequest, parseJson: boolean): Promise<HttpResponse<T>> {
    const method = req.method ?? 'GET';
    const cacheKey = `${req.collector}:${method}:${req.url}:${req.body ? sha256(req.body).slice(0, 16) : ''}`;
    const ttl = req.ttlSeconds ?? 6 * 3600;
    if (!req.bypassCache && ttl > 0) {
      const cached = this.store.getCached(cacheKey);
      if (cached) return { status: cached.status, body: cached.body as T, cached: true, url: req.url };
    }
    const host = safeHost(req.url);
    let attempt = 0;
    let lastError: unknown;
    while (attempt < 3) {
      attempt++;
      await this.pace(host);
      try {
        this.requestCount++;
        const response = await this.fetchImpl(req.url, {
          method,
          headers: { 'user-agent': USER_AGENT, accept: parseJson ? 'application/json' : '*/*', ...(req.headers ?? {}) },
          body: req.body,
          signal: AbortSignal.timeout(req.timeoutMs ?? 20000),
        });
        const text = await response.text();
        if (text.length > MAX_BYTES) throw new HttpError(response.status, 'Response too large', req.url, false);
        if (response.status === 404 && req.accept404) {
          const body = (parseJson ? null : '') as T;
          if (ttl > 0) this.store.setCached(cacheKey, req.collector, 404, body, ttl);
          return { status: 404, body, cached: false, url: req.url };
        }
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Math.min(10, Number(response.headers.get('retry-after') ?? 0) || 0);
          if (retryAfter > 0 && attempt < 3) await sleep(retryAfter * 1000);
          throw new HttpError(response.status, `HTTP ${response.status} from ${host}`, req.url, true);
        }
        if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status}`, req.url, false);
        let body: any = text;
        if (parseJson) {
          try {
            body = text.trim() ? JSON.parse(text) : null;
          } catch {
            throw new HttpError(response.status, 'Invalid JSON response', req.url, false);
          }
        }
        if (ttl > 0) this.store.setCached(cacheKey, req.collector, response.status, body, ttl);
        return { status: response.status, body: body as T, cached: false, url: req.url };
      } catch (error) {
        lastError = error;
        const retryable = error instanceof HttpError ? error.retryable : isTransient(error);
        if (!retryable || attempt >= 3) break;
        await sleep(attempt * 1200);
      }
    }
    if (lastError instanceof HttpError) throw lastError;
    throw new HttpError(0, lastError instanceof Error ? lastError.message : 'Network error', req.url, true);
  }

  private async pace(host: string) {
    const interval = this.minIntervalMs[host] ?? 250;
    const previous = this.hostQueues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => (release = resolve));
    this.hostQueues.set(host, previous.then(() => mine));
    await previous;
    const wait = (this.lastRequestAt.get(host) ?? 0) + interval - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt.set(host, Date.now());
    release();
  }
}

function safeHost(url: string) {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

function isTransient(error: unknown) {
  const msg = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|network/i.test(msg);
}
