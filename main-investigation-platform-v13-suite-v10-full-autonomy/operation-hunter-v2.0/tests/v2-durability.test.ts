import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HunterApp } from '../server/app.ts';
import { ingestObservations } from '../server/engine/ingest.ts';
import { generateWorld, truthDomains, advance } from '../bench/world.ts';
import { fakeNetwork, PACED_HOSTS } from '../bench/fakeNetwork.ts';
import type { Observation } from '../server/core/model.ts';

/**
 * Long-running autonomy must survive restarts and stay fast as operations grow:
 *   - a pursuit interrupted mid-run resumes after restart, keeping its branches,
 *     learned progress statistics, model history and standing hunts
 *   - standing hunts fire on schedule from persisted state and catch a new wave
 *   - analysis of a large operation (hundreds of sites, thousands of links) stays fast
 */
function liveApp(dir: string, w: ReturnType<typeof generateWorld>) {
  const net = fakeNetwork(w);
  const app = new HunterApp({ dataDir: dir, seedDemo: false, networkMode: 'live', fetchImpl: net.fetch, dnsResolver: net.resolver });
  for (const h of PACED_HOSTS) app.http.setPacing(h, 0);
  app.analyzer.debounceMs = 5;
  app.allocator.seed(11);
  return app;
}

test('restart mid-pursuit: the run resumes and the intelligence layer (branches, learner, model history, hunts) persists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-v2-restart-'));
  const w = generateWorld(4, { difficulty: 0.3 });
  const target = w.ops.find(o => o.id === w.target)!;
  const wave2 = target.domains.map(d => w.domains.get(d)!).filter(d => d.registeredAt >= 40 && d.registeredAt < 80 && d.kit);
  const seed = (wave2.find(d => d.ns[0].includes('-dns.')) ?? wave2[0]).name;
  let app = liveApp(dir, w);
  const op = app.operations.create({ name: 'Restart', initialSeed: seed, targetType: 'auto' });
  await app.pursuit.runToCompletion(op.id, { budgetTotal: 60, maxHops: 5, concurrency: 3, maxMinutes: 600 }, 25);
  const run1 = app.store.latestRun(op.id)!;
  assert.equal(run1.status, 'RUNNING', 'still running when the process "dies"');
  app.analyzer.analyze(op.id);
  const branches = app.intel.getBranches(op.id).length;
  const learned = app.intel.learnerRows().reduce((s, r) => s + r.pulls, 0);
  const versions = app.intel.modelVersions(op.id).length;
  assert.ok(branches > 3 && learned > 10 && versions >= 1);
  app.close(); // simulated crash: no graceful stop of the run

  app = liveApp(dir, w);
  try {
    assert.equal(app.intel.getBranches(op.id).length, branches, 'branches persisted');
    assert.ok(app.intel.learnerRows().reduce((s, r) => s + r.pulls, 0) >= learned, 'learned statistics persisted');
    assert.ok(app.intel.modelVersions(op.id).length >= versions, 'model history persisted');
    const resumed = app.store.latestRun(op.id)!;
    assert.equal(resumed.id, run1.id, 'same run resumed, not restarted');
    await app.pursuit.runToCompletion(op.id, { budgetTotal: 60, maxHops: 5, concurrency: 3, maxMinutes: 600 }, 60);
    const done = app.store.latestRun(op.id)!;
    assert.notEqual(done.status, 'RUNNING');
    const sigs = app.store.getPivots(op.id, 1000).filter(p => p.status === 'done');
    assert.ok(sigs.length > 30, `${sigs.length} lookups, stop: ${done.status} ${done.stopReason}`);
    const a = app.analyzer.analyze(op.id)!;
    const truth = new Set(truthDomains(w));
    const members = a.model.sites.filter(s => s.membership === 'member').map(s => s.value);
    assert.ok(members.length >= 4 && members.every(m => truth.has(m)), `members ${members.join(', ')}; ${sigs.length} lookups; ${done.status}: ${done.stopReason}; ${JSON.stringify(app.store.getPivots(op.id, 1000).reduce((m: any, p) => (m[p.pivotType] = (m[p.pivotType] ?? 0) + 1, m), {}))}`);
    // standing hunts derived from the reconstruction survive another restart and fire from the schedule
    const hunts = app.hunts.ensureHunts(op.id);
    assert.ok(hunts.length >= 2, `hunts: ${hunts.map(h => h.kind).join(', ')}`);
    app.close();
    advance(w, 30);
    app = liveApp(dir, w);
    for (const h of app.intel.getHunts(op.id)) app.intel.upsertHunt({ ...h, nextRunAt: new Date(Date.now() - 1000).toISOString() });
    const ran = await app.hunts.runDue();
    assert.ok(ran.length >= 2, 'due hunts ran after restart');
    const returns = ran.flatMap(r => r.returns).filter(r => r.status === 'CONFIRMED_ROTATION').map(r => r.candidateValue);
    assert.ok(returns.length >= 1 && returns.every(r => truthDomains(w).includes(r)), `returns ${returns.join(', ')}`);
    const again = await app.hunts.runDue();
    assert.equal(again.length, 0, 'hunts are rescheduled, not re-run immediately');
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('performance: a large operation (400 sites, ~3000 links) is analysed quickly and incrementally', () => {
  const app = new HunterApp({ filename: ':memory:', seedDemo: false, networkMode: 'offline' });
  try {
    const op = app.operations.create({ name: 'Large', initialSeed: 'site-0.test', targetType: 'domain' });
    const obs: Observation[] = [];
    const at = new Date().toISOString();
    for (let i = 0; i < 400; i++) {
      const group = i % 8;
      obs.push({
        kind: 'site_scan', source: 'synthetic-perf', observedAt: at, summary: `site-${i}.test profile`, raw: { page: { ip: `10.0.${group}.1` } }, confidence: 0.9, assertion: 'observed', provenance: 'perf',
        entities: [
          { ref: 's', type: 'domain', value: `site-${i}.test` }, { ref: 'ip', type: 'ip', value: `10.0.${group}.1` }, { ref: 'ns', type: 'nameserver', value: `ns1.group${group}-dns.test` },
          { ref: 'ga', type: 'identifier', value: `G-GROUP${group}` }, { ref: 'tg', type: 'identifier', value: `@group${group}_support` },
          { ref: 'w', type: 'wallet', value: `0x${String(group).padStart(2, '0')}${'a'.repeat(38)}` },
        ],
        relationships: [
          { from: 's', to: 'ip', type: 'RESOLVES_TO', reasoning: 'A record' }, { from: 's', to: 'ns', type: 'DELEGATED_TO', reasoning: 'NS' },
          { from: 's', to: 'ga', type: 'USES_IDENTIFIER', reasoning: 'analytics' }, { from: 's', to: 'tg', type: 'USES_IDENTIFIER', reasoning: 'support' },
          { from: 's', to: 'w', type: 'REFERENCES_WALLET', reasoning: 'deposit address' },
        ],
      } as Observation);
    }
    const t0 = Date.now();
    ingestObservations(app.store, obs, { operationId: op.id, collector: 'perf', subjectDepth: 1, synthetic: true });
    const ingestMs = Date.now() - t0;
    const t1 = Date.now();
    const a = app.analyzer.analyze(op.id)!;
    const analyzeMs = Date.now() - t1;
    assert.ok(app.store.getEntities(op.id).length > 400);
    // the seed's group (every 8th site) is the operation; the other groups share nothing operator-level with it
    const members = a.membership.members.filter(m => m.type === 'domain' && m.status === 'member').map(m => Number(m.value.split('-')[1].split('.')[0]));
    assert.ok(members.length >= 40 && members.every(i => i % 8 === 0), `members from other groups: ${members.filter(i => i % 8 !== 0).slice(0, 5)}`);
    assert.ok(analyzeMs < 8000, `analysis took ${analyzeMs} ms`);
    const t2 = Date.now();
    app.analyzer.get(op.id);
    assert.ok(Date.now() - t2 < 200, 'unchanged operation served from cache');
    console.log(`    perf: ingest ${ingestMs} ms, full analysis ${analyzeMs} ms for ${app.store.getEntities(op.id).length} entities`);
  } finally {
    app.close();
  }
});
