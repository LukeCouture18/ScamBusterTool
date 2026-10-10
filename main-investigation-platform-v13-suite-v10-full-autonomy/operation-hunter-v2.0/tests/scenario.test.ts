import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.ts';
import { buildReport } from '../server/services/report.ts';
import { legacyBundle } from '../server/services/compat.ts';

/**
 * End to end: one reported domain grows into a reconstruction of the whole
 * (synthetic) operation, with the right things kept out of it.
 */
test('one seed grows into a reconstruction of the operation', async () => {
  const app = makeApp();
  await app.operations.resetDemo();
  const a = app.analyzer.get('op-arctic-drainer')!;
  const core = a.infrastructure.domains.filter(d => d.role === 'core').map(d => d.value);
  for (const d of ['eth-recovery-claim.top', 'claim-asset-portal.com', 'claim-revoke-portal.link', 'claim-refund-portal.click']) assert.ok(core.includes(d), `${d} reconstructed as core`);
  // kept out: co-hosted casino and the other group's sites using the same kit
  for (const d of ['bet-royale-casino.win', 'helios-airdrop-bonus.xyz']) assert.ok(!core.includes(d), `${d} is not treated as part of the operation`);
  assert.ok(a.infrastructure.domains.find(d => d.value === 'eth-recovery-claim.top')!.status === 'taken_down');
  // operator-level links
  const opInd = a.kits.operatorIndicators.map(i => i.value);
  assert.ok(opInd.includes('G-99X4K21Z') && opInd.includes('@arctic_drain_support'));
  assert.ok(!opInd.some(v => v.startsWith('wc:')), 'kit-level WalletConnect ID is not an operator indicator');
  // money
  assert.ok(a.financial.exits.some(x => x.kind === 'exchange deposit'), 'exchange deposit address identified');
  assert.ok(a.financial.exits.some(x => x.kind === 'mixer'));
  assert.ok(a.financial.wallets.some(w => w.role === 'SPLITTER'));
  assert.ok(a.financial.wallets.some(w => w.role === 'FEE_RECIPIENT'));
  assert.ok(a.financial.sweepTiming.automated);
  assert.match(a.financial.legacy.timingPatterns, /Automated sweep/);
  assert.ok(a.financial.deployers.some(d => d.contracts.length >= 2), 'same deployer across contract rotation');
  assert.ok(a.financial.networks.includes('tron') && a.financial.networks.includes('arbitrum'), 'cross-chain footprint');
  // time
  assert.ok(a.infrastructure.rotations.length >= 1, 'rotation after takedown detected');
  assert.ok(a.temporal.snapshots.length >= 3);
  assert.ok(a.temporal.events.length > 10);
  // hypotheses & cross-operation
  const h = Object.fromEntries(a.hypotheses.map(x => [x.category, x]));
  assert.ok(h.COMMON_OPERATOR.confidenceScore >= 0.8);
  assert.ok(h.SCAM_KIT_SYNDICATION.confidenceScore >= 0.6);
  assert.ok(a.hypotheses.some(x => x.category === 'FALSE_POSITIVE' && /bet-royale-casino/.test(x.title)), 'casino flagged as likely unrelated');
  const helios = a.crossOps.find(c => c.operationBId === 'op-helios-campaign')!;
  assert.equal(helios.analyticalDistinction, 'SHARED_COMMERCIAL_KIT', 'same kit, different operator');
  assert.ok(helios.overallSimilarityScore <= 65);
  // the Brief
  assert.ok(a.brief.top.length >= 3 && a.brief.top.length <= 5);
  for (const f of a.brief.top) {
    for (const k of ['title', 'whatFound', 'whyItMatters', 'whatItMeans', 'uncertainty', 'doesNotProve', 'nextStep'] as const) assert.ok(f[k], `finding ${f.kind} has ${k}`);
  }
  assert.ok(new Set(a.brief.top.map(f => f.kind)).size === a.brief.top.length, 'top findings are diverse');
  assert.ok(a.brief.depth.score >= 60, `reconstruction depth ${a.brief.depth.score}`);
  assert.ok(a.contradictions.length > 0 && a.contradictions[0].devilAdvocateAssessment);
  app.close();
});

test('long-running watch: monitors catch the next deployment as a reappearance', async () => {
  const app = makeApp();
  await app.operations.resetDemo();
  assert.ok(app.store.getMonitors('op-arctic-drainer').length >= 3, 'default monitors created after pursuit');
  const results = await app.monitor.runOperation('op-arctic-drainer');
  const hits = results.flatMap(r => r.reappearances);
  const vault = hits.find(h => h.candidateValue === 'claim-vault-security.link');
  assert.ok(vault, 'new domain found by the nameserver monitor');
  assert.equal(vault!.status, 'CONFIRMED_ROTATION');
  assert.ok(vault!.overallSimilarityScore >= 85);
  const a = app.analyzer.analyze('op-arctic-drainer')!;
  assert.equal(a.brief.top[0].kind, 'reappearance', 'the reappearance is the first thing the analyst sees');
  assert.ok(app.store.getChanges('op-arctic-drainer').some(c => c.kind === 'monitor_alert'));
  app.close();
});

test('reappearance check scores candidates against the fingerprint (legacy features accepted)', async () => {
  const app = makeApp();
  await app.operations.resetDemo();
  const strong = app.reappearance.check('op-arctic-drainer', 'claim-vault-portal.link', 'domain', { nameservers: ['ns1.offshore-dns.is', 'ns2.offshore-dns.is'], gaTag: 'G-99X4K21Z' });
  assert.ok(strong.overallSimilarityScore >= 85);
  assert.equal(strong.status, 'CONFIRMED_ROTATION');
  const kitOnly = app.reappearance.check('op-arctic-drainer', 'random-airdrop.site', 'domain', { resources: [app.store.getEntities('op-arctic-drainer').find(e => e.type === 'artifact' && /v2\.4 core/.test(e.label))!.value] });
  assert.ok(['NEW_CLUSTER', 'FALSE_ALARM', 'OPEN'].includes(kitOnly.status));
  assert.notEqual(kitOnly.status, 'CONFIRMED_ROTATION', 'kit files alone never confirm the same operator');
  const none = app.reappearance.check('op-arctic-drainer', 'bakery-shop.com', 'domain', {});
  assert.equal(none.status, 'FALSE_ALARM');
  assert.equal(none.saved, false);
  app.close();
});

test('dossier and classic bundle are complete and carry the boundaries', async () => {
  const app = makeApp();
  await app.operations.resetDemo();
  const rep = buildReport(app, 'op-arctic-drainer')!;
  for (const section of ['## Summary', '## Key findings', '## Infrastructure', '## Money', '## Timeline', '## Hypotheses', '## Evidence gaps', '## Evidence appendix']) assert.ok(rep.markdown.includes(section), section);
  assert.match(rep.markdown, /DEMO — synthetic data/);
  assert.match(rep.markdown, /never presented as proof of common ownership/);
  const bundle = legacyBundle(app, 'op-arctic-drainer')!;
  for (const key of ['briefing', 'pursuit', 'clusters', 'bridges', 'scamKitGenomes', 'financialAnalysis', 'crossOpSimilarities', 'contradictionReports', 'temporalSnapshots', 'operationGenomes', 'predictiveRankings', 'entities', 'relationships', 'evidence', 'hypotheses', 'leads', 'fingerprints', 'monitoringProbes', 'strategyStats', 'auditLogs']) assert.ok(key in bundle, key);
  assert.ok(bundle.briefing.topLeads.length >= 1 && bundle.briefing.topLeads.length <= 5);
  assert.ok(Object.keys(bundle.briefing.glossary!).length >= 6);
  assert.ok(bundle.clusters.some(c => c.category === 'HOSTING_INFRASTRUCTURE'));
  assert.ok(bundle.evidence.every(e => e.synthetic), 'demo evidence is flagged synthetic');
  app.close();
});

test('analyst actions: dismissing and acting on findings, manual hypotheses, evidence invalidation', async () => {
  const app = makeApp();
  await app.operations.resetDemo();
  let a = app.analyzer.get('op-arctic-drainer')!;
  const f = a.brief.top[a.brief.top.length - 1];
  app.analyzer.setFindingStatus(f.id, 'dismissed');
  a = app.analyzer.get('op-arctic-drainer')!;
  assert.ok(!a.brief.top.some(x => x.id === f.id), 'dismissed finding leaves the Brief');
  const ev = app.store.getEvidence('op-arctic-drainer').find(e => e.type === 'dns_ns')!;
  const { invalidateEvidence } = await import('../server/engine/ingest.ts');
  invalidateEvidence(app.store, ev.id, 'test');
  a = app.analyzer.get('op-arctic-drainer')!;
  assert.ok(a.revision > 0);
  assert.ok(app.store.getRelationships('op-arctic-drainer').some(r => r.contradictingEvidenceIds?.includes(ev.id)));
  app.close();
});
