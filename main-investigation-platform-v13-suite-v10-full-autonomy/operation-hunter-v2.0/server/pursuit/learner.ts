import type { IntelStore } from '../core/intelStore.js';
import { PIVOTS } from '../collectors/pivots.js';
import { round } from '../core/util.js';

/**
 * Contextual progress learner.
 *
 * v1 learned "did this pivot find at least one new relevant thing". v2 learns
 * how much *progress* a pivot makes per unit of cost in a given context — new
 * members, operator indicators, money destinations, resolved uncertainty,
 * detected changes — because more data is not more progress.
 *
 * Context is hierarchical, from specific to general:
 *   pivot × entity type × membership status × indicator level
 *   pivot × entity type × membership status
 *   pivot × entity type
 *   pivot
 * Estimates shrink toward the more general level (and finally the catalogue
 * prior) in proportion to how little data the specific level has. Delayed
 * credit — when an entity found by a pivot is later accepted as a member —
 * flows back into the same contexts.
 */
export interface PivotContext { pivotType: string; entityType: string; status: string; level: string }

export function contextKeys(c: PivotContext): string[] {
  return [`${c.entityType}|${c.status}|${c.level}`, `${c.entityType}|${c.status}`, `${c.entityType}`, '*'];
}

export interface Estimate { mean: number; sd: number; n: number; source: string }

const PRIOR_STRENGTH = 2;

export class ProgressLearner {
  private cache: Map<string, { pulls: number; cost: number; progress: number; progressSq: number; credited: number }> | null = null;

  constructor(private intel: IntelStore) {}

  private rows() {
    if (!this.cache) this.cache = new Map(this.intel.learnerRows().map(r => [`${r.context}::${r.pivotType}`, r]));
    return this.cache;
  }

  invalidate() { this.cache = null; }

  /** Prior progress per pull, from the catalogue's expected yield. */
  prior(pivotType: string): number {
    return (PIVOTS[pivotType]?.priorGain ?? 1) * 1.6;
  }

  estimate(c: PivotContext): Estimate {
    let mean = this.prior(c.pivotType);
    let variance = Math.pow(mean * 0.9, 2);
    let n = 0;
    let source = 'prior';
    // general → specific, each level shrinks toward the level above it
    for (const key of contextKeys(c).reverse()) {
      const r = this.rows().get(`${key}::${c.pivotType}`);
      if (!r || r.pulls <= 0) continue;
      const total = r.progress + r.credited;
      const m = total / r.pulls;
      const v = Math.max(0.25, r.progressSq / r.pulls - Math.pow(r.progress / r.pulls, 2));
      const k = PRIOR_STRENGTH;
      mean = (k * mean + r.pulls * m) / (k + r.pulls);
      variance = (k * variance + r.pulls * v) / (k + r.pulls);
      n = r.pulls;
      source = key === '*' ? 'all contexts' : key;
    }
    const sd = Math.sqrt(variance / (1 + n));
    return { mean: round(Math.max(0, mean), 3), sd: round(sd, 3), n, source };
  }

  /** Thompson sample (normal approximation) for exploration. */
  sample(c: PivotContext, rnd: () => number = Math.random): number {
    const e = this.estimate(c);
    const u1 = Math.max(1e-9, rnd()), u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, e.mean + e.sd * z);
  }

  record(c: PivotContext, progress: number, cost: number) {
    for (const key of contextKeys(c)) this.intel.bumpLearner(key, c.pivotType, { pulls: 1, cost, progress });
    this.invalidate();
  }

  credit(c: PivotContext, amount: number) {
    for (const key of contextKeys(c)) this.intel.bumpLearner(key, c.pivotType, { credited: amount });
    this.invalidate();
  }

  table() {
    const out: Array<{ pivotType: string; context: string; pulls: number; progressPerPull: number; creditPerPull: number; costPerPull: number }> = [];
    for (const r of this.intel.learnerRows()) {
      if (r.pulls <= 0) continue;
      out.push({ pivotType: r.pivotType, context: r.context, pulls: r.pulls, progressPerPull: round(r.progress / r.pulls, 2), creditPerPull: round(r.credited / r.pulls, 2), costPerPull: round(r.cost / r.pulls, 2) });
    }
    return out.sort((a, b) => b.pulls - a.pulls);
  }
}
