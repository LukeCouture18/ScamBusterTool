import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, fakeFetch } from './helpers.ts';
import { liveRoutes, liveZone, SEED, SISTER, WALLET, DEPOSIT, PAGE_HTML } from './fixtures/liveWorld.ts';

/** A real (non-demo) operation pursued through the live collectors against canned API responses. */
test('real operation: autonomous pursuit through live collectors reconstructs the operation', async () => {
  const log: string[] = [];
  const app = makeApp({ networkMode: 'live', fetchImpl: fakeFetch(liveRoutes, log), dnsResolver: liveZone });
  for (const host of ['crt.sh', 'rdap.org', 'stat.ripe.net', 'api.hackertarget.com', 'urlscan.io', 'eth.blockscout.com', 'arbitrum.blockscout.com', 'base.blockscout.com', 'optimism.blockscout.com', 'polygon.blockscout.com', 'gnosis.blockscout.com']) app.http.setPacing(host, 0);
  const op = app.operations.create({ name: 'Wallet Sync', initialSeed: SEED });
  app.operations.addManualEvidence(op.id, { source: 'victim', type: 'page_source', originalObservation: 'Page source saved by the victim', subjectValue: SEED, content: PAGE_HTML });
  const run = await app.pursuit.runToCompletion(op.id, { budgetTotal: 45, maxHops: 4, concurrency: 3 });
  assert.ok(run.stats.pivots > 5);
  assert.equal(run.stats.failures, 0, `no source failures (${JSON.stringify(run.stats)})`);
  const a = app.analyzer.get(op.id)!;
  const core = a.infrastructure.domains.filter(d => d.role === 'core').map(d => d.value);
  assert.ok(core.includes(SISTER), 'sister site linked through certificate + hosting');
  assert.ok(!core.includes('unrelated-shop.store'), 'nameserver neighbour without other links stays peripheral');
  assert.ok(a.financial.exits.some(x => x.address === DEPOSIT && x.kind === 'exchange deposit'), 'deposit address found via Blockscout');
  assert.ok(a.financial.wallets.find(w => w.address === WALLET)!.role === 'COLLECTION');
  assert.ok(a.kits.families.length >= 1, 'page structure fingerprinted from victim-supplied source');
  assert.ok(a.brief.top.length >= 3);
  assert.ok(app.store.getEvidence(op.id).every(e => !e.synthetic), 'real operations never contain synthetic evidence');
  assert.ok(log.some(l => l.includes('crt.sh')) && log.some(l => l.includes('rdap.org')) && log.some(l => l.includes('blockscout')));
  // responses were cached: re-running a pivot does not hit the network again
  const before = log.length;
  const seed = app.store.findEntity(op.id, 'domain', SEED)!;
  await app.pursuit.executePivot(op.id, 'CT_SEARCH', seed.id);
  assert.equal(log.filter((l, i) => i >= before && l.includes('crt.sh')).length, 0, 'cached');
  app.close();
});
