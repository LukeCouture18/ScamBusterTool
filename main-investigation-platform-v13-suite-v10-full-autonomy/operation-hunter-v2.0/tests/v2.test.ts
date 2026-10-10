import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { HunterApp } from '../server/app.ts';
import { makeApp, tempDir } from './helpers.ts';
import { buildRouter } from '../server/api/routes.ts';
import { forecastNextWave, diffSnapshots } from '../server/model/living.ts';
import { calibrateWeights } from '../server/reasoning/calibration.ts';
import { engineFromDir, runOne } from '../bench/run.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * v2.0: the living operation model, competing explanations, contradictions,
 * model history, analyst verdicts that teach membership, migration of v1.0
 * databases and ground-truth reconstruction on adversarial synthetic worlds.
 */

test('living model: lifecycles, rotation status, wave forecast, competing explanations', async () => {
  const app = makeApp();
  await app.operations.resetDemo();
  const a = app.analyzer.get('op-arctic-drainer')!;
  const m = a.model;
  assert.equal(m.status, 'rotating', m.statusReason);
  assert.ok(m.counts.members >= 5 && m.counts.dark >= 1 && m.counts.reserve >= 1, JSON.stringify(m.counts));
  assert.equal(m.sites.find(s => s.value === 'eth-recovery-claim.top')!.state, 'suspended');
  assert.ok(m.sites.some(s => s.state === 'live'));
  assert.ok(m.waves.length >= 3);
  assert.ok(m.forecast.medianIntervalDays && m.forecast.nextExpectedAt && m.forecast.basis.includes('waves'));
  const who = m.hypotheses.find(h => h.key === 'who')!;
  assert.equal(who.leading, 'One operator runs these sites');
  assert.ok(who.hypotheses.find(h => h.key === 'coincidence')!.verdict === 'unlikely');
  assert.ok(who.discriminatingTest.length > 20 && who.caveat.includes('not proof'));
  const activity = m.hypotheses.find(h => h.key === 'activity')!;
  assert.ok(activity.hypotheses.find(h => h.key === 'ended')!.verdict === 'unlikely');
  // the rotation is one of the things surfaced to the analyst
  assert.ok(a.findings.some(f => f.kind === 'lifecycle' && /rotation/.test(f.title)));
  for (const f of a.findings.filter(x => ['lifecycle', 'forecast', 'competing_explanation', 'model_change'].includes(x.kind))) {
    for (const k of ['whyItMatters', 'uncertainty', 'doesNotProve', 'nextStep'] as const) assert.ok(f[k], `${f.kind} has ${k}`);
  }
  // Helios is a separate operator using the same kit — not absorbed
  assert.ok(!m.sites.some(s => s.value.startsWith('helios')));
  app.close();
});

test('model history: versions with readable diffs; contradictions persisted and retired', async () => {
  const app = makeApp();
  await app.operations.resetDemo();
  const versions = app.intel.modelVersions('op-arctic-drainer', 100);
  assert.ok(versions.length >= 3, `${versions.length} versions`);
  assert.equal(versions[versions.length - 1].diff.changes[0].kind, 'initial');
  assert.ok(versions.some(v => v.diff.changes.some((c: any) => c.kind === 'members_added')));
  // unchanged re-analysis does not create a new version
  const before = app.intel.latestModel('op-arctic-drainer')!.version;
  app.analyzer.analyze('op-arctic-drainer');
  assert.equal(app.intel.latestModel('op-arctic-drainer')!.version, before);
  // a pure diff
  const d = diffSnapshots({ status: 'active', members: ['a.x', 'b.x'], probable: [], live: ['a.x', 'b.x'], dark: [], reserve: [], indicators: ['G-1'], wallets: [], exits: [], forecast: 'not_due', leading: { who: 'One' }, contradictions: [] },
    { status: 'rotating', members: ['a.x', 'b.x', 'c.x'], probable: [], live: ['c.x'], dark: ['a.x'], reserve: ['r.x'], indicators: ['G-1'], wallets: [], exits: ['Exchange'], forecast: 'due', leading: { who: 'Customers' }, contradictions: ['x'] });
  const kinds = d.changes.map(c => c.kind);
  for (const k of ['members_added', 'went_dark', 'reserve_added', 'exits_added', 'status', 'forecast', 'hypothesis', 'contradictions']) assert.ok(kinds.includes(k), k);
  assert.ok(d.significance >= 0.9);
  // contradictions: planted settings are detected and persisted by fingerprint
  const opId = 'op-arctic-drainer';
  app.intel.upsertContradiction({ operationId: opId, fingerprint: 'stale:test', kind: 'test', severity: 0.2, summary: 'test', data: {} });
  app.analyzer.analyze(opId);
  const stale = app.intel.contradictions(opId).find(c => c.fingerprint === 'stale:test')!;
  assert.equal(stale.status, 'resolved', 'contradictions no longer observed are retired');
  app.close();
});

test('forecast: rhythm, windows and reserve domains', () => {
  const day = 86400000;
  const now = Date.parse('2026-06-01T00:00:00Z');
  const waves = [0, 30, 61].map(d => ({ start: new Date(now - (120 - d) * day).toISOString() }));
  const f = forecastNextWave(waves, [], now);
  assert.equal(f.medianIntervalDays, 30.5);
  assert.equal(f.status, 'overdue');
  const soon = forecastNextWave(waves, ['reserve.top'], now - 40 * day);
  assert.ok(['soon', 'not_due', 'due'].includes(soon.status));
  assert.ok(soon.confidence > f.confidence - 0.2);
  const single = forecastNextWave([waves[0]], ['reserve.top'], now);
  assert.equal(single.status, 'soon');
  assert.match(single.basis, /parked/);
  assert.equal(forecastNextWave([], [], now).status, 'unknown');
});

test('analyst verdicts correct membership immediately and calibrate factor weights', async () => {
  const app = makeApp();
  await app.operations.resetDemo();
  const opId = 'op-arctic-drainer';
  const a = app.analyzer.get(opId)!;
  const member = a.membership.members.find(m => m.type === 'domain' && m.status === 'member' && !app.store.getEntity(m.entityId)!.isSeed)!;
  const { setMembershipVerdict } = await import('../server/services/intel.ts');
  const res = setMembershipVerdict(app, opId, member.entityId, 'not_member', 'Legitimate site, confirmed with owner');
  assert.equal(res.assessment!.status, 'excluded');
  assert.ok(app.analyzer.get(opId)!.model.sites.every(s => s.value !== member.value));
  assert.equal(app.intel.membershipFeedback(opId).length, 1);
  // clearing the verdict restores inference
  const cleared = setMembershipVerdict(app, opId, member.entityId, null, null);
  assert.equal(cleared.assessment!.status, 'member');
  // calibration: repeated rejections of IP-only matches weight IP evidence down (bounded)
  const cal = calibrateWeights([
    { verdict: 'not_member', factors: [{ key: 'ip:1', family: 'hosting', weight: 1, text: '' }] },
    { verdict: 'not_member', factors: [{ key: 'ip:2', family: 'hosting', weight: 1, text: '' }] },
    { verdict: 'not_member', factors: [{ key: 'ip:3', family: 'hosting', weight: 1, text: '' }, { key: 'naming', family: 'timing', weight: 0.5, text: '' }] },
    { verdict: 'member', factors: [{ key: 'id:9', family: 'operator', weight: 3.4, text: '' }] },
  ]);
  assert.ok(cal.weights.ip! < 1 && cal.weights.ip! >= 0.6, JSON.stringify(cal));
  assert.equal(cal.weights.operatorId, undefined, 'confident, confirmed factors are left alone');
  assert.deepEqual(calibrateWeights([{ verdict: 'not_member', factors: [{ key: 'ip:1', family: 'hosting', weight: 1, text: '' }] }]).weights, {}, 'needs a few verdicts first');
  app.close();
});

test('API: model, history, membership, facets, branches, next steps, hunts, contradictions, learner, governor', async () => {
  const app = makeApp();
  const router = buildRouter(app);
  const server = http.createServer(async (req, res) => { if (!(await router.handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    await call('POST', '/api/operations/reset-demo');
    const id = 'op-arctic-drainer';
    const brief = await call('GET', `/api/v1/operations/${id}/brief`);
    assert.equal(brief.status, 200);
    assert.ok(brief.body.brief.top.length >= 3 && brief.body.brief.top.length <= 5);
    assert.equal(brief.body.intel.status, 'rotating');
    assert.ok(brief.body.intel.explanations.length >= 1 && brief.body.intel.unknowns.length >= 1);
    assert.ok(Array.isArray(brief.body.leads) && brief.body.leads.length <= 3);
    for (const l of brief.body.leads) assert.ok(l.question && l.why.length && l.doesNotProve !== undefined);
    const model = await call('GET', `/api/v1/operations/${id}/model`);
    assert.equal(model.status, 200);
    assert.ok(model.body.model.sites.length >= 5 && model.body.versions.length >= 2);
    const v1 = await call('GET', `/api/v1/operations/${id}/model/versions/1`);
    assert.equal(v1.body.version, 1);
    assert.equal((await call('GET', `/api/v1/operations/${id}/model/versions/9999`)).status, 404);
    const mem = await call('GET', `/api/v1/operations/${id}/membership?type=domain`);
    assert.ok(mem.body.members.every((m: any) => m.type === 'domain'));
    const target = mem.body.members.find((m: any) => m.status === 'member' && m.factors.some((f: any) => f.family !== 'anchor'));
    assert.ok(target.factors[0].text.length > 10, 'membership is explained');
    const verdict = await call('POST', `/api/v1/operations/${id}/membership/${target.entityId}`, { verdict: 'not_member', reason: 'test' });
    assert.equal(verdict.body.assessment.status, 'excluded');
    assert.equal((await call('POST', `/api/v1/operations/${id}/membership/nope`, { verdict: 'member' })).status, 404);
    const facets = await call('GET', `/api/v1/operations/${id}/facets`);
    assert.ok(Array.isArray(facets.body.values) && Array.isArray(facets.body.changes));
    const branches = await call('GET', `/api/v1/operations/${id}/branches`);
    assert.ok(Array.isArray(branches.body.branches));
    const next = await call('GET', `/api/v1/operations/${id}/next?limit=4`);
    assert.ok(Array.isArray(next.body) && next.body.length <= 4);
    const hunts = await call('GET', `/api/v1/operations/${id}/hunts`);
    assert.ok(Array.isArray(hunts.body));
    const ctr = await call('GET', `/api/v1/operations/${id}/contradictions`);
    assert.ok(Array.isArray(ctr.body));
    const learner = await call('GET', '/api/v1/learner');
    assert.ok(learner.body.note.includes('not how much data'));
    const gov = await call('GET', '/api/v1/governor');
    assert.ok(gov.body.allowance > 0);
    const health = await call('GET', '/api/v1/health');
    assert.equal(health.body.version, '2.0.0');
    assert.equal(health.body.schema, 2);
  } finally {
    server.close();
    app.close();
  }
});

test('migration: a v1.0 database opens in v2.0 with every operation intact and a living model', async () => {
  const dir = tempDir('hunter-v1-');
  fs.writeFileSync(path.join(dir, 'hunter.db'), zlib.gunzipSync(fs.readFileSync(path.join(here, 'fixtures', 'v1_hunter.db.gz'))));
  const app = new HunterApp({ dataDir: dir, networkMode: 'offline' });
  try {
    assert.equal(app.store.schemaVersion(), 2);
    const ops = app.store.getOperations();
    assert.ok(ops.some(o => o.name === 'My v1 case'), 'user operation kept');
    const arctic = ops.find(o => o.id === 'op-arctic-drainer')!;
    const entities = app.store.getEntities(arctic.id).length;
    assert.ok(entities > 30);
    const a = app.analyzer.analyze(arctic.id)!;
    assert.ok(a.model.counts.members >= 5, 'v1 evidence feeds the v2 model');
    assert.ok(app.intel.getMembership(arctic.id).length > 0);
    assert.equal(app.store.getEntities(arctic.id).length, entities, 'analysis does not create or drop entities');
    // pivots from v1 carry the new columns with defaults
    const pivots = app.store.getPivots(arctic.id, 5);
    assert.ok(pivots.length && pivots.every(p => p.progress === null || typeof p.progress === 'number'));
  } finally {
    app.close();
  }
  // and reopening is idempotent
  const again = new HunterApp({ dataDir: dir, networkMode: 'offline' });
  assert.equal(again.store.schemaVersion(), 2);
  again.close();
});

test('ground truth: adversarial world reconstructed without absorbing planted or look-alike sites', async () => {
  const engine = engineFromDir('v2.0', path.resolve(here, '..'), 'v2');
  const r = await runOne(engine, 3, 0.8, 'domain', 60);
  assert.equal(r.precision, 1, `false members: ${r.falseAttribution.join(', ')}`);
  assert.ok(r.recall >= 0.7, `recall ${r.recall}`);
  assert.equal(r.plantedAbsorbed, false);
  assert.equal(r.lookalikeAbsorbed, 0);
  assert.ok(r.operatorRecall >= 0.5, 'operator settings recovered');
  assert.ok(r.treasuryFound, 'treasury found from a domain seed');
  assert.equal(r.reappearanceFalse, 0, 'no false returns after the world moves on');
});
