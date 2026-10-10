import type { HunterStore } from '../core/store.js';
import type { PivotStrategyStat, LearningOutcomeRecord, LeadCost } from '../types.js';
import { PIVOTS } from '../collectors/pivots.js';
import { newId, nowIso, round, clamp } from '../core/util.js';

/**
 * Strategy learning. For every (pivot type, entity type) pair Hunter keeps a
 * Beta posterior over "this pivot finds at least one relevant new entity",
 * plus the running mean number of relevant entities it finds. Analyst feedback
 * (useful / not useful findings, Main inbox decisions on Hunter leads) shifts
 * the posterior. Expected gain feeds lead ranking; an exploration bonus keeps
 * rarely-tried pivots in play.
 */
export class StrategyLearner {
  private cache: Map<string, ReturnType<HunterStore['getStrategyRows']>[number]> | null = null;

  constructor(private store: HunterStore) {}

  private rows() {
    if (!this.cache) this.cache = new Map(this.store.getStrategyRows().map(r => [`${r.pivot_type}|${r.entity_type}`, r]));
    return this.cache;
  }

  invalidate() { this.cache = null; }

  record(input: { operationId: string; pivotType: string; entityType: string; pivotId?: string; newRelevant: number; newEntities: number; newEvidence: number; contradiction?: boolean; confidence: number; cost: LeadCost; context: string }) {
    this.store.bumpStrategy(input.pivotType, input.entityType, {
      attempts: 1, successes: input.newRelevant > 0 ? 1 : 0, usefulYield: input.newRelevant, newEntities: input.newEntities,
      contradictions: input.contradiction ? 1 : 0, confidence: input.confidence,
    });
    const outcome: LearningOutcomeRecord = {
      id: newId('learn', 10), operationId: input.operationId, leadId: input.pivotId ?? '', pivotType: input.pivotType, contextDescription: input.context,
      expectedResult: `Expected ~${round(this.expectedGain(input.pivotType, input.entityType), 1)} relevant new entities`,
      actualResult: `${input.newRelevant} relevant new entities, ${input.newEvidence} evidence records`,
      evidenceGainedCount: input.newEvidence, newEntitiesFoundCount: input.newEntities, costIncurred: input.cost,
      usefulnessScore: Math.min(100, Math.round(input.newRelevant * 25 + input.newEvidence * 5)), timestamp: nowIso(),
    };
    this.store.addLearningOutcome(outcome);
    this.invalidate();
    return outcome;
  }

  feedback(pivotType: string, entityType: string, positive: boolean) {
    this.store.bumpStrategy(pivotType, entityType, positive ? { analystPositive: 1 } : { analystNegative: 1 });
    this.invalidate();
  }

  /** Posterior probability that the pivot yields something relevant. */
  successProbability(pivotType: string, entityType: string): number {
    const spec = PIVOTS[pivotType];
    const prior = clamp((spec?.priorGain ?? 1) / 3, 0.15, 0.9);
    const a0 = 1 + prior * 3, b0 = 1 + (1 - prior) * 3;
    const r = this.rows().get(`${pivotType}|${entityType}`);
    const a = a0 + (r?.successes ?? 0) + (r?.analyst_positive ?? 0) * 2;
    const b = b0 + ((r?.attempts ?? 0) - (r?.successes ?? 0)) + (r?.analyst_negative ?? 0) * 2;
    return a / (a + b);
  }

  /** Expected number of relevant new entities (shrunk toward the prior). */
  expectedGain(pivotType: string, entityType: string): number {
    const spec = PIVOTS[pivotType];
    const prior = spec?.priorGain ?? 1;
    const r = this.rows().get(`${pivotType}|${entityType}`);
    const k = 3;
    const mean = ((r?.useful_yield ?? 0) + prior * k) / ((r?.attempts ?? 0) + k);
    return mean * (0.5 + this.successProbability(pivotType, entityType));
  }

  explorationBonus(pivotType: string, entityType: string): number {
    const all = [...this.rows().values()].reduce((s, r) => s + r.attempts, 0);
    const r = this.rows().get(`${pivotType}|${entityType}`);
    return Math.sqrt(Math.log(all + 2) / ((r?.attempts ?? 0) + 1));
  }

  /** Legacy view: one aggregated row per pivot type (utility 0..100). */
  legacyStats(): Record<string, PivotStrategyStat> {
    const byPivot = new Map<string, PivotStrategyStat & { _conf: number; _pos: number; _neg: number }>();
    for (const r of this.rows().values()) {
      let s = byPivot.get(r.pivot_type);
      if (!s) byPivot.set(r.pivot_type, (s = { pivotType: r.pivot_type, sourceCategory: category(r.pivot_type), attempts: 0, successes: 0, usefulEvidenceYield: 0, contradictionCount: 0, avgConfidence: 0, utilityScore: 0, _conf: 0, _pos: 0, _neg: 0 }));
      s.attempts += r.attempts; s.successes += r.successes; s.usefulEvidenceYield += r.useful_yield; s.contradictionCount += r.contradictions;
      s._conf += r.confidence_sum; s._pos += r.analyst_positive; s._neg += r.analyst_negative;
    }
    const out: Record<string, PivotStrategyStat> = {};
    for (const pivotType of Object.keys(PIVOTS)) {
      const s = byPivot.get(pivotType) ?? { pivotType, sourceCategory: category(pivotType), attempts: 0, successes: 0, usefulEvidenceYield: 0, contradictionCount: 0, avgConfidence: 0, utilityScore: 0, _conf: 0, _pos: 0, _neg: 0 };
      const successRatio = s.attempts ? s.successes / s.attempts : clamp((PIVOTS[pivotType].priorGain) / 3, 0, 1);
      const yieldFactor = s.attempts ? Math.min(1, s.usefulEvidenceYield / (s.attempts * 2)) : 0.5;
      const avgConfidence = s.attempts ? s._conf / s.attempts : 0.9;
      const raw = successRatio * 50 + yieldFactor * 30 + avgConfidence * 20 - s.contradictionCount * 5 + (s._pos - s._neg) * 3;
      out[pivotType] = { pivotType, sourceCategory: s.sourceCategory, attempts: s.attempts, successes: s.successes, usefulEvidenceYield: round(s.usefulEvidenceYield, 1), contradictionCount: s.contradictionCount, avgConfidence: round(avgConfidence, 2), utilityScore: Math.max(5, Math.min(100, Math.round(raw))) };
    }
    return out;
  }

  table() {
    return [...this.rows().values()].map(r => ({
      pivotType: r.pivot_type, entityType: r.entity_type, attempts: r.attempts, successes: r.successes, usefulYield: round(r.useful_yield, 1),
      successProbability: round(this.successProbability(r.pivot_type, r.entity_type), 2), expectedGain: round(this.expectedGain(r.pivot_type, r.entity_type), 2),
      analystPositive: r.analyst_positive, analystNegative: r.analyst_negative, updatedAt: r.updated_at,
    })).sort((a, b) => b.expectedGain - a.expectedGain);
  }
}

function category(pivotType: string): string {
  if (/DNS|NS/.test(pivotType)) return 'DNS';
  if (/CT_/.test(pivotType)) return 'SSL';
  if (/RDAP/.test(pivotType)) return 'REGISTRATION';
  if (/IP_/.test(pivotType)) return 'NETWORK';
  if (/WALLET/.test(pivotType)) return 'BLOCKCHAIN';
  if (/SITE|RESOURCE/.test(pivotType)) return 'HTML_JS';
  if (/TRACKER/.test(pivotType)) return 'TRACKERS';
  if (/MAIN|SITE_CHECK/.test(pivotType)) return 'MAIN_PLATFORM';
  return 'ANALYSIS';
}
