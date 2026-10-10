import type { HunterApp } from '../app.js';
import type { PivotCandidate } from '../engine/planner.js';
import type { Branch } from '../core/intelStore.js';
import type { OperationAnalysis } from '../analysis/analyzer.js';
import { PIVOTS } from '../collectors/pivots.js';
import { pivotSignature } from '../engine/planner.js';
import { isCommodity } from '../engine/noise.js';
import { ProgressLearner, PivotContext } from './learner.js';
import { BranchTracker, branchKindOf, BranchKind } from './branches.js';
import { COST_UNITS } from './progress.js';
import { clamp, round } from '../core/util.js';

/**
 * Resource allocation for autonomous pursuit.
 *
 * Every possible next lookup is scored by its expected progress per unit of
 * cost (value of information), using the contextual learner (with Thompson
 * sampling for exploration), how much the target matters to the current
 * reconstruction (membership / indicator level), how much uncertainty a
 * lookup could resolve, and the state of its branch (productive, saturated,
 * due for a revisit). Parallel slots are filled across different branch
 * kinds so one noisy line cannot starve the others.
 */
export interface ScoredCandidate extends PivotCandidate {
  context: PivotContext;
  branchId: string;
  branchKind: BranchKind;
  expected: number;        // expected progress per unit cost (point estimate)
  sampled: number;         // Thompson sample used for ordering
  relevance: number;
  uncertainty: number;
  revisit: boolean;
  why: string[];
}

export function statusOf(analysis: OperationAnalysis | undefined | null, entityId: string, type: string): string {
  const m = analysis?.membership?.byId?.[entityId];
  if (m) return m.status;
  return type === 'domain' ? 'unknown' : 'unknown';
}

export function levelOf(analysis: OperationAnalysis | undefined | null, entityId: string): string {
  return analysis?.membership?.indicators?.[entityId]?.level ?? 'n/a';
}

function entropy(p: number) {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

const VERIFYING = new Set(['SITE_PROFILE', 'RDAP_DOMAIN', 'DNS_RESOLVE', 'CT_SEARCH', 'SITE_CHECK_REQUEST', 'MAIN_LOOKUP']);

export class Allocator {
  readonly learner: ProgressLearner;
  readonly branches: BranchTracker;

  /** Random source for exploration (seedable for reproducible benchmarks). */
  rnd: () => number = Math.random;

  constructor(private app: HunterApp) {
    this.learner = new ProgressLearner(app.intel);
    this.branches = new BranchTracker(app.intel);
  }

  score(operationId: string, candidates: PivotCandidate[], opts: { explore?: boolean; rnd?: () => number } = {}): ScoredCandidate[] {
    const analysis = this.app.analyzer.peek(operationId);
    const branchIndex = new Map(this.app.intel.getBranches(operationId).map(b => [`${b.kind}:${b.anchor}`, b]));
    const out: ScoredCandidate[] = [];
    for (const c of candidates) {
      const status = statusOf(analysis, c.entity.id, c.entity.type);
      const level = levelOf(analysis, c.entity.id);
      const ctx: PivotContext = { pivotType: c.spec.pivotType, entityType: c.entity.type, status, level };
      const est = this.learner.estimate(ctx);
      const sampled = opts.explore === false ? est.mean : this.learner.sample(ctx, opts.rnd ?? this.rnd);
      const kind = branchKindOf(c.spec.pivotType);
      const branch = branchIndex.get(`${kind}:${c.entity.id}`);
      const why: string[] = [];
      // How much the target matters now.
      let relevance: number;
      const p = analysis?.membership?.byId?.[c.entity.id]?.probability ?? (c.entity.isSeed ? 1 : 0.25);
      if (c.entity.isSeed || status === 'member') relevance = 1;
      else if (c.entity.type === 'pattern') relevance = 0.9;
      else if (c.entity.type === 'domain') relevance = status === 'excluded' ? 0.04 : 0.2 + 0.75 * p;
      else {
        relevance = level === 'operator' ? 1 : level === 'infrastructure' ? 0.7 : level === 'vendor' ? 0.35 : level === 'service' ? 0.08 : level === 'commodity' ? 0 : 0.45;
        if (status === 'candidate') relevance = Math.max(relevance, 0.5);
      }
      if (c.victimLikely) { relevance *= 0.15; why.push('probably a victim wallet'); }
      if (isCommodity(c.entity.ubiquity)) relevance *= 0.1;
      // Uncertainty a verifying lookup could resolve (value of information for membership).
      // Value of verifying: highest when the site is a real contender (verification usually confirms, rarely rescues, a weak one).
      const uncertainty = c.entity.type === 'domain' && VERIFYING.has(c.spec.pivotType) && status !== 'member' && status !== 'excluded' ? entropy(p) * (0.4 + p) : 0;
      if (uncertainty > 0.5) why.push(`would help decide whether ${c.entity.value} belongs (currently ${Math.round(p * 100)}%)`);
      const depthFactor = Math.pow(0.93, c.entity.depth ?? 0);
      const cost = COST_UNITS[c.spec.cost] ?? 1.5;
      const bf = this.branches.factor(branch);
      if (branch?.status === 'saturated') why.push('its line of inquiry has stopped paying off');
      if (branch?.status === 'revisit') why.push('revisiting a line that was quiet for a while');
      // Coverage: lookups that fill a missing dimension of a relevant entity (no DNS, no registration, money not traced, ...).
      const gap = (c.breakdown?.gapFulfillmentScore ?? 0) * 0.3 * relevance;
      if (gap >= 1.5) why.push(c.reasons.find(r => /not|unknown|could/.test(r)) ?? 'fills a gap');
      const value = ((sampled * relevance + uncertainty * 4 + gap) * depthFactor * bf) / cost;
      const expected = ((est.mean * relevance + uncertainty * 4 + gap) * depthFactor * bf) / cost;
      why.unshift(`expected progress ≈ ${round(est.mean * relevance, 1)} (${est.n ? `learned from ${Math.round(est.n)} similar lookups` : 'prior'})`);
      out.push({
        ...c, context: ctx, branchId: branch?.id ?? `${kind}:${c.entity.id}`, branchKind: kind, expected: round(expected, 3), sampled: round(value, 3), relevance: round(relevance, 2), uncertainty: round(uncertainty, 2), revisit: branch?.status === 'revisit', why,
        score: Math.round(clamp(expected * 12, 0, 100)),
      });
    }
    return out.sort((a, b) => b.sampled - a.sampled || b.expected - a.expected || a.key.localeCompare(b.key));
  }

  /** Fill parallel slots, spreading picks across branch kinds and hosts. */
  select(scored: ScoredCandidate[], slots: number, inFlightKinds: string[] = []): ScoredCandidate[] {
    const picks: ScoredCandidate[] = [];
    const kindCount = new Map<string, number>();
    for (const k of inFlightKinds) kindCount.set(k, (kindCount.get(k) ?? 0) + 1);
    const perKind = Math.max(1, Math.ceil(slots / 2));
    for (const c of scored) {
      if (picks.length >= slots) break;
      if ((kindCount.get(c.branchKind) ?? 0) >= perKind && scored.some(o => o.branchKind !== c.branchKind && !picks.includes(o))) continue;
      if (picks.some(pk => pk.entity.id === c.entity.id)) continue;
      picks.push(c);
      kindCount.set(c.branchKind, (kindCount.get(c.branchKind) ?? 0) + 1);
    }
    if (picks.length < slots) for (const c of scored) { if (picks.length >= slots) break; if (!picks.includes(c) && !picks.some(pk => pk.key === c.key)) picks.push(c); }
    return picks;
  }

  /** Candidates that revisit branches due for another look (bypassing caches). */
  revisitCandidates(operationId: string): PivotCandidate[] {
    const out: PivotCandidate[] = [];
    const op = this.app.store.getOperation(operationId);
    if (!op) return out;
    const settings = this.app.runtimeSettings();
    for (const b of this.app.intel.getBranches(operationId).filter(x => x.status === 'revisit')) {
      const e = this.app.store.getEntity(b.anchor);
      if (!e) continue;
      for (const spec of this.app.collectors.pivotsFor(e)) {
        if (branchKindOf(spec.pivotType) !== b.kind || !spec.monitorable && !['REVERSE_NS', 'REVERSE_IP', 'SHARED_RESOURCE'].includes(spec.pivotType)) continue;
        const resolved = this.app.collectors.resolve(spec.pivotType, e, op, settings, this.app.mainBridge());
        if (!resolved.collector) continue;
        out.push({ key: `${pivotSignature(spec.pivotType, e)}#r${b.stats.revisits}`, spec, entity: e, collectorId: resolved.collector.id, score: 50, breakdown: undefined, reasons: ['revisit'], victimLikely: false });
      }
    }
    return out;
  }

  /** Is anything left worth doing? The best expected progress per unit cost (optimistic). */
  remainingValue(scored: ScoredCandidate[]): number {
    const top = scored.slice().sort((a, b) => b.expected - a.expected)[0];
    return top ? top.expected : 0;
  }

  seed(seed: number) {
    let a = seed >>> 0;
    this.rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  branchKind(pivotType: string) { return branchKindOf(pivotType); }
  pivotSpec(pivotType: string) { return PIVOTS[pivotType]; }
  branchOf(b: Branch | undefined) { return b; }
}
