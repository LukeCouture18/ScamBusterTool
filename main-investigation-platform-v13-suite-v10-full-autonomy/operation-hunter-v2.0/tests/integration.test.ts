import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeApp, fakeResolver } from './helpers.ts';
import { IntegrationWorker } from '../server/integration/worker.ts';

/** A small stand-in for the Main Platform API surface Hunter uses (the joined test with real Main code lives in the Main repo). */
async function fakeMain(opts: { failSyncTimes?: number } = {}) {
  const state = {
    registered: null as any, heartbeats: 0, events: [] as any[], acked: [] as string[], jobs: [] as any[], jobUpdates: [] as any[],
    syncs: [] as any[], ingests: [] as any[], requests: [] as any[], decisions: [] as any[], failSync: opts.failSyncTimes ?? 0,
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, data?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (url.pathname !== '/api/v1/search' && url.pathname !== '/api/v1/health' && req.headers['x-api-key'] !== 'hunter-key') return send(401, { error: { code: 'UNAUTHORIZED', message: 'bad key' } });
    const p = url.pathname;
    if (p === '/api/v1/health') return send(200, { ok: true });
    if (p.endsWith('/register')) { state.registered = body; return send(200, { registered: true }); }
    if (p.endsWith('/heartbeat')) { state.heartbeats++; return send(200, { accepted: true }); }
    if (p === '/api/v1/modules/operation_hunter/events' && req.method === 'GET') return send(200, { events: state.events.filter(e => !state.acked.includes(e.delivery_id)) });
    if (p.startsWith('/api/v1/modules/operation_hunter/events/')) { state.acked.push(p.split('/').pop()!); return send(200, { acknowledged: true }); }
    if (p.endsWith('/jobs/claim')) { const job = state.jobs.shift(); return job ? send(200, { job }) : send(204); }
    if (p.includes('/jobs/') && req.method === 'PATCH') { state.jobUpdates.push({ id: p.split('/').pop(), ...body }); return send(200, { job: {} }); }
    if (p === '/api/v1/operations/sync') {
      if (state.failSync > 0) { state.failSync--; return send(503, { error: { code: 'UNAVAILABLE', message: 'try later' } }); }
      state.syncs.push(body); return send(200, { operation_id: `main-${body.operation.external_id}`, created: true });
    }
    if (p === '/api/v1/ingest/operation_hunter') { state.ingests.push(body); return send(202, { status: 'accepted' }); }
    if (/^\/api\/v1\/operations\/[^/]+\/requests$/.test(p)) { state.requests.push(body); return send(200, { accepted: true }); }
    if (p === '/api/v1/inbox/decisions') { const after = Number(url.searchParams.get('after') ?? 0); const list = state.decisions.filter(d => d.seq > after); return send(200, { decisions: list, next_cursor: String(list.length ? list[list.length - 1].seq : after) }); }
    if (p === '/api/v1/search') return send(200, { results: [] });
    if (p.includes('/context')) return send(200, { entities: [], relationships: [], evidence: [], observation_versions: [] });
    return send(404, { error: { code: 'NOT_FOUND', message: p } });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { state, url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

function connect(url: string, extra: Record<string, any> = {}) {
  const app = makeApp({ fetchImpl: globalThis.fetch as any, ...extra });
  app.integration = new IntegrationWorker(app);
  app.integration.configure({ url, apiKey: 'hunter-key', hunterUrl: 'http://localhost:3000', enabled: true });
  return app;
}

test('integration: registers, heartbeats, syncs operations and survives Main outages', async t => {
  const main = await fakeMain({ failSyncTimes: 3 });
  const app = connect(main.url);
  t.after(() => { main.close(); app.close(); });
  const op = app.operations.create({ name: 'Linked case', initialSeed: 'linked-case.xyz', mainInvestigationId: 'inv-1' });
  app.integration!.queueSync(op.id);
  await app.integration!.cycle();
  assert.ok(main.state.registered, 'registered');
  assert.deepEqual(main.state.registered.capabilities.includes('operation:hunt'), true);
  assert.ok(main.state.registered.supported_event_types.includes('site.discovered'));
  assert.ok(main.state.heartbeats >= 1);
  assert.equal(main.state.syncs.length, 0, 'first sync attempt hit a 503');
  assert.ok(app.store.outboxStats().pending >= 1, 'kept in the durable outbox');
  app.store.run("UPDATE outbox SET next_attempt_at=?", new Date(0).toISOString());
  await app.integration!.cycle();
  const sync = main.state.syncs.find(s => s.operation.external_id === op.id)!;
  assert.ok(sync, 'delivered after retry');
  assert.equal(sync.operation.investigation_id, 'inv-1');
  assert.ok(sync.operation.ui_url.includes(op.id));
  assert.ok(Array.isArray(sync.operation.top_findings));
  assert.equal(app.integration!.linkInfo(op.id).mainOperationUrl, `${main.url}/operations/main-${op.id}`);
});

test('integration: HUNT_OPERATION jobs create or attach operations and start a pursuit', async t => {
  const main = await fakeMain();
  const app = connect(main.url);
  t.after(() => { main.close(); app.close(); });
  main.state.jobs.push({ id: 'job-1', job_type: 'HUNT_OPERATION', investigation_id: 'inv-9', payload: JSON.stringify({ seed: { type: 'site', value: 'fresh-drainer.xyz' }, title: 'Hunt fresh-drainer.xyz', reason: 'analyst marked useful' }) });
  await app.integration!.cycle();
  const done = main.state.jobUpdates.find(u => u.id === 'job-1')!;
  assert.equal(done.action, 'complete');
  assert.equal(done.result.action, 'created');
  const op = app.store.getOperation(done.result.operation_id)!;
  assert.equal(op.mainInvestigationId, 'inv-9');
  assert.equal(app.store.latestRun(op.id)!.status, 'RUNNING');
  // same seed again attaches instead of duplicating
  main.state.jobs.push({ id: 'job-2', job_type: 'HUNT_OPERATION', investigation_id: 'inv-9', payload: JSON.stringify({ seed: { value: 'fresh-drainer.xyz' } }) });
  await app.integration!.cycle();
  assert.equal(main.state.jobUpdates.find(u => u.id === 'job-2')!.result.action, 'attached');
  assert.equal(app.store.getOperations().filter(o => o.initialSeed === 'fresh-drainer.xyz').length, 1);
});

test('integration: Main events trigger reappearance checks; inbox candidates and decisions close the loop', async t => {
  const main = await fakeMain();
  const app = connect(main.url, { networkMode: 'live', dnsResolver: fakeResolver({ 'claim-portal-two.link': { NS: ['ns1.private-dns.is', 'ns2.private-dns.is'], A: ['194.1.1.1'] } }) });
  t.after(() => { main.close(); app.close(); });
  // a non-demo operation with a fingerprint
  const op = app.operations.create({ name: 'Fingerprinted', initialSeed: 'claim-portal-one.link', mainInvestigationId: 'inv-2' });
  app.store.replaceFingerprints(op.id, [
    { id: 'fp1', operationId: op.id, signatureType: 'naming_pattern', signatureValue: 'kw:claim,portal|tld:link', description: 'names', activeWindow: '', confidenceWeight: 0.35 },
    { id: 'fp2', operationId: op.id, signatureType: 'nameserver_pair', signatureValue: 'ns1.private-dns.is + ns2.private-dns.is', description: 'ns', activeWindow: '', confidenceWeight: 0.5 },
  ]);
  main.state.events.push({ delivery_id: 'd1', event_id: 'ev-1', event_type: 'site.discovered', source_module: 'site_finder', payload: JSON.stringify({ canonical_key: 'claim-portal-two.link' }), investigation_id: null });
  await app.integration!.cycle();
  assert.ok(main.state.acked.includes('d1'), 'event acknowledged');
  const alert = app.store.getReappearanceLeads(op.id).find(r => r.candidateValue === 'claim-portal-two.link');
  assert.ok(alert, 'Site Finder discovery matched against the operation fingerprint');
  assert.match(alert!.source!, /site_finder/);
  // processing is idempotent even if Main redelivers
  main.state.acked.length = 0;
  await app.integration!.cycle();
  assert.equal(app.store.getReappearanceLeads(op.id).filter(r => r.candidateValue === 'claim-portal-two.link').length, 1);
  // send a lead to the Main inbox, then learn from the decision
  await app.integration!.sendToInbox(op.id, 'claim-portal-one.link', 'Seed site worth checking');
  await app.integration!.cycle();
  const req = main.state.requests.find(r => r.kind === 'inbox_candidate')!;
  assert.equal(req.canonical_key, 'claim-portal-one.link');
  main.state.decisions.push({ seq: 1, domain: 'claim-portal-one.link', decision: 'useful', reason: null });
  await app.integration!.cycle();
  assert.ok(app.store.getChanges(op.id).some(c => c.kind === 'inbox_decision'));
  assert.equal(app.store.getMeta('main_decisions_cursor'), '1');
});

test('integration: bad credentials are reported with a hint and never crash the worker', async t => {
  const main = await fakeMain();
  const app = makeApp({ fetchImpl: globalThis.fetch as any });
  t.after(() => { main.close(); app.close(); });
  app.integration = new IntegrationWorker(app);
  app.integration.configure({ url: main.url, apiKey: 'wrong', enabled: true });
  const res = await app.integration.testConnection();
  assert.equal(res.ok, false);
  assert.match(res.hint ?? '', /MODULE_API_KEYS/);
  const cycle = await app.integration.cycle();
  assert.ok((cycle as any).errors.length >= 1);
  assert.ok(app.integration.status().lastError);
});
