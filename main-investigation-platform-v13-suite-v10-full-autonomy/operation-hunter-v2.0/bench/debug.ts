import { generateWorld, truthDomains } from './world.ts';
import { fakeNetwork, PACED_HOSTS } from './fakeNetwork.ts';
const seed = Number(process.argv[2] ?? 5), diff = Number(process.argv[3] ?? 0.3), budget = Number(process.argv[4] ?? 90);
const mod = await import('../server/app.ts');
const w = generateWorld(seed, { difficulty: diff });
const net = fakeNetwork(w);
const app = new mod.HunterApp({ filename: ':memory:', seedDemo: false, networkMode: 'live', fetchImpl: net.fetch, dnsResolver: net.resolver });
for (const h of PACED_HOSTS) app.http.setPacing(h, 0);
if (app.analyzer) (app.analyzer as any).debounceMs = 1;
app.allocator.seed(seed * 7919 + Math.round(diff * 100));
const target = w.ops.find(o => o.id === w.target)!;
const wave2 = target.domains.map(d => w.domains.get(d)!).filter(d => d.registeredAt >= 40 && d.registeredAt < 80 && d.kit);
const seedValue = (process.env.SHARED ? (wave2.find(d => !d.ns[0].includes('-dns.')) ?? wave2[0]) : (wave2.find(d => d.ns[0].includes('-dns.')) ?? wave2[0])).name;
const op = app.operations.create({ name: 'dbg', initialSeed: seedValue, targetType: 'auto' });
await app.pursuit.runToCompletion(op.id, { budgetTotal: budget, maxHops: 5, concurrency: 3, maxMinutes: 600 }, budget + 5);
const a = app.analyzer.analyze(op.id)!;
console.log('seed', seedValue);
for (const name of truthDomains(w)) {
  const d = w.domains.get(name)!;
  const e = app.store.getEntities(op.id).find((x: any) => x.value === name);
  const m = e ? a.membership.byId[e.id] : null;
  console.log(`${name.padEnd(34)} reg=${d.registeredAt} ns=${d.ns[0].slice(0, 18).padEnd(18)} scanned=${d.scanned} cert=${d.certGroup.includes('+')} kit=${d.kit?.version} -> ${e ? `${m?.status} ${m?.probability} | ${m?.factors.slice(0, 3).map((f: any) => `${f.weight}:${f.key}`).join(', ')}` : 'NOT FOUND'}`);
}
const nonTruth = a.membership.members.filter((m: any) => m.type === 'domain' && !truthDomains(w).includes(m.value) && m.status !== 'unknown');
console.log('non-truth assessed:', nonTruth.map((m: any) => `${m.value}:${m.status}:${m.probability}`).join('  '));
const piv = app.store.getPivots(op.id, 1000);
const counts: Record<string, number> = {};
for (const p of piv) counts[p.pivotType] = (counts[p.pivotType] ?? 0) + 1;
console.log('pivots', counts);
console.log('patterns', app.store.getEntities(op.id).filter((e: any) => e.type === 'pattern').map((e: any) => e.value));
console.log('branches', app.intel.getBranches(op.id).map((b: any) => `${b.kind}:${b.status}:${b.stats.pulls}:${b.stats.progress}`).join(' '));
console.log('run', JSON.stringify(app.store.latestRun(op.id)?.stopReason));
console.log('top learner', app.allocator.learner.table().slice(0, 12));
if (process.env.TRACE) for (const p of piv.slice().reverse()) { const e = app.store.getEntity(p.entityId); console.log(p.pivotType.padEnd(16), (e?.value ?? '').slice(0, 40).padEnd(40), p.status, p.progress, (p as any).resultCount ?? ''); }
if (process.env.WHY) for (const v of process.env.WHY.split(',')) { const e = app.store.getEntities(op.id).find((x: any) => x.value === v); const m = e ? a.membership.byId[e.id] : null; console.log('WHY', v, m?.status, m?.probability, JSON.stringify(m?.factors.map((f: any) => `${f.weight} ${f.text}`), null, 1)); }
