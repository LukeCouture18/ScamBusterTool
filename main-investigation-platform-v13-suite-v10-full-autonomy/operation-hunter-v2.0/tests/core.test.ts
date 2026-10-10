import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalize, detectType, registrableDomain, extractIndicators, walletFamily } from '../server/core/canonical.ts';
import { staticUbiquity, ubiquityFromVolume, isCommodityIp } from '../server/engine/noise.ts';
import { HunterStore } from '../server/core/store.ts';
import { noisyOr, stableStringify } from '../server/core/util.ts';
import { makeApp, tempDir } from './helpers.ts';

test('canonicalisation resolves the same indicator written different ways', () => {
  assert.equal(canonicalize('domain', 'https://WWW.Example.COM/path?x=1'), 'example.com');
  assert.equal(canonicalize('domain', 'münchen-claim.de'), 'xn--mnchen-claim-dlb.de');
  assert.equal(canonicalize('wallet', '0xABCDEFabcdef0123456789012345678901234567 (Treasury)'), '0xabcdefabcdef0123456789012345678901234567');
  assert.equal(canonicalize('identifier', 'https://t.me/Arctic_Support'), '@arctic_support');
  assert.equal(canonicalize('identifier', 'g-99x4k21z'), 'G-99X4K21Z');
  assert.equal(canonicalize('asn', 'AS209588 (FlyHosting)'), 'AS209588');
  assert.equal(canonicalize('certificate', 'SHA256:AB:CD'), 'abcd');
  assert.equal(registrableDomain('a.b.claim-portal.co.uk'), 'claim-portal.co.uk');
  assert.equal(registrableDomain('evil.github.io'), 'evil.github.io');
});

test('type detection and wallet families', () => {
  assert.equal(detectType('0x71c8282929d0092e02e82110c49281a94b810b82'), 'wallet');
  assert.equal(detectType('TQn9Y2vKm98Zg24L9xP1w6XkLM99aQzR7t'), 'wallet');
  assert.equal(detectType('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), 'wallet');
  assert.equal(detectType('185.193.127.44'), 'ip');
  assert.equal(detectType('G-99X4K21Z'), 'identifier');
  assert.equal(detectType('eth-recovery-claim.top'), 'domain');
  assert.equal(detectType('not an indicator'), null);
  assert.equal(walletFamily('0x71c8282929d0092e02e82110c49281a94b810b82'), 'evm');
});

test('indicator extraction pulls wallets, trackers and handles out of page source', () => {
  const found = extractIndicators('<script>gtag("config","G-ABCDEF1234")</script> send to 0x71c8282929d0092e02e82110c49281a94b810b82 <a href="https://t.me/help_desk_bot">x</a> <a href="https://other-portal.xyz/claim">y</a> admin@scam-mail.io');
  const values = found.map(f => `${f.type}:${f.value}`);
  assert.ok(values.includes('wallet:0x71c8282929d0092e02e82110c49281a94b810b82'));
  assert.ok(values.includes('identifier:G-ABCDEF1234'));
  assert.ok(values.includes('identifier:@help_desk_bot'));
  assert.ok(values.includes('domain:other-portal.xyz'));
  assert.ok(values.includes('email:admin@scam-mail.io'));
});

test('commodity infrastructure is recognised statically and from result volume', () => {
  assert.ok(staticUbiquity('nameserver', 'kara.ns.cloudflare.com').ubiquity >= 0.9);
  assert.ok(staticUbiquity('nameserver', 'ns1.offshore-dns.is').ubiquity < 0.2);
  assert.ok(isCommodityIp('104.21.55.10'));
  assert.ok(!isCommodityIp('185.193.127.44'));
  assert.ok(staticUbiquity('domain', 'fonts.googleapis.com').ubiquity === 1);
  assert.ok(staticUbiquity('wallet', '0xabc', { labelKind: 'exchange' }).ubiquity >= 0.9);
  assert.ok(ubiquityFromVolume('REVERSE_IP', 5000) >= 0.9);
  assert.ok(ubiquityFromVolume('REVERSE_IP', 3) < 0.1);
});

test('utility math', () => {
  assert.equal(Math.round(noisyOr([0.5, 0.5]) * 100), 75);
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('store: migrations, transactions roll back, backups, reopen keeps data', () => {
  const dir = tempDir('hunter-store-');
  const store = new HunterStore({ dataDir: dir });
  assert.equal(store.schemaVersion(), 2);
  assert.equal(store.integrityCheck(), 'ok');
  store.setSetting('x', { a: 1 });
  assert.throws(() => store.tx(() => { store.setSetting('y', 2); throw new Error('boom'); }));
  assert.equal(store.getSetting('y', null), null, 'rolled back');
  store.tx(() => store.tx(() => store.setSetting('nested', true)));
  assert.equal(store.getSetting('nested', false), true, 'nested savepoints commit');
  const backup = store.backup(path.join(dir, 'b', 'copy.db'));
  assert.ok(fs.existsSync(backup));
  store.close();
  const reopened = new HunterStore({ dataDir: dir });
  assert.deepEqual(reopened.getSetting('x', null), { a: 1 });
  reopened.close();
  const fromBackup = new HunterStore({ dataDir: path.join(dir, 'b'), filename: 'copy.db' });
  assert.deepEqual(fromBackup.getSetting('x', null), { a: 1 });
  fromBackup.close();
});

test('operations: create, seeds, auto type detection, codes are unique', () => {
  const app = makeApp();
  const a = app.operations.create({ name: 'Test Op', initialSeed: 'https://www.Claim-Portal.xyz/login' });
  assert.equal(a.targetType, 'domain');
  assert.equal(a.initialSeed, 'claim-portal.xyz');
  const b = app.operations.create({ name: 'Test Op', initialSeed: '0x71c8282929d0092e02e82110c49281a94b810b82' });
  assert.notEqual(a.code, b.code);
  assert.equal(b.targetType, 'wallet');
  const seed = app.operations.addSeed(a.id, { value: 'G-99X4K21Z' });
  assert.equal(seed.type, 'identifier');
  const again = app.operations.addSeed(a.id, { value: 'g-99x4k21z' });
  assert.equal(again.id, seed.id, 'same seed is not duplicated');
  const ent = app.store.findEntity(a.id, 'identifier', 'G-99X4K21Z');
  assert.ok(ent?.isSeed);
  app.close();
});
