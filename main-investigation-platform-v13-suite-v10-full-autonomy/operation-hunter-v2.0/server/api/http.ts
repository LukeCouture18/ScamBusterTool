import type { IncomingMessage, ServerResponse } from 'node:http';
import { HunterError } from '../core/util.js';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  path: string;
}

type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; raw?: boolean }

export class RawResponse {
  constructor(public status: number, public body: string | Buffer, public headers: Record<string, string>) {}
}

/** Minimal dependency-free JSON router. */
export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, raw = false) {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/\/:([a-zA-Z]+)/g, (_m, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
    this.routes.push({ method, pattern, keys, handler, raw });
    return this;
  }
  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  patch(p: string, h: Handler) { return this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { return this.add('DELETE', p, h); }
  /** Handler writes to ctx.res itself (e.g. server-sent events). */
  stream(p: string, h: Handler) { return this.add('GET', p, h, true); }

  /** Returns false when no route matched (so the caller can serve the UI). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    if (!url.pathname.startsWith('/api/')) return false;
    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return true;
    }
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
        const ctx: RequestContext = { req, res, params, query: url.searchParams, body, path: url.pathname };
        const result = await route.handler(ctx);
        if (route.raw) return true;
        if (result instanceof RawResponse) {
          res.writeHead(result.status, { ...corsHeaders(), ...result.headers });
          res.end(result.body);
        } else {
          send(res, 200, result ?? { ok: true });
        }
      } catch (error) {
        const status = error instanceof HunterError ? error.status : error instanceof SyntaxError ? 400 : 500;
        const code = error instanceof HunterError ? error.code : error instanceof SyntaxError ? 'INVALID_JSON' : 'INTERNAL_ERROR';
        if (status >= 500) console.error(`[api] ${method} ${url.pathname}`, error);
        send(res, status, { error: error instanceof Error ? error.message : String(error), code, details: error instanceof HunterError ? error.details : undefined });
      }
      return true;
    }
    send(res, 404, { error: `No route for ${method} ${url.pathname}`, code: 'NOT_FOUND' });
    return true;
  }
}

function corsHeaders(): Record<string, string> {
  const origin = process.env.HUNTER_CORS_ORIGIN;
  return origin ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type,x-api-key', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' } : {};
}

export function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders() });
  res.end(json);
}

async function readBody(req: IncomingMessage, limit = 12 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HunterError('REQUEST_TOO_LARGE', 'Request body exceeds 12 MB', 413);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) return {};
  return JSON.parse(text);
}
