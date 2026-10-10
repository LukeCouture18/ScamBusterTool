/**
 * Ground-truth benchmark: runs one or more Hunter engines against generated
 * adversarial worlds served through the real API formats, and scores
 * reconstruction quality, false attribution, operator/money intelligence,
 * efficiency and reappearance detection.
 *
 *   node --import tsx bench/run.ts --engines v2 --seeds 1,2,3 --difficulty 0.4,0.8 --budget 90
 *   V1_DIR=../operation-hunter-v1.0 node --import tsx bench/run.ts --engines v1,v2
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { generateWorld, truthDomains, advance, World } from './world.ts';
import { fakeNetwork, PACED_HOSTS } from './fakeNetwork.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface EngineAdapter {
  name: string;
  load(): Promise<any>;
  extract(app: any, opId: string, w: World): Extracted;
  continuePursuit(app: any, opId: string, budget: number): Promise<void>;
  afterAdvance(app: any, opId: string, w: World): Promise<void>;
}

export interface Extracted {
  core: string[];                 // domains the engine presents as members of the operation
  operatorIndicators: string[];
  wallets: Record<string, string>; // address -> role
  reappearance: string[];         // candidates the engine flags as a likely return of this operation
  hypothesesTop: string[];
  pivots: number;
  contradictions: number;
}

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

export function engineFromDir(name: string, dir: string, kind: 'v1' | 'v2'): EngineAdapter {
  let mod: any;
  return {
    name,
    async load() {
      if (!mod) mod = await import(pathToFileURL(path.join(dir, 'server/app.ts')).href);
      return mod;
    },
    extract(app, opId, w) {
      const a = kind === 'v2' && app.analyzer.get ? app.analyzer.get(opId) : app.analyzer.get(opId);
      let core: string[];
      if (kind === 'v2' && a.membership) core = a.membership.members.filter((m: any) => m.type === 'domain' && m.status === 'member').map((m: any) => m.value);
      else core = a.infrastructure.domains.filter((d: any) => d.role === 'core' && !d.isResourceHost).map((d: any) => d.value);
      const operatorIndicators = (a.kits?.operatorIndicators ?? []).map((i: any) => String(i.value));
      const wallets: Record<string, string> = {};
      for (const wal of a.financial?.wallets ?? []) wallets[String(wal.address).toLowerCase()] = wal.role;
      const reapp = app.store.getReappearanceLeads(opId).filter((l: any) => l.status === 'CONFIRMED_ROTATION' || l.overallSimilarityScore >= 75).map((l: any) => l.candidateValue);
      const newWave = kind === 'v2' && a.membership ? a.membership.members.filter((m: any) => m.type === 'domain' && m.status === 'member' && m.via === 'reappearance').map((m: any) => m.value) : [];
      return {
        core, operatorIndicators, wallets, reappearance: [...new Set([...reapp, ...newWave])],
        hypothesesTop: (a.hypotheses ?? []).filter((h: any) => h.confidenceScore >= 0.7).map((h: any) => h.category),
        pivots: app.store.getPivots(opId, 100000).filter((p: any) => p.status !== 'queued').length,
        contradictions: (a.contradictions2 ?? a.contradictions ?? []).length,
      };
    },
    async continuePursuit(app, opId, budget) {
      await app.pursuit.runToCompletion(opId, { budgetTotal: budget, maxHops: 5, concurrency: 3, allowDelegation: false, maxMinutes: 600 }, budget + 5);
    },
    async afterAdvance(app, opId) {
      if (kind === 'v2' && app.hunts) { await app.hunts.runOperation(opId, { force: true }); }
      if (!app.store.getMonitors(opId).length) app.monitor.ensureDefaultMonitors(opId);
      await app.monitor.runOperation(opId);
      await app.pursuit.runToCompletion(opId, { budgetTotal: 25, maxHops: 5, concurrency: 3, allowDelegation: false, maxMinutes: 600 }, 30);
      app.analyzer.analyze(opId);
    },
  };
}

export interface RunResult {
  engine: string; seed: number; difficulty: number; seedKind: string;
  precision: number; recall: number; f1: number; falseAttribution: string[]; plantedAbsorbed: boolean; lookalikeAbsorbed: number;
  operatorRecall: number; treasuryFound: boolean; depositFound: boolean; feeCorrect: boolean; pivots: number; requests: number;
  curve: Array<{ pivots: number; recall: number; precision: number }>; pivotsTo80: number | null;
  reappearanceDetected: number; reappearanceTotal: number; reappearanceFalse: number; contradictions: number; ms: number;
}

export async function runOne(engine: EngineAdapter, seed: number, difficulty: number, seedKind: 'domain' | 'wallet' | 'shared', budget: number, step = 15): Promise<RunResult> {
  const t0 = Date.now();
  const w = generateWorld(seed, { difficulty });
  const net = fakeNetwork(w);
  const mod = await engine.load();
  const app = new mod.HunterApp({ filename: ':memory:', seedDemo: false, networkMode: 'live', fetchImpl: net.fetch, dnsResolver: net.resolver });
  for (const h of PACED_HOSTS) app.http.setPacing(h, 0);
  if (app.analyzer) app.analyzer.debounceMs = 1;
  app.allocator?.seed?.(seed * 7919 + Math.round(difficulty * 100));
  const target = w.ops.find(o => o.id === w.target)!;
  const wave2 = target.domains.map(d => w.domains.get(d)!).filter(d => d.registeredAt >= 40 && d.registeredAt < 80 && d.kit);
  const seedValue = seedKind === 'wallet' ? target.wallets.collection[1] : seedKind === 'shared' ? (wave2.find(d => !d.ns[0].includes('-dns.')) ?? wave2[0]).name : (wave2.find(d => d.ns[0].includes('-dns.')) ?? wave2[0]).name;
  const op = app.operations.create({ name: `Bench ${seed}`, initialSeed: seedValue, targetType: 'auto' });
  const curve: RunResult['curve'] = [];
  const score = (core: string[]) => {
    const truth = new Set(truthDomains(w));
    const tp = core.filter(d => truth.has(d)).length;
    return { precision: core.length ? tp / core.length : 0, recall: truth.size ? tp / truth.size : 0 };
  };
  let lastPivots = -1;
  for (let spent = 0; spent < budget;) {
    const chunk = Math.min(step, budget - spent);
    await engine.continuePursuit(app, op.id, chunk);
    app.analyzer.analyze(op.id);
    const ex = engine.extract(app, op.id, w);
    const s = score(ex.core);
    curve.push({ pivots: ex.pivots, recall: round(s.recall), precision: round(s.precision) });
    if (ex.pivots === lastPivots) break; // nothing left to do
    lastPivots = ex.pivots;
    spent = ex.pivots;
  }
  const ex = engine.extract(app, op.id, w);
  const s = score(ex.core);
  const truth = new Set(truthDomains(w));
  const falseAttribution = ex.core.filter(d => !truth.has(d));
  const opIds = [target.operator.ga, target.operator.telegram].map(x => x.toLowerCase());
  const found = ex.operatorIndicators.map(x => x.toLowerCase());
  const walletRole = (a: string) => ex.wallets[a.toLowerCase()];
  const result: RunResult = {
    engine: engine.name, seed, difficulty, seedKind,
    precision: round(s.precision), recall: round(s.recall), f1: round(s.precision + s.recall ? (2 * s.precision * s.recall) / (s.precision + s.recall) : 0),
    falseAttribution, plantedAbsorbed: Boolean(w.adversarial.plantedOn && ex.core.includes(w.adversarial.plantedOn)), lookalikeAbsorbed: w.adversarial.lookalikes.filter(l => ex.core.includes(l)).length,
    operatorRecall: round(opIds.filter(i => found.includes(i)).length / opIds.length),
    treasuryFound: target.wallets.treasury.some(t => walletRole(t) === 'TREASURY'), depositFound: target.wallets.deposit.some(t => walletRole(t) === 'CEX_DEPOSIT'),
    feeCorrect: walletRole(w.vendor.feeWallet) === 'FEE_RECIPIENT' || walletRole(w.vendor.feeWallet) === undefined,
    pivots: ex.pivots, requests: net.count(), curve, pivotsTo80: curve.find(c => c.recall >= 0.8)?.pivots ?? null,
    reappearanceDetected: 0, reappearanceTotal: 0, reappearanceFalse: 0, contradictions: ex.contradictions, ms: 0,
  };
  // Reappearance: the operation launches a new wave after the analyst's session.
  const before = new Set(truthDomains(w));
  advance(w, 30);
  const newWave = truthDomains(w).filter(d => !before.has(d));
  await engine.afterAdvance(app, op.id, w);
  const ex2 = engine.extract(app, op.id, w);
  const flagged = new Set([...ex2.reappearance, ...ex2.core.filter(d => !before.has(d))]);
  result.reappearanceTotal = newWave.length;
  result.reappearanceDetected = newWave.filter(d => flagged.has(d)).length;
  result.reappearanceFalse = [...flagged].filter(d => !truthDomains(w).includes(d) && !before.has(d)).length;
  result.ms = Date.now() - t0;
  app.close?.();
  return result;
}

function round(n: number) { return Math.round(n * 1000) / 1000; }

export function summarize(results: RunResult[]) {
  const by = new Map<string, RunResult[]>();
  for (const r of results) { const k = `${r.engine} · ${r.seedKind} seed`; (by.get(k) ?? by.set(k, []).get(k)!).push(r); }
  const rows = [...by.entries()].sort((a, b) => a[0].split(' · ')[1].localeCompare(b[0].split(' · ')[1]) || a[0].localeCompare(b[0])).map(([engine, rs]) => {
    const mean = (f: (r: RunResult) => number) => round(rs.reduce((s, r) => s + f(r), 0) / rs.length);
    return {
      engine, runs: rs.length,
      precision: mean(r => r.precision), recall: mean(r => r.recall), f1: mean(r => r.f1),
      falseAttributions: mean(r => r.falseAttribution.length), plantedAbsorbed: mean(r => (r.plantedAbsorbed ? 1 : 0)), lookalikes: mean(r => r.lookalikeAbsorbed),
      operatorRecall: mean(r => r.operatorRecall), treasury: mean(r => (r.treasuryFound ? 1 : 0)), deposit: mean(r => (r.depositFound ? 1 : 0)), feeCorrect: mean(r => (r.feeCorrect ? 1 : 0)),
      pivots: mean(r => r.pivots), requests: mean(r => r.requests), pivotsTo80: mean(r => r.pivotsTo80 ?? r.pivots * 1.5), reached80: mean(r => (r.pivotsTo80 === null ? 0 : 1)),
      reappearance: round(rs.reduce((s, r) => s + r.reappearanceDetected, 0) / Math.max(1, rs.reduce((s, r) => s + r.reappearanceTotal, 0))), reappearanceFalse: mean(r => r.reappearanceFalse),
      seconds: mean(r => r.ms / 1000),
    };
  });
  return rows;
}

export function markdownTable(rows: ReturnType<typeof summarize>) {
  const cols: Array<[string, (r: any) => string]> = [
    ['Engine', r => r.engine], ['Runs', r => String(r.runs)], ['Precision', r => r.precision.toFixed(2)], ['Recall', r => r.recall.toFixed(2)], ['F1', r => r.f1.toFixed(2)],
    ['False members / run', r => r.falseAttributions.toFixed(2)], ['False-flag site absorbed', r => pct(r.plantedAbsorbed)], ['Look-alikes absorbed', r => r.lookalikes.toFixed(2)],
    ['Operator IDs found', r => pct(r.operatorRecall)], ['Treasury found', r => pct(r.treasury)], ['Exchange deposit found', r => pct(r.deposit)], ['Vendor fee wallet not misread', r => pct(r.feeCorrect)],
    ['Lookups used', r => r.pivots.toFixed(0)], ['Lookups to 80% recall', r => r.pivotsTo80.toFixed(0)], ['Reached 80% recall', r => pct(r.reached80)],
    ['New wave detected', r => pct(r.reappearance)], ['False reappearances', r => r.reappearanceFalse.toFixed(2)], ['Seconds / run', r => r.seconds.toFixed(1)],
  ];
  return [`| ${cols.map(c => c[0]).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${cols.map(c => c[1](r)).join(' | ')} |`)].join('\n');
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

async function main() {
  const engines = arg('engines', 'v2').split(',');
  const seeds = arg('seeds', '1,2,3').split(',').map(Number);
  const diffs = arg('difficulty', '0.4,0.8').split(',').map(Number);
  const kinds = arg('kinds', 'domain,wallet').split(',') as Array<'domain' | 'wallet' | 'shared'>;
  const budget = Number(arg('budget', '90'));
  const out = arg('out', path.join(here, 'results', `bench-${Date.now()}.json`));
  const adapters: EngineAdapter[] = engines.map(e => e === 'v1'
    ? engineFromDir('v1.0', process.env.V1_DIR ?? path.resolve(here, '../../hunter-v1-ref'), 'v1')
    : engineFromDir('v2.0', path.resolve(here, '..'), 'v2'));
  const results: RunResult[] = [];
  for (const engine of adapters) for (const seed of seeds) for (const d of diffs) for (const k of kinds) {
    const r = await runOne(engine, seed, d, k, budget);
    results.push(r);
    console.log(`${engine.name} seed=${seed} diff=${d} ${k}: P=${r.precision} R=${r.recall} F1=${r.f1} false=${r.falseAttribution.length} opIDs=${r.operatorRecall} reapp=${r.reappearanceDetected}/${r.reappearanceTotal} pivots=${r.pivots} (${(r.ms / 1000).toFixed(1)}s)`);
  }
  const rows = summarize(results);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), budget, seeds, diffs, kinds, rows, results }, null, 2));
  console.log(`\n${markdownTable(rows)}\n\nSaved ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => { console.error(err); process.exit(1); });
}
