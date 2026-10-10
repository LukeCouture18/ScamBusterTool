import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HunterApp, AppOptions } from '../server/app.ts';
import type { FetchLike } from '../server/collectors/http.ts';

export function makeApp(opts: AppOptions = {}) {
  const app = new HunterApp({ filename: ':memory:', seedDemo: false, networkMode: 'offline', ...opts });
  app.analyzer.debounceMs = 5;
  return app;
}

export interface FakeRoute { match: (url: string, init?: any) => boolean; respond: (url: string, init?: any) => { status?: number; body: any; headers?: Record<string, string> } }

/** A fake internet: routes URL patterns to canned API responses (real response formats). */
export function fakeFetch(routes: FakeRoute[], log: string[] = []): FetchLike {
  return async (url: string, init?: any) => {
    log.push(`${init?.method ?? 'GET'} ${url}`);
    const route = routes.find(r => r.match(url, init));
    const out = route ? route.respond(url, init) : { status: 404, body: { error: 'not found' } };
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    const status = out.status ?? 200;
    return { ok: status >= 200 && status < 300, status, headers: { get: (n: string) => out.headers?.[n.toLowerCase()] ?? null }, text: async () => text };
  };
}

export const on = (fragment: string | RegExp, respond: FakeRoute['respond']): FakeRoute => ({
  match: url => (typeof fragment === 'string' ? url.includes(fragment) : fragment.test(url)),
  respond,
});

/** DNS resolver double with node:dns-like API. */
export function fakeResolver(zone: Record<string, Partial<Record<'A' | 'AAAA' | 'NS' | 'MX' | 'TXT' | 'CNAME', any>>>) {
  const answer = (host: string, type: string) => {
    const rec = zone[host]?.[type as 'A'];
    if (!rec) return Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
    return Promise.resolve(rec);
  };
  return {
    setServers() {},
    resolve4: (h: string) => answer(h, 'A'), resolve6: (h: string) => answer(h, 'AAAA'), resolveNs: (h: string) => answer(h, 'NS'),
    resolveMx: (h: string) => answer(h, 'MX'), resolveTxt: (h: string) => answer(h, 'TXT'), resolveCname: (h: string) => answer(h, 'CNAME'),
  };
}

export const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

const tempDirs: string[] = [];
/**
 * A fresh temporary directory, removed when the test process exits (after every store is closed).
 * Removal is best effort: on Windows a file still held open is left for the OS temp cleaner rather
 * than failing the run.
 */
export function tempDir(prefix: string): string {
  if (tempDirs.length === 0) {
    process.on('exit', () => {
      for (const dir of tempDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
      }
    });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
