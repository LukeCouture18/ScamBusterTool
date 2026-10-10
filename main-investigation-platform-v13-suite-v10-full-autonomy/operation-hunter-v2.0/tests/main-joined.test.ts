import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HunterApp } from '../server/app.ts';
import { IntegrationWorker } from '../server/integration/worker.ts';
import { generateWorld, truthDomains, advance } from '../bench/world.ts';
import { fakeNetwork, PACED_HOSTS } from '../bench/fakeNetwork.ts';

/**
 * The real Hunter <-> Main workflow, end to end, over real HTTP:
 *
 *   Main Platform v5 · Operations (its actual route handlers, scheduler, executor, temporal,
 *   inbox and ingestion code, on a SQLite D1 double with every migration applied)
 *   <->  Operation Hunter v2.0 (its actual integration worker and pursuit engine; public
 *        sources are the synthetic ground-truth world, so no real network is touched).
 *
 *   1. an operator asks Main to reconstruct the operation behind a reported site
 *   2. Main's scheduler turns that into a HUNT_OPERATION job for operation_hunter
 *   3. Hunter claims it, reconstructs the operation, creates its Main investigation,
 *      ingests members and evidence, and syncs its living model and proposals
 *   4. Main turns proposals into its own work (inbox candidates, wallet analyses), feeds
 *      Hunter's site observations into its temporal layer, reconciles the job's usefulness
 *   5. a person rejects a member site in Main's inbox -> Hunter's membership learns from it
 *   6. Site Finder later reports a new site of the same operation -> Hunter recognises the return
 *
 * Requires a Main Platform checkout (MAIN_DIR, default: the sibling folder containing it) with its dependencies installed.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
// MAIN_DIR, else the sibling folder that holds Main Platform with the Hunter migration.
const hasMain = (d: string) => fs.existsSync(path.join(d, 'drizzle', '0012_operation_hunter.sql')) && fs.existsSync(path.join(d, 'sdk', 'contracts', 'v6.json'));
const parent = path.join(here, '..', '..');
const MAIN_DIR = path.resolve(process.env.MAIN_DIR ?? (fs.readdirSync(parent).map(n => path.join(parent, n)).find(hasMain) ?? path.join(parent, 'main5')));
const available = hasMain(MAIN_DIR) && fs.existsSync(path.join(MAIN_DIR, 'node_modules', 'esbuild'));

const ROUTES: Array<[string, string]> = [
  ['/api/v1/modules/:module/register', 'app/api/v1/modules/[module]/register/route.ts'],
  ['/api/v1/modules/:module/heartbeat', 'app/api/v1/modules/[module]/heartbeat/route.ts'],
  ['/api/v1/modules/:module/jobs/claim', 'app/api/v1/modules/[module]/jobs/claim/route.ts'],
  ['/api/v1/modules/:module/jobs/:id', 'app/api/v1/modules/[module]/jobs/[id]/route.ts'],
  ['/api/v1/modules/:module/events/:id', 'app/api/v1/modules/[module]/events/[id]/route.ts'],
  ['/api/v1/modules/:module/events', 'app/api/v1/modules/[module]/events/route.ts'],
  ['/api/v1/ingest/:module', 'app/api/v1/ingest/[module]/route.ts'],
  ['/api/v1/operations/sync', 'app/api/v1/operations/sync/route.ts'],
  ['/api/v1/operations/reconstruct', 'app/api/v1/operations/reconstruct/route.ts'],
  ['/api/v1/operations/:id/requests', 'app/api/v1/operations/[id]/requests/route.ts'],
  ['/api/v1/operations/:id', 'app/api/v1/operations/[id]/route.ts'],
  ['/api/v1/operations', 'app/api/v1/operations/route.ts'],
  ['/api/v1/ops/tick', 'app/api/v1/ops/tick/route.ts'],
  ['/api/v1/ops/overview', 'app/api/v1/ops/overview/route.ts'],
  ['/api/v1/inbox/decisions', 'app/api/v1/inbox/decisions/route.ts'],
  ['/api/v1/inbox/:id/decision', 'app/api/v1/inbox/[id]/decision/route.ts'],
  ['/api/v1/search', 'app/api/v1/search/route.ts'],
  ['/api/v1/investigations/:id/context', 'app/api/v1/investigations/[id]/context/route.ts'],
  ['/api/v1/health', 'app/api/v1/health/route.ts'],
];

async function startMain() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  const dir = path.join(MAIN_DIR, 'drizzle');
  for (const name of fs.readdirSync(dir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sql.exec(fs.readFileSync(path.join(dir, name), 'utf8'));
  const d1 = {
    prepare(statement: string) {
      let params: unknown[] = [];
      return {
        bind(...v: unknown[]) { params = v; return this; },
        async run() { const r = sql.prepare(statement).run(...(params as any[])); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
        async first() { return sql.prepare(statement).get(...(params as any[])) ?? null; },
        async all() { return { results: sql.prepare(statement).all(...(params as any[])) }; },
      };
    },
    async batch(qs: Array<{ run(): Promise<unknown> }>) { sql.exec('BEGIN'); try { const out = []; for (const s of qs) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; } },
  };
  (globalThis as any).__TEST_ENV = { DB: d1, AI_PROVIDER: 'rules', MODULE_API_KEYS: JSON.stringify({ site_finder: 'finder-key', site_investigator: 'investigator-key', crypto_wallet_logger: 'logger-key', wallet_investigator: 'wallet-key', operation_hunter: 'hunter-key' }) };
  const require = createRequire(path.join(MAIN_DIR, 'package.json'));
  const { build } = require('esbuild');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-main-joined-'));
  await build({
    entryPoints: ROUTES.map(r => r[1]), absWorkingDir: MAIN_DIR, bundle: true, splitting: true, format: 'esm', platform: 'node', outdir: out, outbase: '.', logLevel: 'error',
    plugins: [{ name: 'env', setup(p: any) { p.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'env', namespace: 'm' })); p.onLoad({ filter: /.*/, namespace: 'm' }, () => ({ contents: 'export const env=globalThis.__TEST_ENV', loader: 'js' })); } }],
  });
  const handlers = new Map<string, any>();
  for (const [, file] of ROUTES) handlers.set(file, await import(pathToFileURL(path.join(out, file.replace(/\.ts$/, '.js'))).href));
  const log: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    for (const [pattern, file] of ROUTES) {
      const names: string[] = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_m, n) => { names.push(n); return '([^/]+)'; }) + '$');
      const m = url.pathname.match(re);
      if (!m) continue;
      const handler = handlers.get(file)[req.method ?? 'GET'];
      if (!handler) break;
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const request = new Request(url.toString(), { method: req.method, headers: req.headers as any, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body });
      try {
        const response: Response = await handler(request, { params: Promise.resolve(params) });
        log.push(`${req.method} ${url.pathname} ${response.status}`);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (err) {
        log.push(`${req.method} ${url.pathname} 500 ${err}`);
        res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: String(err) } }));
      }
      return;
    }
    log.push(`${req.method} ${url.pathname} 404`);
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, p: string, body?: unknown, key?: string) => {
    const r = await fetch(url + p, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = text; try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: json };
  };
  const one = (q: string, ...a: any[]) => sql.prepare(q).get(...a) as any;
  const all = (q: string, ...a: any[]) => sql.prepare(q).all(...a) as any[];
  return { url, call, one, all, sql, log, close: () => { server.close(); sql.close(); fs.rmSync(out, { recursive: true, force: true }); } };
}

test('joined: Main asks, Hunter reconstructs, Main acts on Hunter\'s proposals, both learn', { skip: available ? false : `Main Platform with migration 0012 and dependencies not found at ${MAIN_DIR}` }, async () => {
  const main = await startMain();
  const w = generateWorld(3, { difficulty: 0.3 });
  const net = fakeNetwork(w);
  const realFetch = globalThis.fetch;
  const fetchImpl = (async (u: string, init?: any) => (u.startsWith(main.url) ? realFetch(u, init) : net.fetch(u, init))) as any;
  const app = new HunterApp({ filename: ':memory:', seedDemo: false, networkMode: 'live', fetchImpl, dnsResolver: net.resolver });
  for (const h of PACED_HOSTS) app.http.setPacing(h, 0);
  app.analyzer.debounceMs = 5;
  app.integration = new IntegrationWorker(app);
  app.integration.configure({ url: main.url, apiKey: 'hunter-key', enabled: true, hunterUrl: 'http://hunter.local' });
  try {
    // ---------------------------------------------------------------- 0. Hunter registers; Main sees a module with operation:reconstruct
    const first = await app.integration.cycle();
    assert.equal(first.errors.length, 0, JSON.stringify(first.errors));
    const reg = main.one("SELECT * FROM module_registry WHERE module_name='operation_hunter'");
    assert.ok(reg && JSON.parse(reg.capabilities).includes('operation:reconstruct'), 'Hunter registered with its capabilities');

    // ---------------------------------------------------------------- 1. operator asks Main to reconstruct the operation behind a reported site
    const target = w.ops.find(o => o.id === w.target)!;
    const seed = target.domains.map(d => w.domains.get(d)!).filter(d => d.registeredAt >= 40 && d.registeredAt < 80 && d.kit && d.ns[0].includes('-dns.'))[0]?.name ?? target.domains[3];
    const asked = await main.call('POST', '/api/v1/operations/reconstruct', { domain: seed });
    assert.equal(asked.status, 202);
    // ---------------------------------------------------------------- 2. Main's scheduler decides to run it: a HUNT_OPERATION job for operation_hunter
    const tick1 = await main.call('POST', '/api/v1/ops/tick');
    assert.equal(tick1.status, 200, JSON.stringify(tick1.body));
    const wi = main.one("SELECT * FROM work_items WHERE kind='reconstruct_operation' AND target_key=?", seed);
    assert.equal(wi.status, 'running', `work item ${wi.status}: ${wi.last_error ?? wi.result}`);
    const job = main.one('SELECT * FROM jobs WHERE id=?', wi.job_id);
    assert.equal(job.job_type, 'HUNT_OPERATION');
    assert.equal(job.target_module, 'operation_hunter');
    assert.match(job.payload, /automation_policy/, 'the platform policy travels with the job');

    // ---------------------------------------------------------------- 3. Hunter claims it and reconstructs
    const c2 = await app.integration.cycle();
    assert.equal(c2.jobs, 1, JSON.stringify(c2));
    const op = app.store.getOperations().find(o => o.initialSeed === seed)!;
    assert.ok(op, 'Hunter created an operation for the request');
    app.allocator.seed(3);
    await app.pursuit.runToCompletion(op.id, { budgetTotal: 70, maxHops: 5, concurrency: 3, maxMinutes: 600 }, 75);
    const a = app.analyzer.analyze(op.id)!;
    const truth = new Set(truthDomains(w));
    const members = a.model.sites.filter(s => s.membership === 'member').map(s => s.value);
    assert.ok(members.length >= 3, `members: ${members.join(', ')}`);
    assert.ok(members.every(m => truth.has(m)), `no false members: ${members.filter(m => !truth.has(m)).join(', ')}`);
    app.integration.queueSync(op.id);
    const c3 = await app.integration.cycle();
    assert.equal(c3.errors.length, 0, JSON.stringify(c3.errors) + '\n' + main.log.slice(-10).join('\n'));

    // ---------------------------------------------------------------- 4. Main receives the living model, members, evidence and proposals
    const hop = main.one('SELECT * FROM hunter_operations WHERE external_id=?', op.id);
    assert.ok(hop, 'Main stores the operation');
    assert.notEqual(hop.model_status, 'unknown');
    assert.ok(JSON.parse(hop.discoveries).length >= 3, 'the 3-5 strongest discoveries travel with it');
    assert.ok(JSON.parse(hop.explanations).length >= 1, 'competing explanations travel with it');
    const mainMembers = main.all("SELECT * FROM hunter_operation_members WHERE operation_id=? AND entity_type='site' AND role IN ('member','seed')", hop.id).map(r => r.canonical_key);
    assert.deepEqual(new Set(mainMembers), new Set(members));
    assert.ok(main.all("SELECT * FROM hunter_operation_members WHERE operation_id=? AND entity_type='wallet'", hop.id).length >= 1, 'operation wallets');
    // Hunter created and filled its own Main investigation
    const inv = main.one('SELECT * FROM investigations WHERE external_id=?', `hunter-op:${op.id}`);
    assert.ok(inv, 'Main investigation for the operation');
    assert.match(inv.description, /not proof of common ownership/);
    const invSites = main.all("SELECT e.canonical_key FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='site'", inv.id).map(r => r.canonical_key);
    for (const m of members) assert.ok(invSites.includes(m), `${m} ingested as a site`);
    assert.ok(Number(main.one("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND source_module='operation_hunter'", inv.id).n) > 0, 'evidence with provenance');
    // proposals became Main's own work: inbox candidates for member sites, wallet analyses
    const proposals = main.all('SELECT * FROM hunter_proposals WHERE operation_id=?', hop.id);
    assert.ok(proposals.some(p => p.kind === 'investigate_site' && p.outcome === 'candidate_created'), JSON.stringify(proposals.map(p => [p.kind, p.outcome])));
    const hunterCands = main.all("SELECT * FROM inbox_candidates WHERE source_module='operation_hunter'");
    assert.ok(hunterCands.length >= 2 && hunterCands.every(c => truth.has(c.canonical_domain)), 'only real members reach the inbox');
    for (const c of hunterCands) {
      assert.ok(c.investigation_id && JSON.parse(c.details).disclaimer, 'candidate retains its reporting context and attribution boundary');
      const ownSites = main.all("SELECT e.canonical_key FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='site'", c.investigation_id);
      assert.ok(ownSites.some(s => s.canonical_key === c.canonical_domain), 'candidate investigation contains the actual proposed deployment');
      assert.equal(JSON.parse(c.details).operation, op.id, 'Hunter association is retained independently of the site reporting boundary');
      assert.ok(main.one('SELECT id FROM investigations WHERE id=?', c.investigation_id), 'candidate has a durable investigation');
    }
    const walletWork = proposals.filter(p => p.kind === 'analyze_wallet' && p.outcome === 'work_proposed');
    assert.ok(walletWork.length >= 1, 'operation wallets became analyze_wallet work');
    assert.equal(main.one('SELECT kind FROM work_items WHERE id=?', walletWork[0].work_item_id).kind, 'analyze_wallet');
    // Hunter's site observations entered Main's temporal layer
    assert.ok(Number(main.one("SELECT COUNT(*) n FROM entity_facets WHERE source_table='hunter_operations'").n) >= members.length, 'site facets observed');
    // a second identical sync changes nothing (idempotent)
    const before = main.one('SELECT COUNT(*) n FROM work_items').n;
    app.integration.queueSync(op.id);
    await app.integration.cycle();
    assert.equal(main.one('SELECT COUNT(*) n FROM work_items').n, before, 'no duplicate work from a repeated snapshot');

    // ---------------------------------------------------------------- 5. Main reconciles the reconstruction: useful because it found members
    await main.call('POST', '/api/v1/ops/tick');
    const wiDone = main.one('SELECT * FROM work_items WHERE id=?', wi.id);
    assert.equal(wiDone.status, 'done', wiDone.last_error ?? '');
    assert.ok(JSON.parse(wiDone.result).useful >= 0.6, wiDone.result);
    const overview = await main.call('GET', '/api/v1/ops/overview');
    assert.ok(overview.body.reconstructions.operations.some((o: any) => o.external_id === op.id), 'Operations home shows the reconstruction');
    const detail = await main.call('GET', `/api/v1/operations/${op.id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.members.length >= members.length && detail.body.disclaimer);

    // ---------------------------------------------------------------- 6. a person rejects a member site in Main -> Hunter's membership learns
    const rejected = hunterCands.find(c => c.canonical_domain !== seed)!;
    const dec = await main.call('POST', `/api/v1/inbox/${rejected.id}/decision`, { decision: 'skip', reason: 'not_a_scam' });
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    await app.integration.cycle();
    const ent = app.store.findEntity(op.id, 'domain', rejected.canonical_domain)!;
    assert.equal(app.intel.membershipOf(op.id, ent.id)?.analystVerdict, 'not_member', 'Main inbox verdict reached Hunter');
    assert.equal(app.analyzer.analyze(op.id)!.membership.byId[ent.id].status, 'excluded');

    // ---------------------------------------------------------------- 7. later: Site Finder reports a new site of the same operation -> Hunter recognises the return
    advance(w, 30);
    const fresh = truthDomains(w).filter(d => !truth.has(d) && w.domains.get(d)!.kit);
    assert.ok(fresh.length, 'the world launched a new wave');
    const newSite = fresh[0];
    const ing = await main.call('POST', '/api/v1/ingest/site_finder', { schema_version: '3.0', batch_id: `finder:${newSite}`, sent_at: new Date().toISOString(), records: { sites: [{ external_id: `finder:${newSite}`, canonical_key: newSite, confidence: 0.7 }] } }, 'finder-key');
    assert.equal(ing.status, 202, JSON.stringify(ing.body));
    const c5 = await app.integration.cycle();
    assert.ok(c5.events >= 1, 'Hunter received the site.discovered event');
    const processed = app.store.get<{ outcome: string }>('SELECT outcome FROM main_events_processed ORDER BY rowid DESC LIMIT 1');
    assert.ok(processed, 'event outcome recorded');
    // Hunter's standing hunts find the rest of the new wave on its own
    const hunts = await app.hunts.runOperation(op.id, { force: true });
    const returns = hunts.flatMap(h => h.returns).filter(r => r.status === 'CONFIRMED_ROTATION').map(r => r.candidateValue);
    assert.ok(returns.length >= 1 && returns.every(r => truthDomains(w).includes(r)), `returns: ${returns.join(', ')}`);
    app.integration.queueSync(op.id);
    await app.integration.cycle();
    const members2 = main.all("SELECT canonical_key FROM hunter_operation_members WHERE operation_id=? AND entity_type='site'", hop.id).map(r => r.canonical_key);
    assert.ok(returns.some(r => members2.includes(r)), 'the return reached Main');
    assert.ok(!main.log.some(l => / 5\d\d/.test(l)), `no server errors:\n${main.log.filter(l => / 5\d\d/.test(l)).join('\n')}`);
  } finally {
    app.close();
    main.close();
  }
});
