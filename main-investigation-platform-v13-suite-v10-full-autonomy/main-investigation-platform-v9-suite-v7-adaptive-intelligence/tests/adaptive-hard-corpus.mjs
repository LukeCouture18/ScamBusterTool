/** v7 harder hidden-operation corpus (offline simulation). Several independent operations at once, starting from
 * one seed each: unrelated shared kit, shared CDN, wallet reuse and rotation, replacement sites, an operation split
 * (late contradiction), provider outage and recovery, dead branches, multi-hop chains, reappearance, a new deployment
 * wave, decoy wallets on transaction-history pages and common transaction counterparties. Hidden sites/wallets enter
 * a policy's view only when a simulated specialist legitimately reveals them.
 * Run: node --import tsx tests/adaptive-hard-corpus.mjs */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildWorld } from '../bench-adaptive/world.mjs';
import { run, v7Policy, v6Policy, randomPolicy, snapshotFor } from '../bench-adaptive/sim.mjs';

const SEEDS = (process.env.ADAPTIVE_SEEDS ?? '1,2,3,4,5').split(',').map(Number);
const TICKS = Number(process.env.ADAPTIVE_TICKS ?? 16);
const policies = [() => v6Policy(), () => v7Policy(), () => v7Policy({ exploration: false }), () => randomPolicy(11)];
const started = performance.now();
const runs = [];
for (const seed of SEEDS) for (const mk of policies) {
  const world = buildWorld(seed); const r = run(world, mk(), { ticks: TICKS, horizon: 3 });
  runs.push({ seed, ...r, decisions: r.decisions.map(d => ({ tick: d.tick, op: d.op, chose: d.chose, value: d.value, best: d.best, regret: d.regret, optimal: d.optimal, alternatives: d.alternatives, exploration: d.exploration })) });
  console.log(`seed ${seed} ${r.policy}: sites ${r.hidden_sites_discovered}/${r.true_sites_existing} wallets ${r.validated_true_wallets} requests ${r.requests} regret ${r.decision_quality?.mean_regret}`);
}
// Equal request budgets: the same spend for each policy (no counterfactual bookkeeping).
const budgets = [];
for (const seed of SEEDS) for (const budget of [600, 900]) for (const mk of [() => v6Policy(), () => v7Policy()]) {
  const r = run(buildWorld(seed), mk(), { ticks: 24, counterfactuals: false, requestBudget: budget });
  budgets.push({ seed, budget, policy: r.policy, sites: r.hidden_sites_discovered, wallets: r.validated_true_wallets, linkage: r.linkage_discriminated, contradictions: r.contradictions_resolved, reports: r.reports_ready, replacements: r.replacements_found, wave: r.wave_sites_found, false_relationships: r.false_relationships, requests: r.requests });
}
// Truth isolation check: every site in a policy snapshot was revealed to observations (none injected from truth).
const probe = buildWorld(99); run(probe, v7Policy(), { ticks: 6, counterfactuals: false });
const ob = probe.observed();
for (const op of Object.keys(ob.ops)) for (const site of snapshotFor(ob, op, [], {}).sites) assert.ok(ob.sites[site.key], `snapshot site ${site.key} must come from observations`);
const hidden = Object.keys(probe.s.sites).filter(k => !ob.sites[k]);
assert.ok(hidden.length > 0, 'some hidden sites remain undiscovered in a short run (they are not injected)');

const mean = (rows, f) => +(rows.reduce((x, r) => x + f(r), 0) / rows.length).toFixed(3);
const summary = {};
for (const name of [...new Set(runs.map(r => r.policy))]) {
  const rows = runs.filter(r => r.policy === name);
  summary[name] = { runs: rows.length, hidden_sites_discovered: mean(rows, r => r.hidden_sites_discovered), true_sites_existing: mean(rows, r => r.true_sites_existing), validated_true_wallets: mean(rows, r => r.validated_true_wallets),
    multi_hop: mean(rows, r => r.multi_hop), replacements_found: mean(rows, r => r.replacements_found), wave_sites_found: mean(rows, r => r.wave_sites_found), linkage_discriminated: mean(rows, r => r.linkage_discriminated),
    contradictions_resolved: mean(rows, r => r.contradictions_resolved), reports_ready: mean(rows, r => r.reports_ready), false_relationships: mean(rows, r => r.false_relationships),
    requests: mean(rows, r => r.requests), jobs: mean(rows, r => r.jobs), provider_calls: mean(rows, r => r.provider_calls), requests_per_hidden_site: mean(rows, r => r.requests_per_hidden_site ?? 0),
    independent_evidence_per_100_requests: mean(rows, r => r.independent_evidence_per_100_requests), actions: mean(rows, r => r.actions), useful_rate: mean(rows, r => r.useful_rate), wasted_actions: mean(rows, r => r.wasted_actions),
    optimal_choice_rate: mean(rows, r => r.decision_quality?.optimal_rate ?? 0), near_optimal_rate: mean(rows, r => r.decision_quality?.near_optimal_rate ?? 0), mean_regret: mean(rows, r => r.decision_quality?.mean_regret ?? 0),
    max_wait_ticks: Math.max(...rows.map(r => r.max_consecutive_wait_ticks)), runaway_max_repeat: Math.max(...rows.map(r => r.runaway_max_repeat)),
    exploration_starts: rows.reduce((x, r) => x + r.exploration.starts, 0), exploration_useful: rows.reduce((x, r) => x + r.exploration.useful, 0), budget_adjustments: rows.reduce((x, r) => x + r.budget_adjustments.length, 0) };
}
// Discovery curves: hidden sites found by the time a policy had spent N requests (step interpolation; a policy that
// stopped earlier keeps its final count). This compares recall at EQUAL spend.
const levels = [300, 500, 700, 900, 1100, 1300];
const atSpend = (curve, n) => { let v = 0; for (const p of curve) if (p.requests <= n) v = p.sites; return v; };
const curves = {};
for (const name of [...new Set(runs.map(r => r.policy))]) { const rows = runs.filter(r => r.policy === name); curves[name] = Object.fromEntries(levels.map(n => [n, mean(rows, r => atSpend(r.curve, n))])); }
const equal = {};
for (const b of [600, 900]) for (const name of ['v6 operation policy', 'v7 adaptive']) {
  const rows = budgets.filter(r => r.budget === b && r.policy === name);
  equal[`${b}:${name}`] = { sites: mean(rows, r => r.sites), wallets: mean(rows, r => r.wallets), linkage: mean(rows, r => r.linkage), contradictions: mean(rows, r => r.contradictions), reports: mean(rows, r => r.reports), replacements: mean(rows, r => r.replacements), wave: mean(rows, r => r.wave), false_relationships: mean(rows, r => r.false_relationships), requests: mean(rows, r => r.requests) };
}
const out = { ok: true, discovery_curve_sites_at_requests: curves, kind: 'SIMULATION — synthetic specialists over a synthetic hidden world; measures decision policy, not internet recall', seeds: SEEDS, ticks: TICKS, summary, equal_budget: equal, runs, budgets, elapsed_ms: Math.round(performance.now() - started) };
mkdirSync('verification/adaptive-v7', { recursive: true });
writeFileSync('verification/adaptive-v7/hard-corpus.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ summary, equal_budget: equal, discovery_curve_sites_at_requests: curves }, null, 1));
