import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, fakeFetch, on } from './helpers.ts';
import { liveRoutes, liveZone, SEED, SISTER, WALLET, KIT_HASH, PAGE_HTML } from './fixtures/liveWorld.ts';
import { certificatesToObservations, normalizeSanName } from '../server/collectors/ctCollector.ts';
import { btcTransfers, formatUnits, tronHexToBase58, transfersToObservations, labelKindFromName } from '../server/collectors/chainCollectors.ts';
import { analyzeHtml, simhashSimilarity } from '../server/collectors/artifact.ts';
import { HttpClient, HttpError } from '../server/collectors/http.ts';
import type { Entity } from '../server/types.ts';

const ent = (type: Entity['type'], value: string): Entity => ({ id: 'e1', operationId: 'op', type, value, label: value, metadata: {}, firstSeen: '', lastSeen: '', isActive: true });

test('crt.sh rows: one observation per certificate, SAN co-certified domains linked', () => {
  const rows = [
    { id: 1, issuer_ca_id: 7, issuer_name: 'C=AT, O=ZeroSSL, CN=ZeroSSL RSA', name_value: '*.claim-asset-portal.com\nclaim-asset-portal.com\neth-recovery-claim.top', not_before: '2026-08-20T00:00:00', not_after: '2026-11-18T00:00:00', serial_number: 'aa', entry_timestamp: '2026-08-20T01:02:03.456' },
    { id: 2, issuer_ca_id: 7, issuer_name: 'C=AT, O=ZeroSSL, CN=ZeroSSL RSA', name_value: 'eth-recovery-claim.top', not_before: '2026-08-20T00:00:00', not_after: '2026-11-18T00:00:00', serial_number: 'aa', entry_timestamp: '2026-08-20T01:02:04' },
  ];
  const { observations, total } = certificatesToObservations(ent('domain', 'eth-recovery-claim.top'), rows, 'test');
  assert.equal(total, 1, 'precert + cert with the same serial are one certificate');
  const o = observations[0];
  assert.equal(o.kind, 'ct_certificate');
  assert.match(o.summary, /claim-asset-portal\.com/);
  assert.ok(o.entities.some(e => e.type === 'domain' && e.value === 'claim-asset-portal.com'));
  assert.ok(o.relationships.some(r => r.type === 'CERTIFIED_BY'));
  assert.equal(normalizeSanName('cpanel.example.com')?.host, 'example.com');
  assert.equal(normalizeSanName('*.foo.bar')?.wildcard, true);
});

test('chain helpers: units, TRON address encoding, BTC flows, label kinds', () => {
  assert.equal(formatUnits('1500000000000000000', 18), '1.5');
  assert.equal(formatUnits('25000000', 6), '25');
  assert.equal(tronHexToBase58('41a614f803b6fd780986a42c78ec9c7f77e6ded13c'), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'USDT-TRC20 contract address');
  const flows = btcTransfers('bc1me', [{ txid: 't1', status: { block_time: 1700000000 }, vin: [{ prevout: { scriptpubkey_address: 'bc1victim', value: 50000 } }], vout: [{ scriptpubkey_address: 'bc1me', value: 40000 }, { scriptpubkey_address: 'bc1victim', value: 9000 }] }]);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].amount, '0.0004');
  assert.equal(labelKindFromName('Tornado Cash: Router'), 'mixer');
  assert.equal(labelKindFromName('Binance 14'), 'exchange');
  const obs = transfersToObservations(ent('wallet', '0xaaa'), [
    { hash: 'h1', from: '0xv1', to: '0xaaa', amount: '1', symbol: 'ETH', timestamp: '2026-09-01T00:00:00Z' },
    { hash: 'h2', from: '0xv1', to: '0xaaa', amount: '2', symbol: 'ETH', timestamp: '2026-09-02T00:00:00Z' },
    { hash: 'h3', from: '0xaaa', to: '0xbbb', amount: '2.9', symbol: 'ETH', timestamp: '2026-09-02T00:01:00Z', toLabel: 'Binance 14' },
  ], 'ethereum', 'test', 'test');
  assert.equal(obs.length, 2, 'grouped by counterparty and direction');
  const out = obs.find(o => o.raw.direction === 'out')!;
  assert.equal(out.raw.counterpartyKind, 'exchange');
  assert.equal(out.assertion, 'blockchain_fact');
});

test('HTML fingerprinting: structure survives text changes, variants stay similar', () => {
  const a = analyzeHtml(PAGE_HTML);
  const b = analyzeHtml(PAGE_HTML.replace('Secure Wallet Sync', 'Totally Different Title').replace('G-SYNC1234AB', 'G-OTHER99999'));
  assert.equal(a.structuralHash, b.structuralHash, 'text/config changes keep the skeleton');
  const variant = analyzeHtml(PAGE_HTML.replace('<footer>', '<div class="tron"><button class="tron-connect" type="button"></button></div><footer>'));
  assert.notEqual(variant.structuralHash, a.structuralHash);
  assert.ok(simhashSimilarity(a.simhash, variant.simhash) >= 0.8, 'variant is near-duplicate');
  assert.ok(a.capabilities.some(c => /setApprovalForAll/.test(c)));
  assert.ok(a.indicators.some(i => i.value === WALLET));
  assert.ok(a.indicators.some(i => i.value === '@walletsync_help'));
  assert.equal(a.title, 'Secure Wallet Sync');
});

test('HTTP client caches, retries transient errors and reports hard failures', async () => {
  const app = makeApp();
  let calls = 0;
  const http = new HttpClient(app.store, fakeFetch([on('flaky', () => (++calls < 2 ? { status: 503, body: {} } : { body: { ok: true } })), on('broken', () => ({ status: 400, body: { error: 'bad' } }))]));
  http.setPacing('x.test', 0);
  const r1 = await http.json({ url: 'https://x.test/flaky', collector: 't', ttlSeconds: 60 });
  assert.deepEqual(r1.body, { ok: true });
  assert.equal(calls, 2);
  const r2 = await http.json({ url: 'https://x.test/flaky', collector: 't', ttlSeconds: 60 });
  assert.equal(r2.cached, true);
  assert.equal(calls, 2, 'served from cache');
  await assert.rejects(() => http.json({ url: 'https://x.test/broken', collector: 't' }), (e: any) => e instanceof HttpError && e.status === 400);
  app.close();
});

test('live collectors parse real API formats (DNS, crt.sh, RDAP, RIPEstat, HackerTarget, urlscan, Blockscout)', async () => {
  const app = makeApp({ networkMode: 'live', fetchImpl: fakeFetch(liveRoutes), dnsResolver: liveZone });
  for (const host of ['crt.sh', 'rdap.org', 'stat.ripe.net', 'api.hackertarget.com', 'urlscan.io', 'eth.blockscout.com', 'arbitrum.blockscout.com', 'base.blockscout.com', 'optimism.blockscout.com', 'polygon.blockscout.com', 'gnosis.blockscout.com']) app.http.setPacing(host, 0);
  const op = app.operations.create({ name: 'Live', initialSeed: SEED });
  const seed = app.store.findEntity(op.id, 'domain', SEED)!;
  const run = async (pivot: string, id = seed.id) => app.pursuit.executePivot(op.id, pivot, id);
  const dns = await run('DNS_RESOLVE');
  assert.equal(dns.status, 'done');
  assert.ok(app.store.findEntity(op.id, 'ip', '45.155.205.10'));
  assert.ok(app.store.findEntity(op.id, 'nameserver', 'ns1.hostprivate.net'));
  assert.ok(app.store.findEntity(op.id, 'identifier', 'google-site-verification=abcTOKEN123'));
  await run('CT_SEARCH');
  assert.ok(app.store.findEntity(op.id, 'domain', SISTER), 'co-certified sister domain discovered');
  await run('RDAP_DOMAIN');
  assert.ok(app.store.getEntity(seed.id)!.metadata.registeredAt, 'registration date recorded');
  const ip = app.store.findEntity(op.id, 'ip', '45.155.205.10')!;
  await run('IP_PROFILE', ip.id);
  assert.equal(app.store.getEntity(ip.id)!.metadata.asn, 'AS211252');
  assert.ok(app.store.findEntity(op.id, 'asn', 'AS211252'));
  const rev = await run('REVERSE_IP', ip.id);
  assert.equal(rev.collector, 'hackertarget');
  await run('SITE_PROFILE');
  const art = app.store.findEntity(op.id, 'artifact', `sha256:${KIT_HASH}`);
  assert.ok(art, 'non-CDN script hash recorded; CDN jquery skipped');
  assert.ok(!app.store.findEntity(op.id, 'artifact', `sha256:${'b'.repeat(64)}`));
  await run('SHARED_RESOURCE', art!.id);
  app.operations.addManualEvidence(op.id, { source: 'analyst', type: 'page_source', originalObservation: 'Saved page source', subjectValue: SEED, content: PAGE_HTML });
  const wallet = app.store.findEntity(op.id, 'wallet', WALLET)!;
  assert.ok(wallet, 'wallet extracted from page source');
  const trace = await run('WALLET_TRACE', wallet.id);
  assert.equal(trace.status, 'done');
  assert.ok((trace.result?.newEntities ?? 0) >= 3, 'victims and treasury discovered');
  app.close();
});

test('failed sources are recorded, retried later, and never fabricate data', async () => {
  const app = makeApp({ networkMode: 'live', fetchImpl: fakeFetch([on('crt.sh', () => ({ status: 502, body: 'bad gateway' }))]) });
  app.http.setPacing('crt.sh', 0);
  const op = app.operations.create({ name: 'Fail', initialSeed: 'example-scam.xyz' });
  const seed = app.store.findEntity(op.id, 'domain', 'example-scam.xyz')!;
  const rec = await app.pursuit.executePivot(op.id, 'CT_SEARCH', seed.id);
  assert.equal(rec.status, 'failed');
  assert.match(rec.error ?? '', /502/);
  assert.equal(app.store.countEvidence(op.id), 0, 'no evidence invented on failure');
  app.close();
});

test('offline mode: network collectors unavailable, leads report why', () => {
  const app = makeApp({ networkMode: 'offline' });
  const op = app.operations.create({ name: 'Offline', initialSeed: 'offline-scam.xyz' });
  const leads = app.planner.refreshLeads(op.id);
  const ct = leads.find(l => l.pivotType === 'CT_SEARCH');
  assert.ok(ct?.blockedReason && /Offline/.test(ct.blockedReason));
  assert.equal(app.planner.candidates(op.id).length, 0, 'nothing runnable offline without evidence');
  app.close();
});
