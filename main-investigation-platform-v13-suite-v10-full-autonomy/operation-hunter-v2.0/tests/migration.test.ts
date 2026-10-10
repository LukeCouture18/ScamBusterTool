import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { tempDir } from './helpers.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HunterApp } from '../server/app.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function legacyDirWithUserOperation() {
  const dir = tempDir('hunter-migrate-');
  const store = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'v04_store.json'), 'utf-8'));
  // A user-created v0.4 operation: seed expanded by the old simulator, plus one piece of real analyst evidence.
  const opId = 'op-user1';
  const now = new Date().toISOString();
  store.operations.push({ ...store.operations[0], id: opId, code: 'OP-MY-CASE', name: 'My case', initialSeed: 'my-reported-scam.top', summary: 'Reported by a victim', createdAt: now, updatedAt: now });
  store.seeds.push({ id: 'seed-u1', operationId: opId, type: 'domain', value: 'my-reported-scam.top', addedAt: now, status: 'expanded' });
  store.entities.push(
    { id: 'u-ent-1', operationId: opId, type: 'domain', value: 'my-reported-scam.top', label: 'my-reported-scam.top', metadata: {}, firstSeen: now, lastSeen: now, isActive: true, isSeed: true },
    { id: 'u-ent-2', operationId: opId, type: 'ip', value: '185.193.127.44', label: 'fake ip', metadata: {}, firstSeen: now, lastSeen: now, isActive: true },
    { id: 'u-ent-3', operationId: opId, type: 'wallet', value: '0x4444444444444444444444444444444444444444', label: 'victim-reported wallet', metadata: {}, firstSeen: now, lastSeen: now, isActive: true },
  );
  store.evidence.push(
    { id: 'u-ev-sim', operationId: opId, source: 'passive_dns', type: 'dns_resolution', timestamp: now, originalObservation: 'Domain my-reported-scam.top resolved to A record 185.193.127.44', rawData: {}, sha256Hash: 'x', provenance: 'Passive DNS Sensor Network Query', confidence: 0.98, status: 'valid', relatedEntityIds: ['u-ent-1', 'u-ent-2'] },
    { id: 'u-ev-real', operationId: opId, source: 'victim_report', type: 'manual_import', timestamp: now, originalObservation: 'Victim paid 0x4444444444444444444444444444444444444444 via the site', rawData: {}, sha256Hash: 'y', provenance: 'Analyst Manual Import', confidence: 0.9, status: 'valid', relatedEntityIds: ['u-ent-1', 'u-ent-3'] },
  );
  store.relationships.push(
    { id: 'u-rel-1', operationId: opId, sourceEntityId: 'u-ent-1', targetEntityId: 'u-ent-2', type: 'RESOLVES_TO', state: 'OBSERVED', confidence: 0.98, reasoning: 'A record', evidenceIds: ['u-ev-sim'], firstObserved: now, lastObserved: now },
    { id: 'u-rel-2', operationId: opId, sourceEntityId: 'u-ent-1', targetEntityId: 'u-ent-3', type: 'CONTROLS_WALLET', state: 'OBSERVED', confidence: 0.9, reasoning: 'victim report', evidenceIds: ['u-ev-real'], firstObserved: now, lastObserved: now },
  );
  fs.writeFileSync(path.join(dir, 'hunter_store.json'), JSON.stringify(store));
  return dir;
}

test('v0.4 JSON store migrates into SQLite: user data kept, simulated evidence quarantined, demo regenerated', () => {
  const dir = legacyDirWithUserOperation();
  const app = new HunterApp({ dataDir: dir, networkMode: 'offline' });
  const ops = app.store.getOperations();
  const mine = ops.find(o => o.id === 'op-user1')!;
  assert.ok(mine, 'user operation imported');
  assert.equal(mine.isDemo, false);
  const evidence = app.store.getEvidence(mine.id);
  const sim = evidence.find(e => e.id === 'u-ev-sim')!;
  const real = evidence.find(e => e.id === 'u-ev-real')!;
  assert.equal(sim.status, 'invalidated');
  assert.match(sim.invalidationReason!, /simulated/i);
  assert.equal(sim.synthetic, true);
  assert.equal(real.status, 'valid', 'analyst evidence is kept');
  const ip = app.store.findEntity(mine.id, 'ip', '185.193.127.44')!;
  assert.equal(ip.metadata.unsupported, true, 'entity only backed by simulated data is marked unsupported');
  const rel = app.store.getRelationships(mine.id).find(r => r.type === 'RESOLVES_TO')!;
  assert.equal(rel.state, 'UNRESOLVED');
  // the legacy demo is replaced by the v1.0 demo (synthetic and clearly flagged)
  const demo = ops.find(o => o.id === 'op-arctic-drainer')!;
  assert.equal(demo.isDemo, true);
  assert.ok(fs.readdirSync(dir).some(f => /hunter_store\.v0-backup-\d+\.json/.test(f)), 'original JSON kept as a backup');
  assert.ok(app.store.getMeta('legacy_import_done'));
  // reopening does not import twice
  app.close();
  const again = new HunterApp({ dataDir: dir, networkMode: 'offline' });
  assert.equal(again.store.getOperations().filter(o => o.id === 'op-user1').length, 1);
  // the imported operation still analyses cleanly
  const a = again.analyzer.get('op-user1')!;
  assert.ok(a.brief.headline);
  assert.ok(!again.planner.candidates('op-user1').some(c => c.entity.id === ip.id), 'unsupported entities are never expanded');
  again.close();
});

test('a corrupt legacy file does not block startup', () => {
  const dir = tempDir('hunter-corrupt-');
  fs.writeFileSync(path.join(dir, 'hunter_store.json'), '{ not json');
  const app = new HunterApp({ dataDir: dir, networkMode: 'offline', seedDemo: false });
  assert.match(app.store.getMeta('legacy_import_done') ?? '', /invalid/);
  app.close();
});
