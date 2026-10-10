/**
 * v7 offline decision benchmark harness.
 *
 *  - adapter: builds the PRODUCTION snapshot type from `world.observed()` only (never from truth)
 *  - policies: v7 (production lib/adaptive code), v6 operation policy (faithful re-statement), random, cheapest
 *  - counterfactual: for every decision, every available alternative is executed in a cloned world and
 *    scored with benchmark truth — OFFLINE ONLY, never visible to the policy.
 */
import { deriveGaps, generateCandidates, fnv } from '../lib/adaptive/derive.ts';
import { choose, valueCandidate, POLICY } from '../lib/adaptive/value.ts';
import { portfolioOrder, budgetAdjustment, creditShares, BUDGET } from '../lib/adaptive/policy.ts';
import { TESTS } from '../lib/adaptive/ontology.ts';
import { netValue } from './world.mjs';

// ----------------------------------------------------------------------------------- adapter
export function snapshotFor(ob, opId, log, learning) {
  const op = ob.ops[opId], mine = Object.values(ob.sites).filter(x => x.op === opId);
  const inspected = mine.filter(x => x.inspected && x.artifacts);
  const count = (f) => { const m = new Map(); for (const x of inspected) { const v = f(x); if (v) m.set(v, (m.get(v) ?? 0) + 1); } return m; };
  const contacts = count(x => x.artifacts.contact), analytics = count(x => x.artifacts.analytics), kits = count(x => x.artifacts.kit);
  const sites = mine.map(x => {
    const shared = (x.artifacts ? (contacts.get(x.artifacts.contact) ?? 0) > 1 ? 1 : 0 : 0) + (x.artifacts?.analytics && (analytics.get(x.artifacts.analytics) ?? 0) > 1 ? 1 : 0)
      + x.deposit.filter(a => (ob.wallets[a]?.deposit_sites.length ?? 0) > 1).length;
    return { key: x.key, entity_id: x.key, investigation_id: `inv:${x.key}`, association: x.key === op.seed ? 'seed' : 'proposed', inspected: Boolean(x.inspected && x.artifacts), inspection_failures: x.failed ? 2 : 0,
      inspection_running: ob.pipeline.includes(x.key), payment_seen: x.deposit.length > 0 || x.history.length > 0, deposit_seen: x.deposit.length > 0, wallet_page_rechecked: log.some(t => t.op === opId && t.family === 'LIKELY_WALLET_PAGE_INSPECTION' && t.subject === `site:${x.key}`),
      status: x.status, changed_since_inspection: Boolean(x.monitor_changed), human_barrier: Boolean(x.login), strong_units: shared, weak_units: x.artifacts ? 2 : 0, timing_known: true,
      report: x.deposit.length ? { exists: true, ready: x.deposit.some(a => ob.wallets[a]?.analysis === 'completed'), destination: true, blockers: [] } : null };
  });
  const wallets = Object.values(ob.wallets).filter(w => w.deposit_sites.some(k => ob.sites[k]?.op === opId)).map(w => ({ id: w.address, identity: w.address, address: w.address, network: 'ethereum', context: 'deposit',
    validation: w.validated ? 'valid' : 'pending', analysis: w.analysis, investigation_id: `inv:${w.deposit_sites[0]}`, site_key: w.deposit_sites[0], validated_sites: w.validated ? w.deposit_sites.length : 0,
    provider: w.analysis === 'partial' ? 'unavailable' : 'healthy', provider_ready: false, owned_by_director: true, reuse_reviewed: w.reviewed, reuse_searched: ob.finder[opId].artifacts.includes(w.address) }));
  const artifacts = [];
  for (const [v, n] of contacts) artifacts.push({ kind: 'contact', value: v, sites: n, distinctive: true, searched: ob.finder[opId].artifacts.includes(v), site_key: inspected.find(x => x.artifacts.contact === v)?.key ?? null });
  for (const [v, n] of analytics) artifacts.push({ kind: 'analytics', value: v, sites: n, distinctive: true, searched: ob.finder[opId].artifacts.includes(v), site_key: inspected.find(x => x.artifacts.analytics === v)?.key ?? null });
  for (const [v, n] of count(x => x.artifacts.title)) artifacts.push({ kind: 'title', value: v, sites: n, distinctive: false, searched: ob.finder[opId].artifacts.includes(v), site_key: null });
  const questions = [];
  if (op.hunter.runs > 0 || inspected.length >= 2) {
    questions.push({ key: 'who', question: 'Are the member sites run by one operator?', kind: 'linkage', alternatives: [{ key: 'one', label: 'One operator runs these sites', status: 'open' }, { key: 'customers', label: 'Several customers of the same kit vendor', status: op.hunter.linkage === 'discriminated' ? 'challenged' : 'open' }] });
    questions.push({ key: 'activity', question: 'Is the operation still running?', kind: 'activity', alternatives: [{ key: 'active', label: 'Still running on the known sites', status: 'open' }, { key: 'moved', label: 'Moving to new infrastructure', status: op.hunter.activity === 'open' ? 'open' : 'challenged' }] });
  }
  const contradictions = op.hunter.contradiction === 'open' ? [{ fingerprint: `split:${opId}`, summary: 'Two support contacts present the same deposit wallet.', kind: 'inconsistent_indicator', status: 'open', new_evidence_since_hunter: op.evidence_units > op.hunter.evidence_at_last_run }] : [];
  const history = log.filter(t => t.op === opId).map(t => ({ family: t.family, subject: t.subject, inputs_hash: t.inputs_hash, status: t.done ? 'finished' : 'running', useful: t.done ? t.useful : null, dead: t.done && !t.useful, duplicate: Boolean(t.duplicate) }));
  const st = op.state ?? { hunts: 0, bonus: 0 };
  return {
    scope: { kind: 'operation', id: opId, label: opId, seed: op.seed, investigation_id: `inv:${op.seed}` }, now: new Date(Date.UTC(2026, 9, 1) + ob.tick * 3600000).toISOString(),
    sites, wallets, artifacts, questions, contradictions,
    units: { template_similarity: Math.max(0, (kits.get([...kits.keys()][0]) ?? 0) - 1), infrastructure_context: Math.max(0, inspected.length - 1), public_contact: [...contacts.values()].filter(n => n > 1).length, wallet_observation: wallets.length, validated_wallet_reuse: wallets.filter(w => w.validated_sites > 1).length },
    waves: { count: op.waves ?? 0, newest_unhunted: Boolean(op.hunter.wave_flag) && !log.some(t => t.op === opId && t.mode === 'wave') },
    hunter: { present: true, evidence_since_last_analysis: op.evidence_units - op.hunter.evidence_at_last_run },
    history, learning, budget: { remaining: BUDGET.base + st.bonus - st.hunts, max: BUDGET.base + st.bonus },
    finder_sent: { seeds: ob.finder[opId].seeds.map(x => x.toLowerCase()), artifacts: ob.finder[opId].artifacts.map(x => String(x).toLowerCase()) },
  };
}

/** Same decayed-family statistics as lib/adaptive/snapshot.ts#familyLearning, from the policy's own outcome log. */
export function learningFrom(log) {
  const out = {};
  for (const t of log.filter(t => t.done)) {
    const l = out[t.family] ??= { n: 0, useful: 0, validated_site: 0, validated_wallet: 0, independent: 0, discrimination: 0, report: 0, contradiction: 0, dead: 0, duplicate: 0, generic: 0, measured_n: 0, cost_mean: null };
    l.n += 1; const o = t.outcomes ?? {};
    l.validated_site += Math.min(1, o.site ?? 0); l.validated_wallet += Math.min(1, o.wallet ?? 0); l.independent += Math.min(1, (o.site ?? 0) + (o.wallet ?? 0));
    l.discrimination += Math.min(1, o.linkage ?? 0); l.report += Math.min(1, o.report ?? 0); l.contradiction += Math.min(1, o.contradiction ?? 0);
    l.dead += t.useful ? 0 : 1; l.duplicate += t.duplicate ? 1 : 0; l.useful += t.useful ? 1 : 0;
    l.cost_mean = ((l.cost_mean ?? 0) * l.measured_n + (t.requests ?? 0)) / (l.measured_n + 1); l.measured_n += 1;
  }
  return out;
}

// ----------------------------------------------------------------------------------- execution
export function execute(world, opId, c) {
  const before = world.s.observed.requests, o = c.objective ?? {};
  let r = {};
  switch (c.family) {
    case 'RELATED_SITE_HUNT': case 'PUBLIC_ARTIFACT_SEARCH': case 'REPLACEMENT_SITE_HUNT':
      r = world.finder(opId, { seeds: o.seeds ?? [world.s.observed.ops[opId].seed], artifacts: o.artifacts ?? [], mode: c.family === 'REPLACEMENT_SITE_HUNT' ? 'replacement' : o.mode === 'template_variant' ? 'template_variant' : o.mode === 'wave' ? 'wave' : 'related' }); break;
    case 'HUNTER_HYPOTHESIS_TEST': r = world.hunter(opId); break;
    case 'PUBLIC_SITE_INSPECTION': case 'LIKELY_WALLET_PAGE_INSPECTION': r = world.inspect(o.site); break;
    case 'TEMPORAL_RECHECK': r = world.recheck(o.site); break;
    case 'CORRELATION_REVIEW': r = o.wallet ? world.correlation(o.wallet) : {}; break;
    default: r = {}; break;
  }
  return { ...r, requests: world.s.observed.requests - before };
}

const scoreDelta = (a, b) => ({ site: b.hidden_sites_discovered - a.hidden_sites_discovered, wallet: b.validated_true_wallets - a.validated_true_wallets, linkage: b.linkage_discriminated - a.linkage_discriminated,
  contradiction: b.contradictions_resolved - a.contradictions_resolved, report: b.reports_ready - a.reports_ready, false_rel: b.false_relationships - a.false_relationships });

/** Applies one started test with the same bookkeeping every policy gets (allowances, empty runs, bounded budgets). */
export function apply(world, log, opId, c, tick, exploration = false) {
  const before = world.score(), r = execute(world, opId, c), after = world.score(), d = scoreDelta(before, after);
  const useful = d.site > 0 || d.wallet > 0 || d.linkage > 0 || d.contradiction > 0 || d.report > 0 || (r.found?.length ?? 0) > 0 || Boolean(r.changed);
  const op = world.s.observed.ops[opId];
  if (op.state) { op.state.hunts += 1; op.state.last = tick; for (const o of Object.values(world.s.observed.ops)) if (o.state) o.state.consecutive = o === op ? o.state.consecutive + 1 : 0; }
  if (op.v6) { op.v6.hunts += 1; op.v6.last = tick; op.v6.empty = useful ? 0 : op.v6.empty + 1; }
  if (op.rstate) op.rstate.hunts += 1;
  const entry = { op: opId, family: c.family, subject: c.subject, inputs_hash: c.inputs_hash, mode: c.objective?.mode, done: false, useful, duplicate: (r.found?.length ?? 1) === 0 && !d.linkage && !r.changed, requests: r.requests, tick, outcomes: d, exploration: Boolean(exploration) };
  log.push(entry);
  if (op.state) {
    const recent = log.filter(t => t.op === opId && !t.local).slice(-4).map(t => ({ useful: t.useful, independent: (t.outcomes.site ?? 0) + (t.outcomes.wallet ?? 0) + (t.outcomes.linkage ?? 0) > 0, duplicate: t.duplicate, dead: !t.useful }));
    const adj = budgetAdjustment({ max_hunts: BUDGET.base + op.state.bonus, hunts: op.state.hunts, bonus: op.state.bonus }, recent);
    op.state.bonus = Math.max(-(BUDGET.base - Math.max(BUDGET.min_allowance_floor, op.state.hunts)), Math.min(BUDGET.max_bonus, op.state.bonus + adj.delta));
    if (adj.delta) (op.state.adjustments ??= []).push({ tick, delta: adj.delta, reason: adj.reason });
  }
  return entry;
}

/** One full tick of a policy (shared pipeline, then the policy's starts). */
export function tickOnce(world, policy, log, tick) {
  world.pipeline();
  for (const t of log.filter(t => !t.done)) t.done = true; // tests take one tick
  const starts = policy.plan(world, log, tick);
  for (const st of starts) apply(world, log, st.opId, st.c, tick, st.exploration);
  world.advance();
  return starts;
}

/** Counterfactual value of one alternative: run it in a cloned world, then let the SAME policy continue for
 *  `horizon` more ticks (rollout), then let the shared pipeline finish. Scored with benchmark truth. */
export const GAMMA = .6;
export function counterfactual(world, log, policy, opId, c, tick, horizon = 3) {
  // Discounted rollout: value realised sooner counts more (gamma per tick), so ORDER matters, not just the set.
  const w = world.clone(), l = structuredClone(log);
  let prev = w.score(), total = 0;
  apply(w, l, opId, c, tick); w.pipeline(); w.walletPipeline();
  let now = w.score(); total += netValue(prev, now); prev = now; w.advance();
  for (let k = 1; k <= horizon; k++) { tickOnce(w, policy, l, tick + k); w.walletPipeline(); now = w.score(); total += Math.pow(GAMMA, k) * netValue(prev, now); prev = now; }
  return total;
}

// ----------------------------------------------------------------------------------- policies
export const v7Policy = (opts = {}) => ({
  name: opts.name??(opts.exploration === false ? 'v7 (exploitation only)' : 'v7 adaptive'),
  plan(world, log, tick) {
    const ob = world.observed(), learning = learningFrom(log), pending = [];
    for (const opId of Object.keys(ob.ops)) {
      const op = world.s.observed.ops[opId]; op.state ??= { hunts: 0, bonus: 0, consecutive: 0, last: -99, parked: null };
      if (log.some(t => t.op === opId && !t.done && TESTS[t.family].specialist !== 'main_local')) continue;
      for (let round = 0; round < 4; round++) {
        const s = snapshotFor(world.observed(), opId, log, learning);
        const gaps = deriveGaps(s), cands = generateCandidates(s, gaps);
        const choice = (opts.choose??choose)(s, gaps, cands, { seed: `${opId}:${tick}:${round}`, exploration: opts.exploration });
        if (!choice.chosen) { op.state.parked = choice.stop; break; }
        const c = choice.chosen;
        if (TESTS[c.family].specialist === 'main_local') { const r = execute(world, opId, c); log.push({ op: opId, family: c.family, subject: c.subject, inputs_hash: c.inputs_hash, done: true, useful: Boolean(r.reuse), requests: 0, tick, outcomes: r.reuse ? { linkage: 1 } : {}, local: true }); continue; }
        if (op.state.hunts >= BUDGET.base + op.state.bonus) { op.state.parked = { state: 'exhausted', reason: 'budget' }; break; }
        pending.push({ opId, c, choice, gaps, s }); break;
      }
    }
    const order = portfolioOrder(pending.map(p => ({ scope: p.opId, utility: p.c.utility, time_sensitivity: p.c.components.time_sensitivity.value, report_closeness: p.c.components.report_readiness.value,
      contradiction: p.gaps.find(g => g.key === p.c.primary_gap)?.family === 'CONTRADICTION_RESOLUTION' ? 1 : 0, new_wave: p.gaps.find(g => g.key === p.c.primary_gap)?.family === 'CAMPAIGN_WAVE' ? 1 : 0, provider_opportunity: 0, exploration: p.choice.exploration,
      hours_since_service: tick - world.s.observed.ops[p.opId].state.last, recent_share: 0, consecutive: world.s.observed.ops[p.opId].state.consecutive, eligible: true })));
    return order.slice(0, 2).map(e => { const p = pending.find(x => x.opId === e.scope); return { opId: p.opId, c: p.c, exploration: p.choice.exploration, alternatives: p.choice.ranked.filter(v => v.eligible),
      ranked: p.choice.ranked.slice(0, 6).map(v => ({ family: v.family, subject: v.subject, utility: v.utility, eligible: v.eligible, gap: v.primary_gap, dup: v.components.duplicate_probability.value, sat: v.components.saturation.value, disc: v.components.hypothesis_discrimination.value })) }; });
  },
});

/** Faithful re-statement of v6 operationIntelligenceTick's hunt policy (lib/ops/intelligence.ts in the v6 release). */
export const v6Policy = () => ({
  name: 'v6 operation policy',
  plan(world, log, tick) {
    const ob = world.s.observed, starts = [];
    const ops = Object.keys(ob.ops).sort((a, b) => (ob.ops[a].v6?.last ?? -99) - (ob.ops[b].v6?.last ?? -99) || a.localeCompare(b));
    for (const opId of ops) {
      const op = ob.ops[opId], st = op.v6 ??= { hunts: 0, empty: 0, last: -99, consumed: [] };
      if (starts.length >= 2 || st.hunts >= BUDGET.base) continue;
      if (log.some(t => t.op === opId && !t.done)) continue;
      const semantic = `${op.evidence_units}:${op.hunter.contradiction}:${Object.values(ob.sites).filter(x => x.op === opId).length}`;
      if (st.empty >= 3 && st.consumed.includes(semantic)) continue;
      const contradictory = op.hunter.contradiction === 'open';
      const family = contradictory && st.hunts > 0 ? 'HUNTER_HYPOTHESIS_TEST' : 'RELATED_SITE_HUNT';
      if (st.consumed.includes(`${family}:${semantic}`)) continue;
      st.consumed.push(`${family}:${semantic}`, semantic);
      starts.push({ opId, c: { family, subject: family === 'RELATED_SITE_HUNT' ? `scope:${opId}` : `hunter:${opId}`, inputs_hash: semantic, objective: { seeds: [op.seed], artifacts: [] } } });
    }
    return starts;
  },
});

export const randomPolicy = (seed = 7) => ({
  name: 'random eligible test',
  plan(world, log, tick) {
    const out = [];
    for (const opId of Object.keys(world.s.observed.ops)) {
      if (out.length >= 2 || log.some(t => t.op === opId && !t.done)) continue;
      const op = world.s.observed.ops[opId]; op.rstate ??= { hunts: 0 };
      if (op.rstate.hunts >= BUDGET.base) continue;
      const s = snapshotFor(world.observed(), opId, log, {}), gaps = deriveGaps(s), cands = generateCandidates(s, gaps).filter(c => c.prerequisites_met && TESTS[c.family].specialist !== 'main_local');
      if (!cands.length) continue;
      const pick = cands[Number.parseInt(fnv(`${seed}:${opId}:${tick}`), 16) % cands.length];
      out.push({ opId, c: pick });
    }
    return out;
  },
});

// ----------------------------------------------------------------------------------- runner
export function run(world, policy, { ticks = 16, counterfactuals = true, horizon = 3, tolerance = .05, requestBudget = null } = {}) {
  const log = [], decisions = [], curve = [];
  const lastServed = {}, waits = {};
  for (let tick = 0; tick < ticks; tick++) {
    world.pipeline();
    for (const t of log.filter(t => !t.done)) t.done = true;
    // Equal-budget comparisons: once a policy has spent its request budget it starts nothing new.
    const starts = requestBudget != null && world.s.observed.requests >= requestBudget ? [] : policy.plan(world, log, tick);
    for (const st of starts) {
      if (counterfactuals) {
        const alts = new Map();
        const s = snapshotFor(world.observed(), st.opId, log, {}), gaps = deriveGaps(s);
        for (const c of generateCandidates(s, gaps)) if (c.prerequisites_met && TESTS[c.family].specialist !== 'main_local') alts.set(c.key, c);
        alts.set(st.c.key ?? `${st.c.family}:${st.c.subject}:chosen`, st.c);
        // Every policy is scored against the same kind of alternative set: all safe tests available for that operation.
        const values = [...alts.values()].map(a => ({ key: a.key ?? `${a.family}:${a.subject}`, family: a.family, v: counterfactual(world, log, policy, st.opId, a, tick, horizon) }));
        const mine = counterfactual(world, log, policy, st.opId, st.c, tick, horizon), best = Math.max(mine, ...values.map(x => x.v));
        const regret = Math.max(0, best - mine);
        decisions.push({ tick, op: st.opId, chose: st.c.family, ranked: st.ranked, alt_values: values.map(v => ({ ...v, v: Math.round(v.v * 1000) / 1000 })), value: Math.round(mine * 1000) / 1000, best: Math.round(best * 1000) / 1000,
          regret: Math.round(regret * 1000) / 1000, optimal: mine >= best - 1e-9, near_optimal: mine >= best - tolerance, alternatives: values.length, exploration: Boolean(st.exploration) });
      }
      apply(world, log, st.opId, st.c, tick, st.exploration);
      lastServed[st.opId] = tick;
    }
    for (const opId of Object.keys(world.s.observed.ops)) { if (lastServed[opId] === tick) { waits[opId] = 0; continue; } waits[opId] = (waits[opId] ?? 0) + 1; }
    world.advance();
    const sc = world.score(); curve.push({ tick, requests: sc.requests, sites: sc.hidden_sites_discovered, wallets: sc.validated_true_wallets, reports: sc.reports_ready });
  }
  for (let i = 0; i < 2; i++) world.pipeline();
  const score = world.score();
  const ext = log.filter(t => !t.local);
  const runaway = (() => { let max = 0, cur = 0, prev = ''; for (const t of ext) { const k = `${t.op}:${t.family}:${t.subject}`; cur = k === prev && !t.useful ? cur + 1 : 1; prev = k; max = Math.max(max, cur); } return max; })();
  const useful = ext.filter(t => t.useful).length, totalRequests = score.requests;
  const expl = ext.filter(t => t.exploration);
  return {
    policy: policy.name, ...score, actions: ext.length, local_reviews: log.filter(t => t.local).length, useful_actions: useful, useful_rate: ext.length ? Math.round(useful / ext.length * 1000) / 1000 : 0,
    independent_evidence_per_100_requests: Math.round((score.hidden_sites_discovered + score.validated_true_wallets + score.linkage_discriminated) / Math.max(1, totalRequests) * 100000) / 1000,
    requests_per_hidden_site: score.hidden_sites_discovered ? Math.round(totalRequests / score.hidden_sites_discovered * 10) / 10 : null,
    wasted_actions: ext.length - useful, max_consecutive_wait_ticks: Math.max(0, ...Object.values(waits)), runaway_max_repeat: runaway,
    exploration: { starts: expl.length, useful: expl.filter(t => t.useful).length },
    decision_quality: decisions.length ? { decisions: decisions.length, optimal_rate: Math.round(decisions.filter(d => d.optimal).length / decisions.length * 1000) / 1000, near_optimal_rate: Math.round(decisions.filter(d => d.near_optimal).length / decisions.length * 1000) / 1000,
      mean_regret: Math.round(decisions.reduce((x, d) => x + d.regret, 0) / decisions.length * 1000) / 1000, total_regret: Math.round(decisions.reduce((x, d) => x + d.regret, 0) * 1000) / 1000 } : null,
    budget_adjustments: Object.values(world.s.observed.ops).flatMap(o => (o.state?.adjustments ?? []).map(a => ({ op: o.id, ...a }))),
    curve, decisions,
  };
}

export { creditShares, valueCandidate, POLICY };
