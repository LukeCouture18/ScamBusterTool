// The no-browser fallback scheduler (integrations/local_scheduler.py) against
// the real platform route handlers served over loopback HTTP, with a loopback
// module feedback receiver. Synthetic data only; no network beyond 127.0.0.1.
import {importFrom, localPath, pythonCommand, pythonEnv} from './lib/portable.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {readFile, readdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';

const sql = new DatabaseSync(':memory:'); sql.exec('PRAGMA foreign_keys=ON');
const migrations = new URL('../drizzle/', import.meta.url);
for (const name of (await readdir(migrations)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sql.exec(await readFile(new URL(name, migrations), 'utf8'));
const db = {prepare(statement) {let params = []; return {bind(...v) {params = v; return this;}, async run() {return {meta: {changes: Number(sql.prepare(statement).run(...params).changes)}};}, async first() {return sql.prepare(statement).get(...params) ?? null;}, async all() {return {results: sql.prepare(statement).all(...params)};}};}, async batch(queries) {sql.exec('BEGIN'); try {const result = []; for (const q of queries) result.push(await q.run()); sql.exec('COMMIT'); return result;} catch (error) {sql.exec('ROLLBACK'); throw error;}}};

// Loopback module feedback receiver (signed pushes).
const secret = 'synthetic-fallback-key'; const received = [];
const receiver = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const digest = Buffer.from(await crypto.subtle.sign('HMAC', key, body)).toString('hex');
  received.push({delivery: req.headers['x-platform-delivery-id'], valid: req.headers['x-platform-signature'] === 'sha256=' + digest, payload: JSON.parse(body.toString())});
  res.statusCode = 200; res.end('accepted');
});

const routes = {
  '/api/v1/feedback/dispatch': 'app/api/v1/feedback/dispatch/route.ts',
  '/api/v1/monitoring/tick': 'app/api/v1/monitoring/tick/route.ts',
  '/api/v1/inbox/supply': 'app/api/v1/inbox/supply/route.ts',
};
const work = await mkdtemp(join(tmpdir(), 'mip-scheduler-fallback-'));
let platform;
try {
  await new Promise(done => receiver.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${receiver.address().port}`;
  globalThis.__TEST_ENV = {DB: db, FEEDBACK_SIGNING_KEY: secret, FEEDBACK_WEBHOOK_ALLOWLIST: origin, FEEDBACK_ALLOW_LOOPBACK_HTTP: 'true'};
  await build({entryPoints: [...Object.values(routes), 'lib/schema-ready.ts'], bundle: true, splitting: true, format: 'esm', platform: 'node', outdir: work,
    plugins: [{name: 'test-env', setup(p) {p.onResolve({filter: /^cloudflare:workers$/}, () => ({path: 'env', namespace: 'test'})); p.onLoad({filter: /.*/, namespace: 'test'}, () => ({contents: 'export const env=globalThis.__TEST_ENV', loader: 'js'}));}}]});
  const handlers = {};
  for (const [path, file] of Object.entries(routes)) handlers[path] = await importFrom(work, file.replace(/\.ts$/, '.js'));
  const {assertSchemaReady} = await importFrom(work, 'lib/schema-ready.js');
  const hits = [];
  // Same order as worker.fetch: schema gate, then the route.
  platform = createServer(async (req, res) => {
    for await (const _ of req);
    hits.push(req.url);
    await assertSchemaReady(db);
    const handler = handlers[req.url];
    const response = handler ? await handler.POST(new Request('http://127.0.0.1' + req.url, {method: 'POST'})) : Response.json({error: 'NOT_FOUND'}, {status: 404});
    res.writeHead(response.status, {'content-type': 'application/json'}); res.end(await response.text());
  });
  await new Promise(done => platform.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${platform.address().port}`;

  // A processed event with a pending push to the loopback receiver ...
  const inv = crypto.randomUUID(), entity = crypto.randomUUID(), event = crypto.randomUUID(), delivery = crypto.randomUUID();
  sql.prepare("INSERT INTO investigations(id,external_id,title) VALUES (?,?,?)").run(inv, 'synthetic-fallback', 'Synthetic fallback case');
  sql.prepare("INSERT INTO entities(id,investigation_id,entity_type,canonical_key,display_name) VALUES (?,?,'site','synthetic.invalid','Synthetic site')").run(entity, inv);
  sql.prepare("INSERT INTO module_registry(module_name,registration_metadata) VALUES ('site_finder',?)").run(JSON.stringify({feedback_webhook_url: `${origin}/events`}));
  sql.prepare("INSERT INTO event_store(id,event_id,event_type,correlation_id,investigation_id,entity_id,source_module,payload,provenance,content_hash,occurred_at,status) VALUES (?,?,'site.investigated',?,?,?,'site_investigator',?,'{}','synthetic-hash',CURRENT_TIMESTAMP,'processed')").run(event, 'synthetic-event', 'synthetic-correlation', inv, entity, JSON.stringify({summary: 'synthetic only'}));
  sql.prepare("INSERT INTO module_event_inbox(id,event_id,module_name) VALUES (?,?,'site_finder')").run(delivery, event);

  // ... run the fallback asynchronously (this process also serves the platform).
  const python = pythonCommand();
  const fallback = async (code) => {
    const script = `import json,sys;sys.path.insert(0,${JSON.stringify(localPath('../integrations/', import.meta.url))})\nfrom local_scheduler import tick,supply\n${code}`;
    const child = spawn(python.command, [...python.args, '-c', script, base], {env: pythonEnv(), windowsHide: true});
    let out = '', err = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    const status = await new Promise(done => child.once('exit', done));
    return {status, out, err};
  };

  // 1. tick(): the v6.1 maintenance contract, feedback dispatch then monitoring.
  let run = await fallback('print(json.dumps(tick(sys.argv[1])))');
  assert.equal(run.status, 0, `fallback tick failed:\n${run.err}`);
  const results = JSON.parse(run.out);
  assert.deepEqual(results.map(r => r.endpoint), ['/api/v1/feedback/dispatch', '/api/v1/monitoring/tick'], 'tick keeps the v6.1 endpoints');
  assert.ok(results.every(r => r.status === 200), JSON.stringify(results));
  assert.equal(results[0].result.feedback.delivered, 1, JSON.stringify(results[0]));
  assert.equal(received.length, 1, 'loopback feedback receiver got the push');
  assert.equal(received[0].valid, true, 'push is signed');
  assert.equal(received[0].delivery, delivery);
  assert.equal(received[0].payload.event_type, 'site.investigated');
  assert.equal(sql.prepare('SELECT pushed_at IS NOT NULL d FROM module_event_inbox WHERE id=?').get(delivery).d, 1, 'delivery recorded as pushed');
  assert.ok(!hits.includes('/api/v1/inbox/supply'), 'tick does not call inbox supply');

  // 2. supply(): the v2 step, separate from tick.
  run = await fallback('print(json.dumps(supply(sys.argv[1])))');
  assert.equal(run.status, 0, run.err);
  const inbox = JSON.parse(run.out);
  assert.equal(inbox.endpoint, '/api/v1/inbox/supply'); assert.equal(inbox.status, 200); assert.equal(inbox.result.queued, true, JSON.stringify(inbox));

  // 3. A platform without inbox supply: maintenance and feedback still work; supply fails visibly.
  delete handlers['/api/v1/inbox/supply'];
  sql.prepare("UPDATE module_event_inbox SET push_next_at=CURRENT_TIMESTAMP WHERE id=?").run(delivery);
  run = await fallback('print(json.dumps(tick(sys.argv[1])))');
  assert.equal(run.status, 0, run.err);
  assert.equal(received.length, 2, 'feedback still reaches the loopback receiver');
  run = await fallback('supply(sys.argv[1])');
  assert.notEqual(run.status, 0, 'a failed supply call is an error, not a silent success');
  assert.match(run.err, /HTTP Error 404/);
  console.log(JSON.stringify({ok: true, synthetic: true, fallback: 'local_scheduler', tick: results.map(r => r.endpoint), loopback_feedback: true, signed: true, inbox_supply: true, supply_isolated: true}));
} finally {
  if (platform) await new Promise(done => platform.close(done));
  await new Promise(done => receiver.close(done));
  await rm(work, {recursive: true, force: true});
  sql.close();
}
