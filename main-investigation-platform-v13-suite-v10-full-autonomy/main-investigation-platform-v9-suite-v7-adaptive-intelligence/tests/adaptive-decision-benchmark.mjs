/** v7 decision-quality benchmark (offline). Optimal-choice rate and regret under fixture truth for ten
 * situation types; production decision code receives observations only. Run: node --import tsx tests/adaptive-decision-benchmark.mjs */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WORLD_SCENARIOS, TABLE_SCENARIOS, evaluateWorldScenario, evaluateTableScenario } from '../bench-adaptive/scenarios.mjs';

const POLICIES = ['v7-exploit', 'v7', 'v6', 'cheapest', 'random'];
const SEEDS = (process.env.ADAPTIVE_SEEDS ?? '1,2,3,4,5').split(',').map(Number);
const started = performance.now();

// Truth isolation: no production module may import benchmark truth.
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const leaks = [...walk('lib'), ...walk('app')].filter(f => /\.(ts|tsx|mjs|js)$/.test(f) && /bench-adaptive|bench-director|world\.mjs/.test(readFileSync(f, 'utf8')));
assert.deepEqual(leaks, [], `production code must not import benchmark truth: ${leaks.join(', ')}`);

const results = [];
for (const sc of WORLD_SCENARIOS) for (const seed of SEEDS) results.push(evaluateWorldScenario(sc, seed, POLICIES));
for (const sc of TABLE_SCENARIOS) results.push(evaluateTableScenario(sc));

const summary = {};
for (const p of POLICIES) {
  const rows = results.map(r => r.policies[p]).filter(Boolean);
  summary[p] = { states: rows.length, optimal_choice_rate: +(rows.filter(r => r.optimal).length / rows.length).toFixed(3), near_optimal_rate: +(rows.filter(r => r.near_optimal).length / rows.length).toFixed(3),
    mean_regret: +(rows.reduce((x, r) => x + r.regret, 0) / rows.length).toFixed(3), total_regret: +rows.reduce((x, r) => x + r.regret, 0).toFixed(3) };
}
const byType = {};
for (const r of results) {
  const t = byType[r.type] ??= {};
  for (const p of POLICIES) { const x = r.policies[p]; if (!x) continue; const s = t[p] ??= { states: 0, optimal: 0, regret: 0 }; s.states++; s.optimal += x.optimal ? 1 : 0; s.regret = +(s.regret + x.regret).toFixed(3); }
}
const out = { ok: true, generated_at: new Date().toISOString(), seeds: SEEDS, states: results.length, truth_isolation: { production_imports_of_benchmark_truth: leaks.length }, method: {
  world: 'Each alternative is executed in a cloned hidden world, the v7 exploitation policy continues for 3 ticks (identical continuation for every alternative), the shared pipeline finishes, and the result is scored with fixture truth: +1 hidden site, +0.8 validated true wallet, +0.6 linkage discriminated, +0.6 contradiction resolved, +1 report ready, -0.3 wrong-operation proposal, -0.004 per request.',
  table: 'Investigation-level Director actions use explicit outcome tables (rationale in bench-adaptive/scenarios.mjs).',
  policies: { 'v7-exploit': 'production v7 choose() without exploration', v7: 'production v7 choose() with its bounded deterministic exploration', v6: 'v6 operation policy (seed-only related hunt / Hunter after contradiction); v5 Director value/cost order for Director scenarios', cheapest: 'cheapest available safe test', random: 'deterministic pseudo-random available test' } },
  summary, by_type: byType, results, elapsed_ms: Math.round(performance.now() - started) };
mkdirSync('verification/adaptive-v7', { recursive: true });
writeFileSync('verification/adaptive-v7/decision-benchmark.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ states: out.states, summary, by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([p, s]) => [p, `${s.optimal}/${s.states} regret ${s.regret}`]))])) }, null, 1));
