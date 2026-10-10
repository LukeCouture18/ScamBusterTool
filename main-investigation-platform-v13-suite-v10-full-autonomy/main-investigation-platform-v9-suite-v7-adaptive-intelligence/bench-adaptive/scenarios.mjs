/**
 * v7 decision-quality scenarios (OFFLINE ONLY). Each scenario prepares an observable state in which
 * several legitimate tests are available and they have different downstream value. Truth is either
 *  - world: computed by executing every alternative in a cloned hidden world and rolling forward, or
 *  - table: an explicit outcome table for investigation-level Director actions (documented rationale).
 * Policies never see truth; they see the production snapshot built from observations only.
 */
import { buildWorld, netValue } from './world.mjs';
import { apply, counterfactual, snapshotFor, learningFrom, v7Policy, v6Policy } from './sim.mjs';
import { deriveGaps, generateCandidates, fnv } from '../lib/adaptive/derive.ts';
import { choose, costUnits } from '../lib/adaptive/value.ts';
import { portfolioOrder } from '../lib/adaptive/policy.ts';
import { scientificChoice, v8ScientificChoice } from '../lib/scientific/model.ts';
import { TESTS } from '../lib/adaptive/ontology.ts';
import { rankDirectorActions } from '../lib/adaptive/director-rank.ts';

const SPEC = (ops, extra = {}) => ({ ops, decoys: 6, provider_outage: [100, 101], ...extra });
const seedOf = (w, op) => w.s.ops[op].seed;
const siteOf = (w, op, i) => w.s.ops[op].sites[i];
const observe = (w, op, key, why = 'hunter') => { w.s.observed.sites[key] ??= { key, op, found_by: why, found_at: w.s.tick, inspected: false, status: 'live', artifacts: null, deposit: [], history: [], login: false, inspected_at: null }; };
// Searches really run in the world (persistent Finder pursuit), so "already searched" is consistent with truth.
const sent = (w, op, ...values) => { const artifacts = values.filter(Boolean).map(v => ({ kind: String(v).startsWith('ga4:') ? 'analytics' : String(v).startsWith('0x') ? 'wallet' : 'contact', value: v })); w.finder(op, { seeds: [w.s.ops[op].seed], artifacts }); };
const tickTo = (w, t) => { while (w.s.tick < t) w.advance(); };
const prior = (log, op, family, subject, n, useful = false) => { for (let i = 0; i < n; i++) log.push({ op, family, subject, inputs_hash: `prior:${i}`, done: true, useful, duplicate: !useful, requests: 25, tick: 0, outcomes: {} }); };
const C = (family, subject, objective = {}) => ({ key: `${family}:${subject}:${fnv(JSON.stringify(objective))}`, family, subject, inputs_hash: fnv(JSON.stringify(objective)), objective, prerequisites_met: true, bounds: TESTS[family].bounds, gaps: [] });

/** World-based scenarios. `ops` lists the operations competing for this decision (one slot). */
export const WORLD_SCENARIOS = [
  { type: 'useful_vs_saturated_finder_branch', build(seed) {
    const w = buildWorld(seed, SPEC([{ id: 'S', kit: 'K1', n: 5, links: false, die: [], rotate: [] }])), op = `S${seed}`, log = [];
    w.inspect(seedOf(w, op)); w.walletPipeline();
    for (let i = 0; i < 3; i++) apply(w, log, op, C('RELATED_SITE_HUNT', `scope:${op}`, { seeds: [seedOf(w, op)], artifacts: [] }), i);
    for (const t of log) t.done = true; tickTo(w, 3);
    return { world: w, log, ops: [op], note: 'Three seed-only related hunts were empty; a distinctive contact and analytics id were just recorded and never searched.' };
  } },
  { type: 'generic_template_vs_discriminating_wallet', build(seed) {
    const w = buildWorld(seed, SPEC([{ id: 'T', kit: 'K1', n: 5, links: false, die: [], rotate: [] }], { decoys: 10 })), op = `T${seed}`, log = [];
    w.inspect(seedOf(w, op)); w.walletPipeline(); w.hunter(op);
    const o = w.s.observed.sites[seedOf(w, op)];
    sent(w, op, o.artifacts.contact, o.artifacts.analytics); prior(log, op, 'PUBLIC_ARTIFACT_SEARCH', `artifact:contact:${o.artifacts.contact}`, 1); prior(log, op, 'PUBLIC_ARTIFACT_SEARCH', `artifact:analytics:${o.artifacts.analytics}`, 1);
    tickTo(w, 2);
    return { world: w, log, ops: [op], note: 'Linkage question open; contact/analytics already searched; options include a generic template-variant search and a validated deposit-wallet reuse search.' };
  } },
  { type: 'new_contradiction_vs_confirmation', build(seed) {
    const w = buildWorld(seed, SPEC([{ id: 'D', kit: 'K2', n: 4, links: false, die: [], rotate: [], split: true }])), op = `D${seed}`, log = [];
    for (const i of [0, 1, 2, 3]) { observe(w, op, siteOf(w, op, i)); }
    w.inspect(siteOf(w, op, 0)); w.inspect(siteOf(w, op, 2)); w.walletPipeline(); w.hunter(op);
    w.inspect(siteOf(w, op, 1)); w.inspect(siteOf(w, op, 3)); w.walletPipeline();
    const o = w.s.observed.sites[siteOf(w, op, 0)]; sent(w, op, o.artifacts.contact, o.artifacts.analytics, w.s.observed.sites[siteOf(w, op, 2)].artifacts.contact);
    prior(log, op, 'RELATED_SITE_HUNT', `scope:${op}`, 2);
    tickTo(w, 3);
    return { world: w, log, ops: [op], note: 'A new contradiction (two support contacts present one wallet) has new evidence since Hunter last looked; every site is already known (confirmation-seeking hunts can only re-find the kit).' };
  } },
  { type: 'replacement_hunt_vs_exhausted_artifact', build(seed) {
    const w = buildWorld(seed, SPEC([{ id: 'R', kit: 'K1', n: 4, links: false, die: [{ i: 1, at: 2, replace: true }], rotate: [] }])), op = `R${seed}`, log = [];
    observe(w, op, siteOf(w, op, 1)); w.inspect(seedOf(w, op)); w.inspect(siteOf(w, op, 1)); w.walletPipeline();
    const o = w.s.observed.sites[seedOf(w, op)]; sent(w, op, o.artifacts.contact); prior(log, op, 'PUBLIC_ARTIFACT_SEARCH', `artifact:contact:${o.artifacts.contact}`, 1);
    tickTo(w, 4);
    return { world: w, log, ops: [op], note: 'A member site disappeared and its replacement is live; the historical contact artifact was already searched.' };
  } },
  { type: 'novel_exploration_opportunity', build(seed) {
    const w = buildWorld(seed, SPEC([{ id: 'N', kit: 'K2', n: 3, links: false, die: [], rotate: [{ i: 0, at: 2 }] }])), op = `N${seed}`, log = [];
    w.inspect(seedOf(w, op)); w.walletPipeline();
    const o = w.s.observed.sites[seedOf(w, op)]; sent(w, op, o.artifacts.contact, o.artifacts.analytics, ...o.deposit);
    prior(log, 'elsewhere', 'RELATED_SITE_HUNT', 'scope:elsewhere', 6); prior(log, 'elsewhere', 'PUBLIC_ARTIFACT_SEARCH', 'artifact:elsewhere', 6);
    tickTo(w, 3);
    return { world: w, log, ops: [op], note: 'Familiar test families have poor recorded yield; an under-tested temporal re-check addresses a recorded public change.' };
  } },
  { type: 'two_competing_operations', build(seed) {
    const w = buildWorld(seed, SPEC([{ id: 'X', kit: 'K1', n: 5, links: false, die: [], rotate: [] }, { id: 'Y', kit: 'K2', n: 3, links: false, die: [], rotate: [] }])), x = `X${seed}`, y = `Y${seed}`, log = [];
    w.inspect(seedOf(w, x)); w.inspect(seedOf(w, y)); w.walletPipeline();
    const oy = w.s.observed.sites[seedOf(w, y)]; sent(w, y, oy.artifacts.contact, oy.artifacts.analytics, ...oy.deposit);
    for (let i = 0; i < 3; i++) apply(w, log, y, C('RELATED_SITE_HUNT', `scope:${y}`, { seeds: [seedOf(w, y)], artifacts: [] }), i);
    for (const t of log) t.done = true; tickTo(w, 3);
    return { world: w, log, ops: [x, y], note: 'One slot: operation X has fresh distinctive artifacts; operation Y is saturated.' };
  } },
  { type: 'time_sensitive_disappearing_site', build(seed) {
    const w = buildWorld(seed, SPEC([{ id: 'Q', kit: 'K1', n: 4, links: false, die: [{ i: 1, at: 3, replace: false }], rotate: [] }])), op = `Q${seed}`, log = [];
    w.inspect(seedOf(w, op)); w.walletPipeline(); observe(w, op, siteOf(w, op, 1));
    const o = w.s.observed.sites[seedOf(w, op)]; sent(w, op, o.artifacts.contact);
    tickTo(w, 2); w.s.observed.sites[siteOf(w, op, 1)].status = 'returned';
    return { world: w, log, ops: [op], note: 'A proposed member site is flapping (returned after going dark) and has never been inspected; it disappears next tick.' };
  } },
  { type: 'expensive_high_value_vs_cheap_low_value', build(seed) {
    const w = buildWorld(seed, SPEC([{ id: 'E', kit: 'K2', n: 6, links: false, die: [], rotate: [] }])), op = `E${seed}`, log = [];
    w.inspect(seedOf(w, op)); w.walletPipeline();
    w.s.observed.sites[seedOf(w, op)].monitor_changed = true; // a cosmetic page change the monitor noticed (no new wallet)
    tickTo(w, 1);
    return { world: w, log, ops: [op], note: 'A cheap re-check of a cosmetically changed page versus a more expensive search for an unsearched distinctive contact.' };
  } },
];

/** Investigation-level Director scenarios with explicit outcome tables (Director actions are not world tests). */
export const TABLE_SCENARIOS = [
  { type: 'provider_retry_vs_unrelated_expansion', ctx: { inv: 'inv-r', site: { id: 's', canonical_key: 'site-r.example' }, investigated: true, reportReady: false, priorActions: [], providerHealth: [{ network: 'ethereum', state: 'healthy' }],
      cands: [{ id: 'c1', identity: 'evm:0xaa', address: '0xaa', validated_network: 'ethereum', best_context: 'deposit', validation_status: 'valid', analysis_status: 'partial', validated_sites: 1 }] },
    actions: [{ kind: 'provider_retry', target: 'c1', gap: 'blockchain_evidence', reason: 'Retry blockchain analysis because the provider backoff expired', value: .95, cost: 1, fingerprint: 'retry:c1:1' },
      { kind: 'find_related', target: 'site-r.example', gap: 'related_sites', reason: 'Start a bounded related-site hunt from recorded public artifacts', value: .45, cost: 2, fingerprint: 'finder:s' }],
    // Rationale: the provider recovered, so the retry completes the only missing report field; the expansion is on an exhausted branch.
    truth: { provider_retry: 1.0 - 6 * .004, find_related: .1 - 25 * .004 } },
  { type: 'report_blocker_vs_low_value_correlation', ctx: { inv: 'inv-b', site: { id: 's', canonical_key: 'site-b.example' }, investigated: true, reportReady: false, priorActions: [], providerHealth: [{ network: 'ethereum', state: 'healthy' }],
      cands: [{ id: 'c1', identity: 'evm:0xbb', address: '0xbb', validated_network: 'ethereum', best_context: 'deposit', validation_status: 'valid', analysis_status: 'failed', validated_sites: 1 }] },
    actions: [{ kind: 'provider_retry', target: 'c1', gap: 'blockchain_evidence', reason: 'Retry blockchain analysis because the provider backoff expired', value: .95, cost: 1, fingerprint: 'retry:c1:2' },
      { kind: 'correlate_wallet', target: 'evm:0xbb', gap: 'operation_correlation', reason: 'Check where this validated deposit wallet has also been observed', value: .65, cost: .2, fingerprint: 'correlate:evm:0xbb:1' }],
    // Rationale: the wallet has no other observation in Main (correlation finds nothing); the retry unblocks the report.
    truth: { provider_retry: 1.0 - 6 * .004, correlate_wallet: 0 } },
];

/** Policies for a single decision. Each returns the candidate it would start for the scenario's operation(s). */
export function decide(policyName, w, log, ops, tick) {
  const learning = learningFrom(log);
  if (policyName === 'v6') {
    const pick = v6Policy().plan(w.clone(), log, tick)[0];
    return pick ? { op: pick.opId, c: pick.c } : null;
  }
  const per = [];
  for (const op of ops) {
    const s = snapshotFor(w.observed(), op, log, learning), gaps = deriveGaps(s), cands = generateCandidates(s, gaps).filter(c => c.prerequisites_met);
    const external = cands.filter(c => TESTS[c.family].specialist !== 'main_local');
    if (!external.length) continue;
    if (policyName === 'cheapest') { const c = [...external].sort((a, b) => costUnits(a.bounds) - costUnits(b.bounds) || a.key.localeCompare(b.key))[0]; per.push({ op, c, utility: -costUnits(c.bounds) }); continue; }
    if (policyName === 'confirmation') { const c = [...external].sort((a,b) => (b.family==='RELATED_SITE_HUNT'?2:b.family==='PUBLIC_ARTIFACT_SEARCH'?1:0)-(a.family==='RELATED_SITE_HUNT'?2:a.family==='PUBLIC_ARTIFACT_SEARCH'?1:0)||a.key.localeCompare(b.key))[0]; per.push({op,c,utility:0});continue; }
    if (policyName === 'random') { const c = external[Number.parseInt(fnv(`${op}:${tick}:${log.length}`), 16) % external.length]; per.push({ op, c, utility: 0 }); continue; }
    const choice = policyName === 'v8' ? v8ScientificChoice(s,gaps,external,{seed:`${op}:${tick}`}) : policyName === 'v9' ? scientificChoice(s,gaps,external,{seed:`${op}:${tick}`}) : choose(s, gaps, external, { seed: `${op}:${tick}`, exploration: policyName === 'v7' });
    if (choice.chosen) per.push({ op, c: choice.chosen, utility: choice.chosen.utility, exploration: choice.exploration, components: choice.chosen.components, gap: gaps.find(g => g.key === choice.chosen.primary_gap) });
  }
  if (!per.length) return null;
  if (per.length === 1 || policyName === 'cheapest' || policyName === 'random' || policyName === 'confirmation') return per.sort((a, b) => b.utility - a.utility)[0];
  const order = portfolioOrder(per.map(p => ({ scope: p.op, utility: p.utility, time_sensitivity: p.components?.time_sensitivity.value ?? 0, report_closeness: p.components?.report_readiness.value ?? 0, contradiction: 0, new_wave: 0, provider_opportunity: 0, exploration: false, hours_since_service: 0, recent_share: 0, consecutive: 0, eligible: true })));
  return per.find(p => p.op === order[0].scope);
}

/** Evaluates one world scenario: every available safe test (for every competing op) is rolled out in a clone. */
export function evaluateWorldScenario(sc, seed, policies) {
  const { world, log, ops, note } = sc.build(seed), tick = world.s.tick;
  const continuation = v7Policy({ exploration: false });
  const alts = [];
  for (const op of ops) {
    const s = snapshotFor(world.observed(), op, log, learningFrom(log)), gaps = deriveGaps(s);
    for (const c of generateCandidates(s, gaps)) if (c.prerequisites_met && TESTS[c.family].specialist !== 'main_local') alts.push({ op, c, v: counterfactual(world, log, continuation, op, c, tick, 3) });
  }
  const best = Math.max(...alts.map(a => a.v));
  const out = { type: sc.type, seed, note, alternatives: alts.map(a => ({ op: a.op, test: a.c.family, subject: a.c.subject, value: Math.round(a.v * 1000) / 1000 })), best: Math.round(best * 1000) / 1000, policies: {} };
  for (const p of policies) {
    const d = decide(p, world, log, ops, tick);
    if (!d) { out.policies[p] = { choice: null, value: 0, regret: Math.round(best * 1000) / 1000, optimal: best <= 0 }; continue; }
    const known = alts.find(a => a.op === d.op && a.c.family === d.c.family && a.c.subject === d.c.subject && (a.c.inputs_hash === d.c.inputs_hash || d.c.inputs_hash == null));
    const v = known ? known.v : counterfactual(world, log, continuation, d.op, d.c, tick, 3);
    out.policies[p] = { choice: `${d.op}:${d.c.family}:${d.c.subject}`, value: Math.round(v * 1000) / 1000, regret: Math.round(Math.max(0, best - v) * 1000) / 1000, optimal: v >= best - 1e-9, near_optimal: v >= best - .05, exploration: Boolean(d.exploration) };
  }
  return out;
}

export function evaluateTableScenario(sc) {
  const best = Math.max(...Object.values(sc.truth));
  const v7 = rankDirectorActions(sc.ctx, sc.actions, {}).valued[0]?.action;
  const v5 = [...sc.actions].sort((a, b) => b.value / b.cost - a.value / a.cost)[0];
  const cheapest = [...sc.actions].sort((a, b) => a.cost - b.cost)[0];
  const score = a => ({ choice: a.kind, value: sc.truth[a.kind], regret: Math.round((best - sc.truth[a.kind]) * 1000) / 1000, optimal: sc.truth[a.kind] >= best - 1e-9, near_optimal: sc.truth[a.kind] >= best - .05 });
  return { type: sc.type, truth: sc.truth, policies: { 'v7-exploit': score(v7), v7: score(v7), v9: {...score(v7),note:'v9 keeps the investigation Director value function'}, v8: {...score(v7),note:'v8 preserves the v7 investigation Director for these cases'}, v6: { ...score(v5), note: 'v5 Director value/cost order (v6 kept it)' }, cheapest: score(cheapest), confirmation: {...score(v5),note:'Existing value/cost Director for table cases'}, random: score(sc.actions[Number.parseInt(fnv(sc.type), 16) % sc.actions.length]) } };
}

export { netValue };
