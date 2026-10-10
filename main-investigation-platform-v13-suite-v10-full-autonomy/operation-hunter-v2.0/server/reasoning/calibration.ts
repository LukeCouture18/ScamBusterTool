import type { MembershipFactor } from '../core/intelStore.js';
import { DEFAULT_WEIGHTS, MembershipWeights } from './membership.js';

/**
 * Learning from analyst verdicts. When you mark a site as part of the
 * operation (or not), the factors that membership inference had used for it
 * at that moment are stored. Across all operations, factor families that keep
 * pulling in sites you reject are weighted down, and families that you keep
 * confirming beyond what the model believed are weighted up — gently, within
 * bounds, and only after a few verdicts. The prior, thresholds and negative
 * evidence are never learned away.
 */
const KEY_TO_WEIGHT: Array<[RegExp, keyof MembershipWeights]> = [
  [/^id:/, 'operatorId'], [/^wallet:/, 'walletRef'], [/^res:/, 'operatorResource'], [/^cert:/, 'certificate'], [/^ns:/, 'privateNs'],
  [/^ip:/, 'ip'], [/^tpl:/, 'template'], [/^kitres:/, 'kitResource'], [/^redirect:/, 'redirect'], [/^wave$/, 'registrationWave'],
  [/^naming$/, 'naming'], [/^vendor:/, 'vendorIndicator'],
];

export interface Calibration { weights: Partial<MembershipWeights>; verdicts: number; adjustments: Array<{ weight: string; factor: number; confirmed: number; rejected: number }> }

export function calibrateWeights(feedback: Array<{ verdict: string; factors: MembershipFactor[] }>, minVerdicts = 3): Calibration {
  const tally = new Map<keyof MembershipWeights, { up: number; down: number }>();
  for (const f of feedback) {
    const probability = 1 / (1 + Math.exp(-(DEFAULT_WEIGHTS.prior + f.factors.reduce((s, x) => s + x.weight, 0))));
    for (const factor of f.factors) {
      if (factor.weight <= 0) continue;
      const w = KEY_TO_WEIGHT.find(([re]) => re.test(factor.key))?.[1];
      if (!w) continue;
      const t = tally.get(w) ?? { up: 0, down: 0 };
      if (f.verdict === 'not_member') t.down += 1;
      else if (f.verdict === 'member' && probability < DEFAULT_WEIGHTS.memberThreshold) t.up += 1;
      tally.set(w, t);
    }
  }
  const weights: Partial<MembershipWeights> = {};
  const adjustments: Calibration['adjustments'] = [];
  if (feedback.length < minVerdicts) return { weights, verdicts: feedback.length, adjustments };
  for (const [w, t] of tally) {
    const factor = Math.max(0.6, Math.min(1.4, Math.exp(0.12 * (t.up - t.down))));
    if (Math.abs(factor - 1) < 0.02) continue;
    (weights as any)[w] = Math.round((DEFAULT_WEIGHTS[w] as number) * factor * 100) / 100;
    adjustments.push({ weight: w, factor: Math.round(factor * 100) / 100, confirmed: t.up, rejected: t.down });
  }
  return { weights, verdicts: feedback.length, adjustments };
}
