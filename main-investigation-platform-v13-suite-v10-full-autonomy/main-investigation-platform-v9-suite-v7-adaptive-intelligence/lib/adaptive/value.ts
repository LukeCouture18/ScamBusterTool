/**
 * v7: explainable, bounded information-value model.
 *
 * Every candidate test receives named components in [0,1]. Benefit is a fixed weighted sum of
 * positive components; saturation and duplicate probability discount it multiplicatively; cost
 * divides it. There is no learned opaque score: learning only supplies one named component
 * (historical yield) and, after enough measured observations, the cost estimate.
 *
 * Learning metadata and these values are prioritization metadata. They are never evidence and
 * never appear in reports.
 */
import { TESTS, dependents, type EvidenceClass, type TestFamily, type ResourceBounds, type GapFamily } from './ontology';
import type { Candidate, Gap, Snapshot, FamilyLearning } from './derive';

export const COMPONENTS = ['uncertainty_reduction', 'hypothesis_discrimination', 'report_readiness', 'time_sensitivity', 'downstream_opportunity',
  'evidence_independence', 'novelty', 'operation_coverage', 'historical_yield', 'saturation', 'duplicate_probability', 'cost'] as const;
export type Component = (typeof COMPONENTS)[number];
/** CORE value: what the test can actually tell us or unlock. Weights sum to 1. */
export const WEIGHTS: Record<'uncertainty_reduction' | 'hypothesis_discrimination' | 'report_readiness' | 'downstream_opportunity' | 'evidence_independence', number> = {
  uncertainty_reduction: .28, hypothesis_discrimination: .25, report_readiness: .2, downstream_opportunity: .13, evidence_independence: .14,
};
/** CONTEXT modifiers scale core value; they cannot create value for a test that answers nothing.
 *  modifier = (0.6 + 0.4 novelty) x (0.75 + 0.5 historical yield) x (0.7 + 0.3 coverage) x (1 + 0.5 time sensitivity). */
export const MODIFIERS = { novelty: [.6, .4], historical_yield: [.75, .5], operation_coverage: [.7, .3], time_sensitivity: [1, .5] } as const;
/** Saturation, duplicate probability and cost are discounts, not weights. */
/** cost_bias is the opportunity cost of a decision slot (even a free local read uses one turn);
 *  completion_priority multiplies value for tests that unblock a report (completed investigations). */
export const POLICY = { benefit_floor: .06, utility_floor: .15, exploration_rate: .15, min_learning_observations: 3, cost_bias: .35, completion_priority: .5 };
/** utility = adjusted benefit x (1 + completion_priority x report readiness) / (cost_bias + normalized cost). */
export const utilityOf = (adjusted: number, report: number, units: number) => adjusted * (1 + POLICY.completion_priority * report) / (POLICY.cost_bias + costNorm(units));

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** P(evidence observed | shared operation), P(evidence observed | shared kit or unrelated). Fixed, documented priors. */
export const DIAGNOSTICITY: Record<EvidenceClass, [number, number]> = {
  template_similarity: [.95, .9], infrastructure_context: [.7, .55], certificate_overlap: [.4, .15], public_contact: [.55, .06],
  public_artifact: [.5, .05], wallet_observation: [.45, .1], validated_wallet_reuse: [.6, .02], blockchain_relationship: [.35, .25],
  site_observation: [.5, .4], temporal_observation: [.45, .35], hunter_reanalysis: [.5, .5],
  // Hunter re-analysis after new evidence plus its own bounded passive pursuit (DNS/CT/RDAP): modest, generic power.
  hunter_pursuit: [.5, .35],
};
/** For "is it still running / did it move" questions: what separates active-or-moving from dormant-or-ended. */
export const ACTIVITY_DIAGNOSTICITY: Partial<Record<EvidenceClass, [number, number]>> = {
  temporal_observation: [.8, .25], site_observation: [.55, .15], public_artifact: [.45, .12], public_contact: [.45, .12], validated_wallet_reuse: [.35, .1],
  blockchain_relationship: [.6, .3], template_similarity: [.4, .3], infrastructure_context: [.4, .35], wallet_observation: [.45, .3], hunter_reanalysis: [.5, .5], hunter_pursuit: [.55, .35],
};
/** Marginal value of the next independent unit: base * decay^(units already known in that category). */
export const MARGINAL: Record<string, [number, number]> = {
  template_similarity: [.08, .3], infrastructure_context: [.08, .3], certificate_overlap: [.35, .5], public_contact: [.7, .5], public_artifact: [.7, .5],
  wallet_observation: [.85, .6], validated_wallet_reuse: [.9, .6], blockchain_relationship: [.45, .5], site_observation: [.6, .7], temporal_observation: [.4, .5], hunter_reanalysis: [.3, .5], hunter_pursuit: [.35, .5],
};

const H = (p: number) => (p <= 0 || p >= 1) ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
/** Expected entropy reduction (bits) on a binary hypothesis pair from observing/not observing one evidence class. */
export function expectedInformationGain(prior: number, pA: number, pB: number) {
  const p = clamp(prior, .01, .99), pe = p * pA + (1 - p) * pB;
  if (pe <= 0 || pe >= 1) return 0;
  const postE = (p * pA) / pe, postN = (p * (1 - pA)) / (1 - pe);
  return Math.max(0, H(p) - pe * H(postE) - (1 - pe) * H(postN));
}

/** The evidence class a candidate would contribute to the gap's question. */
export function probeClass(c: Candidate, s: Snapshot): EvidenceClass {
  const art = c.objective.artifacts?.[0];
  if (c.family === 'PUBLIC_ARTIFACT_SEARCH') return art?.kind === 'wallet' ? 'validated_wallet_reuse' : art?.kind === 'contact' ? 'public_contact' : art?.kind === 'ns' ? 'infrastructure_context' : art?.kind === 'title' || art?.kind === 'template' ? 'template_similarity' : 'public_artifact';
  if (c.family === 'CORRELATION_REVIEW') return c.subject.startsWith('wallet:') ? 'validated_wallet_reuse' : 'infrastructure_context';
  if (c.family === 'HUNTER_HYPOTHESIS_TEST') return s.hunter.evidence_since_last_analysis > 0 ? 'hunter_pursuit' : 'hunter_reanalysis';
  if (c.family === 'RELATED_SITE_HUNT') return c.objective.artifacts?.length ? 'site_observation' : 'template_similarity';
  if (c.family === 'PUBLIC_SITE_INSPECTION') return 'wallet_observation';
  if (c.family === 'BLOCKCHAIN_REFRESH') return 'blockchain_relationship';
  return TESTS[c.family].produces[0];
}

/** Scalar effort units used only to compare candidates. Measured means replace bounds after enough observations. */
export function costUnits(b: ResourceBounds) { return b.jobs * 5 + b.http + b.dns * .25 + b.certificate * 2 + b.rdap * 2 + b.provider_calls * 3 + b.effort_seconds / 60; }
export const costNorm = (units: number) => units / (units + 60);

const OUTCOME_OF: Partial<Record<GapFamily, keyof FamilyLearning>> = {
  RELATED_SITE: 'validated_site', REPLACEMENT_SITE: 'validated_site', CAMPAIGN_WAVE: 'validated_site', SITE_IDENTITY: 'independent',
  PAYMENT_INTERFACE: 'validated_wallet', DEPOSIT_WALLET: 'validated_wallet', WALLET_VALIDATION: 'validated_wallet', WALLET_REUSE: 'discrimination',
  PUBLIC_ARTIFACT_REUSE: 'discrimination', CONTACT_REUSE: 'discrimination', HYPOTHESIS_DISCRIMINATION: 'discrimination', OPERATION_MEMBERSHIP: 'independent',
  CONTRADICTION_RESOLUTION: 'contradiction', BLOCKCHAIN_ACTIVITY: 'report', REPORT_EVIDENCE: 'report', TEMPLATE_SPECIFICITY: 'independent', INFRASTRUCTURE_SPECIFICITY: 'independent',
};

export type Valued = Candidate & {
  primary_gap: string; components: Record<Component, { value: number; weight: number; contribution: number; reason: string }>;
  benefit: number; adjusted: number; cost_units: number; utility: number; eligible: boolean; ineligible_reason?: string; probe: EvidenceClass;
};

function historical(family: TestFamily, gapFamily: GapFamily, learning: Snapshot['learning']) {
  const l = learning[family];
  const metric = OUTCOME_OF[gapFamily] ?? 'useful';
  if (!l || l.n < POLICY.min_learning_observations) return { value: .5, reason: `Fewer than ${POLICY.min_learning_observations} recorded outcomes for ${family}; neutral prior.` };
  const hits = Number(l[metric] ?? 0);
  return { value: clamp((hits + 1) / (l.n + 2)), reason: `${r3(hits)} of ${r3(l.n)} decayed ${family} outcomes produced ${String(metric).replace(/_/g, ' ')}.` };
}

/** Values one candidate against the gap it answers best. */
export function valueCandidate(c: Candidate, s: Snapshot, gaps: Map<string, Gap>): Valued {
  const spec = TESTS[c.family], probe = probeClass(c, s);
  const history = s.history.filter(h => h.family === c.family && h.subject === c.subject);
  const sameInputs = history.filter(h => h.inputs_hash === c.inputs_hash);
  const finished = history.filter(h => h.status === 'finished');
  let consecutiveEmpty = 0; for (const h of [...finished].reverse()) { if (h.useful) break; consecutiveEmpty++; }
  const familyFinished = s.history.filter(h => h.family === c.family && h.status === 'finished');
  let branchEmpty = 0; for (const h of [...familyFinished].reverse()) { if (h.useful) break; branchEmpty++; }
  const subjectTries = s.history.filter(h => h.subject === c.subject).length;
  const learned = s.learning[c.family];
  const units = learned && learned.measured_n >= POLICY.min_learning_observations && learned.cost_mean != null ? learned.cost_mean : costUnits(c.bounds);
  let best: Valued | null = null;
  for (const key of c.gaps) {
    const g = gaps.get(key); if (!g) continue;
    // Re-asking Hunter about evidence it already analysed has little power (Hunter already weighed it).
    const stale = c.family === 'HUNTER_HYPOTHESIS_TEST' && s.hunter.evidence_since_last_analysis === 0;
    // Specialist capability prior: Finder can only join wallet/contact/analytics values against sites it has
    // already probed (local join); title/asset/host values can use public page search when configured.
    const art = c.objective.artifacts?.[0]?.kind;
    const route = c.family === 'PUBLIC_ARTIFACT_SEARCH' ? (['wallet', 'contact', 'analytics'].includes(String(art)) ? .5 : .7) : 1;
    // Expected reuse breadth for DISCOVERY: operator settings (contact, analytics) recur across deployments;
    // deposit wallets rotate per deployment; titles/templates are kit-level and also match other operators.
    const breadthOf = (k: string) => k === 'wallet' ? .6 : k === 'title' || k === 'template' ? .4 : 1;
    const breadth = c.family === 'PUBLIC_ARTIFACT_SEARCH' && ['RELATED_SITE', 'REPLACEMENT_SITE', 'CAMPAIGN_WAVE'].includes(g.family) ? breadthOf(String(art)) : 1;
    let power = (spec.answers[g.family] ?? 0) * (stale ? .25 : 1) * route * breadth;
    let powerReason = '';
    // Discovery power of a Site Finder request grows with the NEW inputs it carries: each fresh distinctive artifact
    // (p = .5 x reuse breadth) and each fresh seed (p = .3, link following) is an independent chance: 1 - prod(1 - p).
    if (spec.specialist === 'site_finder' && ['RELATED_SITE', 'REPLACEMENT_SITE', 'CAMPAIGN_WAVE'].includes(g.family) && s.finder_sent) {
      const sentSet = new Set([...(s.finder_sent.seeds ?? []), ...(s.finder_sent.artifacts ?? [])]);
      const replacementFresh = c.family === 'REPLACEMENT_SITE_HUNT' && !history.some(h => h.status === 'finished'); // the disappearance itself is the new input
      const isFresh = (v: string) => replacementFresh || (!sentSet.has(v.toLowerCase()) && !sentSet.has(v.toLowerCase().replace(/^(ga4|ua|gtm):/, '')));
      const ps = [...(c.family === 'PUBLIC_ARTIFACT_SEARCH' ? [] : (c.objective.seeds ?? []).filter(isFresh).map(() => .3)),
        ...(c.objective.artifacts ?? []).filter(a => isFresh(a.value) && (a.kind !== 'title' || c.objective.mode === 'template_variant')).map(a => .5 * breadthOf(a.kind) * (c.family === 'PUBLIC_ARTIFACT_SEARCH' ? 1 : .9))];
      const combined = 1 - ps.reduce((x, p) => x * (1 - p), 1);
      if (ps.length) { power = Math.max(power, combined); powerReason = ` (${ps.length} new input(s) to Site Finder; P(at least one hit) ${r3(combined)})`; }
      else { power = Math.min(power, .05); powerReason = ' (no input is new to Site Finder)'; }
    }
    // A kit/template-variant search also matches other operators' deployments: low precision for discovery.
    if (c.objective.mode === 'template_variant' && ['RELATED_SITE', 'REPLACEMENT_SITE', 'CAMPAIGN_WAVE'].includes(g.family)) { power *= .4; powerReason += ' (kit-level search: also matches other operators)'; }
    const comp = {} as Valued['components'];
    const set = (k: Component, value: number, reason: string) => { const w = (WEIGHTS as Record<string, number>)[k] ?? 0; comp[k] = { value: r3(clamp(value)), weight: w, contribution: r3(w * clamp(value)), reason }; };
    set('uncertainty_reduction', g.uncertainty * power, `Gap uncertainty ${r3(g.uncertainty)} × answer power ${r3(power)} for ${g.family}${powerReason}.`);
    if (g.discrimination || g.family === 'HYPOTHESIS_DISCRIMINATION' || g.family === 'OPERATION_MEMBERSHIP' || g.family === 'CONTRADICTION_RESOLUTION') {
      const kind = g.discrimination?.kind ?? 'linkage';
      const [pA, pB] = kind === 'activity' ? (ACTIVITY_DIAGNOSTICITY[probe] ?? [.5, .45]) : kind === 'other' ? (probe === 'hunter_reanalysis' ? [.5, .5] : [.5, .4]) : DIAGNOSTICITY[probe];
      const scale = c.family === 'CORRELATION_REVIEW' ? .6 : 1; // only Main's existing records can be reviewed
      const prior = g.discrimination?.prior ?? .5;
      const eig = expectedInformationGain(prior, pA * scale, pB * scale), frac = eig / Math.max(1e-9, H(clamp(prior, .01, .99)));
      set('hypothesis_discrimination', frac, `Expected ${r3(eig)} bits between "${g.discrimination?.a ?? 'shared operation'}" and "${g.discrimination?.b ?? 'shared kit / unrelated'}" from ${probe.replace(/_/g, ' ')} (P=${r3(pA * scale)} vs ${r3(pB * scale)}).`);
    } else set('hypothesis_discrimination', 0, 'This gap is not a competing-explanation question.');
    set('report_readiness', g.report_blocking * (power > 0 ? 1 : 0), g.report_blocking ? `Resolving it moves a site report toward readiness (blocking weight ${g.report_blocking}).` : 'No report is blocked on this gap.');
    set('time_sensitivity', g.time_sensitivity, g.time_sensitivity >= .7 ? 'The subject is disappearing or changing; evidence may be lost.' : 'No unusual time pressure.');
    // A newly discovered deployment opens its own investigation chain (identity -> payment -> wallet -> report).
    const discovery = ['RELATED_SITE', 'REPLACEMENT_SITE', 'CAMPAIGN_WAVE'].includes(g.family);
    const downstream = discovery ? dependents('SITE_IDENTITY').length : dependents(g.family).length;
    set('downstream_opportunity', Math.min(1, downstream / 4), discovery ? `A new deployment would open its own investigation chain (${downstream} dependent gap families through to a report).`
      : downstream ? `Unlocks ${downstream} dependent gap famil${downstream === 1 ? 'y' : 'ies'} (${dependents(g.family).slice(0, 3).join(', ')}).` : 'Nothing downstream depends on it.');
    // For a discovery question the evidence a Finder test contributes is a site observation, whatever its pivot.
    const unitClass: EvidenceClass = ['RELATED_SITE', 'REPLACEMENT_SITE', 'CAMPAIGN_WAVE'].includes(g.family) && spec.specialist === 'site_finder' ? 'site_observation' : probe;
    const [base, decay] = MARGINAL[unitClass] ?? [.3, .5];
    const known = unitClass === 'site_observation' ? Math.max(0, s.sites.length - 1) : s.units[probe] ?? (probe === 'validated_wallet_reuse' ? (s.units.wallet_observation ?? 0) : 0);
    if (stale) set('evidence_independence', 0, 'Hunter has already analysed every independent unit; re-analysis adds no new independent evidence.');
    else set('evidence_independence', base * Math.pow(decay, known), `Next ${unitClass.replace(/_/g, ' ')} unit is worth ${r3(base)}×${decay}^${known} (${known} independent unit(s) already known; copies of a known unit add nothing).`);
    set('novelty', Math.pow(.5, subjectTries), subjectTries ? `${subjectTries} earlier test(s) on this subject.` : 'Subject never tested.');
    set('operation_coverage', g.coverage, g.coverage < 1 ? `Covers 1 of ${Math.round(1 / g.coverage)} similar open subjects.` : 'Operation-wide question.');
    const hy = historical(c.family, g.family, s.learning); set('historical_yield', hy.value, hy.reason);
    // Saturation is evidence that THESE inputs are exhausted: fresh seeds/artifacts discount it proportionally.
    const finderTest = spec.specialist === 'site_finder' && s.finder_sent;
    const inputs = finderTest ? (c.family === 'PUBLIC_ARTIFACT_SEARCH' ? (c.objective.artifacts ?? []).map(a => a.value) : [...(c.objective.seeds ?? []), ...(c.objective.artifacts ?? []).map(a => a.value)]).map(x => String(x).toLowerCase()) : [];
    const sent = new Set([...(s.finder_sent?.seeds ?? []), ...(s.finder_sent?.artifacts ?? [])]);
    const fresh = inputs.filter(x => !sent.has(x) && !sent.has(x.replace(/^(ga4|ua|gtm):/, '')));
    const freshShare = inputs.length ? fresh.length / inputs.length : 0;
    const saturation = clamp((1 - Math.pow(.5, consecutiveEmpty) + (branchEmpty >= 3 ? .25 : 0)) * (finderTest ? 1 - freshShare : 1));
    comp.saturation = { value: r3(saturation), weight: 0, contribution: 0, reason: (consecutiveEmpty ? `${consecutiveEmpty} consecutive empty run(s) on this subject${branchEmpty >= 3 ? `; ${branchEmpty} empty ${c.family} runs in this scope` : ''}.` : branchEmpty >= 3 ? `${branchEmpty} consecutive empty ${c.family} runs in this scope.` : 'Not saturated.')
      + (finderTest && freshShare > 0 && (consecutiveEmpty || branchEmpty >= 3) ? ` Discounted: ${fresh.length} of ${inputs.length} input(s) are new to Site Finder.` : '') };
    // Site Finder keeps persistent pursuits: a request only adds work when it hands Finder something new
    // (for an artifact search the artifact IS the input; for hunts, seeds and artifacts both are).
    const inputDup = finderTest && inputs.length ? .85 * (1 - freshShare) : 0;
    const historyDup = finished.length && c.family.endsWith('HUNT') ? (1 - Math.pow(.6, finished.length)) * (finderTest ? 1 - freshShare : 1) : 0;
    const dup = clamp(Math.max(inputDup, sameInputs.some(h => h.status === 'finished') ? .9 : sameInputs.length ? .95 : stale ? .5 : historyDup));
    comp.duplicate_probability = { value: r3(dup), weight: 0, contribution: 0, reason: sameInputs.length ? 'The same test with the same inputs already ran or is running.' : stale ? 'No new independent evidence since Hunter last analysed this operation.'
      : inputDup >= .5 ? `${inputs.length - fresh.length} of ${inputs.length} seed/artifact input(s) were already handed to Site Finder by other requests.` : dup ? `${finished.length} earlier run(s) on this subject with different inputs.` : 'No earlier equivalent run.' };
    comp.cost = { value: r3(costNorm(units)), weight: 0, contribution: 0, reason: `${r3(units)} effort units (${learned && learned.measured_n >= POLICY.min_learning_observations && learned.cost_mean != null ? `measured mean of ${learned.measured_n} runs` : 'declared resource bounds'}).` };
    // Core value x context modifier. Modifier components carry their factor as `weight` (contribution 0).
    const modifier = (Object.entries(MODIFIERS) as Array<[keyof typeof MODIFIERS, readonly [number, number]]>).reduce((x, [k, [a, b]]) => { const f = a + b * (comp[k]?.value ?? 0); comp[k] = { ...comp[k], weight: r3(f), contribution: 0 }; return x * f; }, 1);
    for (const k of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) comp[k] = { ...comp[k], contribution: r3(comp[k].contribution * modifier) };
    const benefit = Object.keys(WEIGHTS).reduce((x, k) => x + comp[k as keyof typeof WEIGHTS].contribution, 0);
    const adjusted = benefit * (1 - saturation) * (1 - dup);
    const v: Valued = { ...c, primary_gap: g.key, components: comp, benefit: r3(benefit), adjusted: r3(adjusted), cost_units: r3(units), utility: r3(utilityOf(adjusted, comp.report_readiness.value, units)), eligible: true, probe };
    if (!best || v.utility > best.utility) best = v;
  }
  if (!best) throw new Error(`candidate ${c.key} answers no known gap`);
  // Several gaps answered by one test add a bounded bonus (never double-count the same gap).
  const others = c.gaps.filter(k => k !== best!.primary_gap).length;
  if (others) { best.adjusted = r3(Math.min(1, best.adjusted * (1 + .15 * Math.min(3, others)))); best.utility = r3(utilityOf(best.adjusted, best.components.report_readiness.value, best.cost_units)); }
  if (!c.prerequisites_met) { best.eligible = false; best.ineligible_reason = c.prerequisite ?? 'Prerequisites not met.'; }
  else if (best.adjusted < POLICY.benefit_floor) { best.eligible = false; best.ineligible_reason = `Marginal value ${best.adjusted} is below the ${POLICY.benefit_floor} floor.`; }
  return best;
}

export type Choice = { chosen: Valued | null; ranked: Valued[]; exploration: boolean; stop: null | { reason: string; state: 'temporarily_low_value' | 'exhausted' | 'waiting_for_evidence' | 'waiting_for_human' | 'waiting_for_provider' } };

/** Deterministic exploration draw: no randomness, replayable. */
export function explorationDraw(seed: string) { let h = 2166136261; for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return (h % 10000) / 10000; }

export function choose(s: Snapshot, gaps: Gap[], candidates: Candidate[], opts: { seed: string; exploration?: boolean; budgetRemaining?: number } = { seed: '' }): Choice {
  const map = new Map(gaps.map(g => [g.key, g] as const));
  const ranked = candidates.map(c => valueCandidate(c, s, map)).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.utility - a.utility || a.key.localeCompare(b.key));
  const eligible = ranked.filter(v => v.eligible && v.utility >= POLICY.utility_floor);
  if (!eligible.length) {
    const open = gaps.filter(g => !['resolved', 'exhausted'].includes(g.status));
    const state = open.some(g => g.status === 'waiting_for_provider') ? 'waiting_for_provider' : open.some(g => g.status === 'waiting_for_human') && open.every(g => ['waiting_for_human', 'temporarily_low_value', 'waiting_for_evidence', 'blocked_by_dependency', 'in_progress'].includes(g.status)) ? 'waiting_for_human'
      : open.some(g => g.status === 'in_progress' || g.status === 'waiting_for_evidence' || g.status === 'blocked_by_dependency') ? 'waiting_for_evidence' : ranked.length ? 'temporarily_low_value' : 'exhausted';
    return { chosen: null, ranked, exploration: false, stop: { state, reason: ranked.length ? `Best remaining test has marginal value ${ranked[0].adjusted} (${ranked[0].ineligible_reason ?? 'below the utility floor'}).` : 'No safe test can reduce the remaining gaps.' } };
  }
  let chosen = eligible[0], exploration = false;
  const urgent = chosen.components.report_readiness.value >= .8 || chosen.components.time_sensitivity.value >= .8;
  if (opts.exploration !== false && !urgent && explorationDraw(opts.seed) < POLICY.exploration_rate) {
    const under = eligible.filter(v => (s.learning[v.family]?.n ?? 0) < POLICY.min_learning_observations && v.family !== chosen.family && v.adjusted >= POLICY.benefit_floor * 1.5);
    if (under.length) { chosen = under[0]; exploration = true; }
  }
  return { chosen, ranked, exploration, stop: null };
}

/** Plain-language decision explanation (numerical internals stay in the components). */
export function explain(choice: Choice, gaps: Gap[]) {
  const map = new Map(gaps.map(g => [g.key, g] as const));
  if (!choice.chosen) return { chose: null, question: null, matters: null, why: choice.stop?.reason ?? '', deferred: choice.ranked.slice(0, 6).map(d => ({ test: d.family, subject: d.subject, reason: d.ineligible_reason ?? `Utility ${d.utility} below floor.` })) };
  const c = choice.chosen, g = map.get(c.primary_gap)!;
  const positive = (v: Valued) => Object.entries(v.components).filter(([k]) => k in WEIGHTS) as Array<[Component, Valued['components'][Component]]>;
  const factorNote = (v: Valued) => { const f = (Object.keys(MODIFIERS) as Array<keyof typeof MODIFIERS>).map(k => [k, v.components[k]] as const).filter(([, x]) => x && Math.abs(x.weight - 1) >= .1); return f.length ? ` Context: ${f.map(([k, x]) => `${k.replace(/_/g, ' ')} ×${x.weight}`).join(', ')}.` : ''; };
  const top = positive(c).filter(([, v]) => v.contribution > 0).sort((a, b) => b[1].contribution - a[1].contribution).slice(0, 3).map(([, v]) => v.reason);
  const runnerUp = choice.ranked.find(d => d.key !== c.key && d.eligible);
  const costLine = `Expected cost ${c.cost_units} effort units; value per cost ${c.utility}${runnerUp ? ` (next best ${runnerUp.utility})` : ''}.`;
  const deferred = choice.ranked.filter(d => d.key !== c.key).slice(0, 8).map(d => {
    let reason = d.ineligible_reason ?? '';
    if (!reason) {
      const sat = d.components.saturation.value, dup = d.components.duplicate_probability.value;
      const gapComp = positive(d).map(([k, v]) => [k, c.components[k].contribution - v.contribution] as const).sort((a, b) => b[1] - a[1])[0];
      reason = dup >= .5 ? `Likely duplicate: ${d.components.duplicate_probability.reason}` : sat >= .5 ? `Saturated: ${d.components.saturation.reason}`
        : d.cost_units > c.cost_units * 2 && d.adjusted <= c.adjusted * 2 ? `Higher cost (${d.cost_units} vs ${c.cost_units} effort units) outweighs its value (${d.adjusted} vs ${c.adjusted}).`
        : `Lower value per cost (${d.utility} vs ${c.utility})${gapComp && gapComp[1] > 0 ? `, mainly on ${gapComp[0].replace(/_/g, ' ')}` : ''}.`;
    }
    return { test: d.family, subject: d.subject, utility: d.utility, reason };
  });
  return { chose: `${TESTS[c.family].title}: ${c.objective.text}`, question: g.missing, matters: g.matters, why: `${choice.exploration ? 'Bounded exploration of an under-tested test family. ' : ''}${top.join(' ')}${factorNote(c)} ${costLine}`.trim(), deferred };
}
