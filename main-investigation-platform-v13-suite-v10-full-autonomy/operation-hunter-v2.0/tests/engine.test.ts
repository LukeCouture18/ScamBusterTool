import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, tempDir } from './helpers.ts';
import { HunterApp } from '../server/app.ts';
import { ingestObservations, invalidateEvidence, reinstateEvidence } from '../server/engine/ingest.ts';
import type { Observation } from '../server/core/model.ts';

const obs = (over: Partial<Observation>): Observation => ({
  kind: 'dns_a', source: 'dns', observedAt: '2026-09-01T00:00:00.000Z', summary: 'a resolves to 1.2.3.4', raw: { a: 1 }, confidence: 0.9, assertion: 'observed', provenance: 'test',
  entities: [{ ref: 'subject', type: 'domain', value: 'a-scam.xyz' }, { ref: 'e1', type: 'ip', value: '1.2.3.4' }],
  relationships: [{ from: 'subject', to: 'e1', type: 'RESOLVES_TO', reasoning: 'A record' }], ...over,
});

test('ingest: one evidence per observation, dedupe, noisy-OR confidence, multi-source SUPPORTED', () => {
  const app = makeApp();
  const op = app.operations.create({ name: 'Ingest', initialSeed: 'a-scam.xyz' });
  const r1 = ingestObservations(app.store, [obs({})], { operationId: op.id, collector: 'dns' });
  assert.equal(r1.newEvidence.length, 1);
  assert.equal(r1.newEntities.length, 1, 'seed entity reused, IP created');
  const again = ingestObservations(app.store, [obs({})], { operationId: op.id, collector: 'dns' });
  assert.equal(again.newEvidence.length, 0);
  assert.equal(again.duplicateEvidence, 1, 'identical observation is not stored twice');
  ingestObservations(app.store, [obs({ source: 'urlscan', raw: { b: 2 }, confidence: 0.8, relationships: [{ from: 'subject', to: 'e1', type: 'RESOLVES_TO', reasoning: 'scan', confidence: 0.8 }] })], { operationId: op.id, collector: 'urlscan' });
  const rel = app.store.getRelationships(op.id).find(r => r.type === 'RESOLVES_TO')!;
  assert.equal(rel.evidenceIds.length, 2);
  assert.equal(rel.state, 'SUPPORTED');
  assert.ok(rel.confidence > 0.95, `noisy-OR of 0.9 and 0.8 (${rel.confidence})`);
  app.close();
});

test('invalidation cascade and reinstatement recompute dependent relationships', () => {
  const app = makeApp();
  const op = app.operations.create({ name: 'Cascade', initialSeed: 'a-scam.xyz' });
  const r = ingestObservations(app.store, [obs({})], { operationId: op.id, collector: 'dns' });
  const ev = r.newEvidence[0];
  invalidateEvidence(app.store, ev.id, 'Resolver was poisoned');
  let rel = app.store.getRelationships(op.id)[0];
  assert.equal(rel.state, 'CONTRADICTED');
  assert.equal(rel.confidence, 0.05);
  assert.ok(rel.contradictingEvidenceIds?.includes(ev.id));
  assert.match(rel.reasoning, /INVALIDATED/);
  reinstateEvidence(app.store, ev.id);
  rel = app.store.getRelationships(op.id)[0];
  assert.equal(rel.state, 'OBSERVED');
  assert.ok(rel.confidence >= 0.9);
  assert.doesNotMatch(rel.reasoning, /INVALIDATED/);
  app.close();
});

test('planner: ranks leads, suppresses commodity infrastructure, explains itself', () => {
  const app = makeApp();
  app.operations.createDemo({ reconstruct: false });
  const op = app.store.getOperation('op-arctic-drainer')!;
  const leads = app.planner.refreshLeads(op.id);
  assert.ok(leads.length >= 4);
  const pending = leads.filter(l => l.status === 'PENDING' && !l.blockedReason);
  for (let i = 1; i < pending.length; i++) assert.ok(pending[i - 1].priorityScore >= pending[i].priorityScore, 'descending priority');
  assert.ok(pending[0].plain?.what && pending[0].plain?.why && pending[0].plain?.doesNotProve);
  assert.ok(pending[0].scoreBreakdown && pending[0].scoreBreakdown.finalScore === pending[0].priorityScore);
  // commodity: a Cloudflare nameserver never gets an expansion lead
  const helios = app.store.getOperation('op-helios-campaign')!;
  app.store.insertEntity({ id: 'ent-cf', operationId: helios.id, type: 'nameserver', value: 'kara.ns.cloudflare.com', canonical: 'kara.ns.cloudflare.com', label: 'cf', metadata: {}, firstSeen: '', lastSeen: '', isActive: true, depth: 1, ubiquity: 0.95 });
  assert.ok(!app.planner.candidates(helios.id).some(c => c.entity.id === 'ent-cf'));
  app.close();
});

test('pursuit: durable best-first run respects budget, never repeats a pivot, logs plain-language hops', async () => {
  const app = makeApp();
  app.operations.createDemo({ reconstruct: false });
  const run = await app.pursuit.runToCompletion('op-arctic-drainer', { budgetTotal: 12, maxHops: 3, concurrency: 2 });
  assert.ok(['BUDGET_EXHAUSTED', 'COMPLETED', 'SATURATED'].includes(run.status));
  assert.ok(run.budgetUsed <= 12);
  const pivots = app.store.getPivots('op-arctic-drainer');
  const sigs = pivots.map(p => p.signature);
  assert.equal(new Set(sigs).size, sigs.length, 'no pivot executed twice');
  assert.ok(pivots.every(p => p.depth < 3), 'hop limit respected');
  const state = app.pursuit.legacyState('op-arctic-drainer');
  assert.ok(state.logs.length > 0);
  assert.ok(state.logs[0].simpleExplanation && state.logs[0].whyItMatters);
  assert.ok(app.store.countEntities('op-arctic-drainer') > 10, 'the seed grew');
  app.close();
});

test('recovery: interrupted pivots are retried and running pursuits resume after restart', async () => {
  const dir = tempDir('hunter-recover-');
  const a1 = new HunterApp({ dataDir: dir, seedDemo: false, networkMode: 'offline' });
  a1.operations.createDemo({ reconstruct: false });
  a1.pursuit.start('op-arctic-drainer', { budgetTotal: 20 });
  await a1.pursuit.step('op-arctic-drainer');
  const before = a1.store.getRun(a1.store.latestRun('op-arctic-drainer')!.id)!;
  // simulate a crash mid-pivot
  const p = a1.store.getPivots('op-arctic-drainer')[0];
  a1.store.savePivot({ ...p, id: 'pvt-crashed', signature: 'CT_SEARCH:claim-asset-portal.com', status: 'running', pivotType: 'CT_SEARCH', targetValue: 'claim-asset-portal.com' });
  a1.store.close();
  const a2 = new HunterApp({ dataDir: dir, seedDemo: false, networkMode: 'offline' });
  const rec = a2.pursuit.recover();
  assert.equal(rec.interruptedPivots, 1);
  assert.equal(rec.resumedRuns, 1);
  assert.equal(a2.store.getPivot('pvt-crashed')!.status, 'failed');
  const run = a2.store.latestRun('op-arctic-drainer')!;
  assert.equal(run.status, 'RUNNING');
  assert.equal(run.budgetUsed, before.budgetUsed, 'budget state survived restart');
  await a2.pursuit.tick();
  await new Promise(r => setTimeout(r, 300));
  assert.ok(a2.store.getRun(run.id)!.budgetUsed > before.budgetUsed, 'scheduler continued the resumed run');
  a2.close();
});

test('strategy learning: outcomes and analyst feedback move expected gain', () => {
  const app = makeApp();
  const before = app.strategy.expectedGain('REVERSE_NS', 'nameserver');
  for (let i = 0; i < 5; i++) app.strategy.record({ operationId: 'x', pivotType: 'REVERSE_NS', entityType: 'nameserver', newRelevant: 6, newEntities: 6, newEvidence: 1, confidence: 0.9, cost: 'medium', context: 't' });
  const after = app.strategy.expectedGain('REVERSE_NS', 'nameserver');
  assert.ok(after > before, `learning increases expected gain (${before} -> ${after})`);
  const p1 = app.strategy.successProbability('RDAP_DOMAIN', 'domain');
  for (let i = 0; i < 4; i++) app.strategy.feedback('RDAP_DOMAIN', 'domain', false);
  assert.ok(app.strategy.successProbability('RDAP_DOMAIN', 'domain') < p1, 'negative analyst feedback lowers the posterior');
  const legacy = app.strategy.legacyStats();
  assert.ok(legacy.REVERSE_NS.utilityScore > 50);
  assert.equal(app.store.getLearningOutcomes('x').length, 5);
  app.close();
});
