// Runs the real Main Platform API (every app/api/**/route.ts, bundled with esbuild) over HTTP on a
// file-backed node:sqlite D1 double. Used by the joined, whole-workflow and UI acceptance tests.
// Only the Cloudflare `env` binding is substituted; the route handlers and lib/ code are real.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import {dirname, join, relative, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {importFile, repoRoot} from './portable.mjs';

export const MODULE_KEYS = {site_finder: 'finder-key', site_investigator: 'investigator-key', crypto_wallet_logger: 'logger-key', wallet_investigator: 'wallet-key', form_submitter: 'form-key', operation_hunter: 'hunter-key'};

export function routesOf(dir) {
  const api = join(dir, 'app', 'api');
  const out = [];
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n === 'route.ts') out.push(p); } };
  walk(api);
  return out.map(file => {
    const segs = relative(join(dir, 'app'), dirname(file)).split(sep);
    const names = [];
    const re = new RegExp('^/' + segs.map(s => { const m = s.match(/^\[(.+)\]$/); if (m) { names.push(m[1]); return '([^/]+)'; } return s.replace(/[.*+?^${}()|\\]/g, '\\$&'); }).join('/') + '$');
    return {file, rel: relative(dir, file), re, names, score: segs.filter(s => !s.startsWith('[')).length * 100 - names.length};
  }).sort((a, b) => b.score - a.score);
}

export function applyMigrations(dbFile, filter = () => true, dir = join(repoRoot, 'drizzle')) {
  const sql = new DatabaseSync(dbFile);
  sql.exec('PRAGMA foreign_keys=ON');
  const applied = [];
  for (const name of readdirSync(dir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort().filter(filter)) { sql.exec(readFileSync(join(dir, name), 'utf8')); applied.push(name); }
  sql.close();
  return applied;
}

let builds = 0;
/**
 * Starts one Main instance (its own build, i.e. a fresh process image) on `dbFile`.
 * `extra(req, res, url)` may serve additional paths (e.g. the UI bundle) and returns true if it did.
 */
export async function startMain({dbFile, codeDir = repoRoot, work, label = 'main', keys = MODULE_KEYS, log = [], extra = null, port = 0, faultHook = null, libraryFiles = []}) {
  const sql = new DatabaseSync(dbFile);
  sql.exec('PRAGMA foreign_keys=ON');
  // Node 22 treats SQLite ?1 parameters as named bindings; D1 and Node 24 accept positional values.
  const execute=(statement,params,method)=>{try{const numbered=[...statement.matchAll(/\?(\d+)/g)];const args=numbered.length?[Object.fromEntries(numbered.map(m=>[m[0],params[Number(m[1])-1]]))]:params;return sql.prepare(statement)[method](...args);}catch(e){if(process.env.MIP_TEST_SQL_TRACE==='1')console.error('SQL execution failed',statement,'parameter count',params.length);throw e;}};
  const d1 = {
    prepare(statement) {
      let params = [];
      return {
        __sql: statement,
        bind(...v) { params = v; return this; },
        __runSync() { faultHook?.('before_statement',statement); const r = execute(statement,params,'run'); faultHook?.('after_statement',statement); return {meta: {changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid)}}; },
        async run() { return this.__runSync(); },
        async first() { faultHook?.('before_read',statement);const row=execute(statement,params,'get')??null;faultHook?.('after_read',statement);return row; },
        async all() { faultHook?.('before_read',statement);const rows=execute(statement,params,'all');faultHook?.('after_read',statement);return {results:rows}; },
      };
    },
    async batch(qs) { faultHook?.('before_batch',qs.map(q=>q.__sql).join('\n')); sql.exec('BEGIN'); try { const out = []; for (const q of qs) out.push(q.__runSync()); sql.exec('COMMIT'); faultHook?.('after_batch',qs.map(q=>q.__sql).join('\n')); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; } },
    async exec(s) { sql.exec(s); return {count: 1}; },
  };
  globalThis.__TEST_ENV = {DB: d1, AI_PROVIDER: 'rules', MODULE_API_KEYS: JSON.stringify(keys)};
  const routes = routesOf(codeDir);
  const out = join(work, `build-${label}-${++builds}`);
  await build({
    entryPoints: [...routes.map(r => r.file),...libraryFiles.map(f=>join(codeDir,f))], absWorkingDir: codeDir, bundle: true, splitting: true, format: 'esm', platform: 'node', outdir: out, outbase: codeDir, logLevel: 'error',
    plugins: [{name: 'env', setup(p) {
      p.onResolve({filter: /^cloudflare:workers$/}, () => ({path: 'env', namespace: 'm'}));
      p.onLoad({filter: /.*/, namespace: 'm'}, () => ({contents: 'export const env=new Proxy({},{get:(_,k)=>globalThis.__TEST_ENV[k],has:(_,k)=>k in globalThis.__TEST_ENV})', loader: 'js'}));
    }}],
  });
  for (const r of routes) r.mod = await importFile(join(out, r.rel.replace(/\.ts$/, '.js')));
  const library=Object.fromEntries(await Promise.all(libraryFiles.map(async f=>[f,await importFile(join(out,f.replace(/\.ts$/,'.js')))])));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (extra && !url.pathname.startsWith('/api/') && await extra(req, res, url)) return;
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    for (const r of routes) {
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const handler = r.mod[req.method ?? 'GET'];
      if (!handler) { res.writeHead(405); res.end(); log.push(`${req.method} ${url.pathname} 405`); return; }
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const request = new Request(url.toString(), {method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body});
      try {
        const response = await handler(request, {params: Promise.resolve(params)});
        const buf = Buffer.from(await response.arrayBuffer());
        log.push(`${req.method} ${url.pathname} ${response.status}${response.status >= 400 ? ` ${buf.toString('utf8').slice(0, 600)}` : ''}`);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(buf);
      } catch (err) {
        log.push(`${req.method} ${url.pathname} 500 ${err?.stack ?? err}`);
        res.writeHead(500, {'content-type': 'application/json'}); res.end(JSON.stringify({error: {message: String(err)}}));
      }
      return;
    }
    log.push(`${req.method} ${url.pathname} 404`);
    res.writeHead(404, {'content-type': 'application/json'}); res.end(JSON.stringify({error: {code: 'NOT_FOUND'}}));
  });
  let closing = null;
  // Browser fixture preparation may take longer than Node's default 5s idle
  // timeout. Keep pooled test-client sockets valid across that preparation;
  // this avoids a Node 22 stale keep-alive race without replaying mutations.
  server.keepAliveTimeout = 60000;
  server.headersTimeout = 65000;
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, key) => {
    const r = await fetch(base + p, {method, headers: {'content-type': 'application/json', ...(key ? {'x-api-key': key} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await r.text(); let json = text; try { json = JSON.parse(text); } catch { /* text */ }
    return {status: r.status, body: json};
  };
  return {
    url: base, call, log, sql, library,
    one: (q, ...a) => sql.prepare(q).get(...a), all: (q, ...a) => sql.prepare(q).all(...a),
    n: (q, ...a) => Number(sql.prepare(q).get(...a).n),
    // Idempotent: closing twice (e.g. once in the test and again in its cleanup) is harmless.
    close: () => closing ??= new Promise(r => { server.close(() => { if (sql.isOpen !== false) sql.close(); r(); }); server.closeAllConnections?.(); }),
  };
}
