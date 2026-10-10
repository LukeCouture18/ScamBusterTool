import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeApp } from './helpers.ts';
import { buildRouter } from '../server/api/routes.ts';
import { IntegrationWorker } from '../server/integration/worker.ts';

async function serve() {
  const app = makeApp();
  app.integration = new IntegrationWorker(app);
  const router = buildRouter(app);
  const server = http.createServer(async (req, res) => { if (!(await router.handle(req, res))) { res.writeHead(404); res.end('ui'); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body: json, headers: res.headers };
  };
  return { app, server, port, call, close: () => { server.close(); app.close(); } };
}

test('API: legacy v0.x endpoints keep working on the v1.0 engine', async () => {
  const s = await serve();
  const reset = await s.call('POST', '/api/operations/reset-demo');
  assert.equal(reset.status, 200);
  assert.equal(reset.body.operation.id, 'op-arctic-drainer');
  const status = await s.call('GET', '/api/status');
  assert.equal(status.body.status, 'LIVE');
  assert.ok(status.body.operationsCount >= 2);
  const list = await s.call('GET', '/api/operations');
  assert.ok(Array.isArray(list.body) && list.body[0].code);
  const bundle = await s.call('GET', '/api/operations/op-arctic-drainer');
  for (const key of ['operation', 'briefing', 'pursuit', 'entities', 'evidence', 'hypotheses', 'leads']) assert.ok(key in bundle.body, key);
  for (const p of ['temporal', 'genomes', 'genome', 'traceability', 'predictive-leads', 'learning-outcomes', 'financial', 'cross-op', 'contradictions', 'briefing', 'clusters', 'pursuit']) {
    const r = await s.call('GET', `/api/operations/op-arctic-drainer/${p}`);
    assert.equal(r.status, 200, p);
  }
  const step = await s.call('GET', '/api/operations/op-arctic-drainer/temporal/at-step/1');
  assert.ok(step.body.activeDomains);
  const created = await s.call('POST', '/api/operations', { name: 'API case', targetType: 'domain', initialSeed: 'api-case.xyz' });
  assert.equal(created.status, 200);
  const seed = await s.call('POST', `/api/operations/${created.body.id}/seeds`, { type: 'wallet', value: '0x5555555555555555555555555555555555555555' });
  assert.equal(seed.body.type, 'wallet');
  const ev = await s.call('POST', `/api/operations/${created.body.id}/evidence`, { source: 'analyst', type: 'note', originalObservation: 'Victim says funds went to 0x5555555555555555555555555555555555555555' });
  assert.ok(ev.body.id);
  const inval = await s.call('POST', `/api/operations/${created.body.id}/evidence/${ev.body.id}/invalidate`, { reason: 'duplicate report' });
  assert.equal(inval.body.success, true);
  const bad = await s.call('POST', `/api/operations/${created.body.id}/evidence/${ev.body.id}/invalidate`, {});
  assert.equal(bad.status, 400);
  const hyp = await s.call('POST', '/api/operations/op-arctic-drainer/hypotheses', { title: 'Analyst theory', description: 'x' });
  assert.equal(hyp.body.aiGenerated, false);
  const leads = await s.call('POST', '/api/operations/op-arctic-drainer/leads/generate');
  assert.ok(leads.body.leads.length > 0);
  const ai = await s.call('POST', '/api/operations/op-arctic-drainer/ai/analyze', {});
  assert.ok(ai.body.aiReasoning && ai.body.isAiGenerated);
  const reapp = await s.call('POST', '/api/operations/op-arctic-drainer/reappearance/check', { candidateValue: 'claim-vault-security.link', candidateType: 'domain', features: { domHash: 'x', gaTag: 'G-99X4K21Z', nameservers: ['ns1.offshore-dns.is'] } });
  assert.ok(reapp.body.overallSimilarityScore >= 60);
  const mon = await s.call('POST', '/api/monitoring/run', { operationId: 'op-arctic-drainer' });
  assert.equal(mon.body.success, true);
  const pursuit = await s.call('POST', '/api/operations/op-helios-campaign/pursuit/step');
  assert.equal(pursuit.status, 200);
  const notFound = await s.call('GET', '/api/operations/does-not-exist');
  assert.equal(notFound.status, 404);
  s.close();
});

test('API: v1 endpoints — brief, graph, entity, report, export, findings actions, settings', async () => {
  const s = await serve();
  await s.call('POST', '/api/operations/reset-demo');
  const ops = await s.call('GET', '/api/v1/operations');
  const arctic = ops.body.find((o: any) => o.id === 'op-arctic-drainer');
  assert.ok(arctic.headline && arctic.depth > 0 && arctic.pursuit);
  const brief = await s.call('GET', '/api/v1/operations/op-arctic-drainer/brief');
  assert.ok(brief.body.brief.top.length >= 3);
  assert.ok(brief.body.recentPivots.length > 0);
  const graph = await s.call('GET', '/api/v1/operations/op-arctic-drainer/graph');
  assert.ok(graph.body.nodes.length > 20 && graph.body.edges.length > 20);
  const node = graph.body.nodes.find((n: any) => n.isSeed);
  const detail = await s.call('GET', `/api/v1/operations/op-arctic-drainer/entities/${node.id}`);
  assert.ok(detail.body.evidence.length > 0 && detail.body.possiblePivots.length > 0);
  const report = await s.call('GET', '/api/v1/operations/op-arctic-drainer/report');
  assert.match(String(report.headers.get('content-type')), /markdown/);
  assert.match(report.body, /# Operation Arctic Drainer/);
  const exp = await s.call('GET', '/api/v1/operations/op-arctic-drainer/export');
  assert.equal(exp.body.format, 'operation-hunter-export');
  const f = brief.body.brief.top.find((x: any) => x.action && x.action.type === 'open_view');
  const act = await s.call('POST', `/api/v1/operations/op-arctic-drainer/findings/${f.id}/act`);
  assert.ok(act.body.navigate);
  const dismiss = await s.call('POST', `/api/v1/findings/${brief.body.brief.top[0].id}`, { status: 'dismissed' });
  assert.equal(dismiss.body.status, 'dismissed');
  const created = await s.call('POST', '/api/v1/operations', { initialSeed: '0x6666666666666666666666666666666666666666', startPursuit: true });
  assert.equal(created.body.targetType, 'wallet');
  assert.equal(created.body.pursuit.status, 'RUNNING');
  const settings = await s.call('PATCH', '/api/v1/settings', { networkMode: 'offline', apiKeys: { urlscan: 'secret-key-123' } });
  assert.equal(settings.body.ok, true);
  const got = await s.call('GET', '/api/v1/settings');
  assert.equal(got.body.apiKeys.urlscan, 'sec…23', 'keys are masked on read');
  const collectors = await s.call('GET', '/api/v1/collectors');
  assert.ok(collectors.body.some((c: any) => c.id === 'crtsh'));
  const art = await s.call('POST', '/api/v1/artifact/analyze', { html: '<html><head><title>x</title></head><body><script>setApprovalForAll()</script></body></html>' });
  assert.ok(art.body.capabilities.length);
  const integ = await s.call('GET', '/api/v1/integration/status');
  assert.equal(integ.body.configured, false);
  s.close();
});

test('API: server-sent events stream changes', async () => {
  const s = await serve();
  const op = s.app.operations.create({ name: 'SSE', initialSeed: 'sse-case.xyz' });
  const events: string[] = [];
  const req = http.get(`http://127.0.0.1:${s.port}/api/v1/events?operationId=${op.id}`, res => res.on('data', chunk => events.push(String(chunk))));
  await new Promise(r => setTimeout(r, 100));
  s.app.operations.addSeed(op.id, { value: 'sse-second.xyz' });
  await new Promise(r => setTimeout(r, 100));
  req.destroy();
  const all = events.join('');
  assert.match(all, /event: hello/);
  assert.match(all, /event: change/);
  s.close();
});
