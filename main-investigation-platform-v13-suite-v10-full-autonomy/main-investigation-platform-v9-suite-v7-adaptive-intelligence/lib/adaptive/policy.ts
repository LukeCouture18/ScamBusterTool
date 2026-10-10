/**
 * v7: pure policies for portfolio scheduling, bounded dynamic budgets, causal credit and
 * multi-level saturation. No database access; the durable layer (store.ts) persists every
 * decision these functions make, with its reason.
 */

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Portfolio: where is the next unit of investigation effort most valuable?
// ---------------------------------------------------------------------------------------------
export type PortfolioEntry = {
  scope: string; utility: number; time_sensitivity: number; report_closeness: number; contradiction: number; new_wave: number;
  provider_opportunity: number; exploration: boolean; hours_since_service: number; recent_share: number; consecutive: number; eligible: boolean;
};
export const PORTFOLIO = { starvation_per_hour: .02, starvation_cap: .3, max_consecutive: 3, max_recent_share: .5, min_peers_for_fairness: 2 };

/** Ranks scopes for this tick. Fairness: no scope may monopolize while others are eligible. */
export function portfolioOrder(entries: PortfolioEntry[]) {
  const eligible = entries.filter(e => e.eligible);
  const peers = eligible.length;
  const scored = eligible.map(e => {
    const urgency = .15 * e.time_sensitivity + .15 * e.report_closeness + .1 * e.contradiction + .1 * e.new_wave + .05 * e.provider_opportunity;
    const starvation = Math.min(PORTFOLIO.starvation_cap, e.hours_since_service * PORTFOLIO.starvation_per_hour);
    const monopoly = peers >= PORTFOLIO.min_peers_for_fairness && (e.consecutive >= PORTFOLIO.max_consecutive || e.recent_share > PORTFOLIO.max_recent_share);
    const score = r3((e.utility + urgency + starvation) * (monopoly ? .25 : 1));
    return { ...e, score, starvation: r3(starvation), urgency: r3(urgency), fairness_hold: monopoly,
      reason: monopoly ? `Held back for fairness (${e.consecutive} consecutive starts, ${Math.round(e.recent_share * 100)}% of recent starts).` : starvation >= .1 ? `Waiting ${Math.round(e.hours_since_service)}h; starvation boost ${r3(starvation)}.` : `Expected value ${r3(e.utility)} plus urgency ${r3(urgency)}.` };
  });
  return scored.sort((a, b) => b.score - a.score || a.scope.localeCompare(b.scope));
}

// ---------------------------------------------------------------------------------------------
// Dynamic budgets: earned, bounded, persisted.
// ---------------------------------------------------------------------------------------------
export const BUDGET = { base: 8, max_bonus: 4, min_allowance_floor: 2, earn_window: 4, earn_required: 2, lose_window: 3 };
export type RecentOutcome = { useful: boolean; independent: boolean; duplicate: boolean; dead: boolean };

/** Returns the allowance delta (−1, 0, +1) after a finished test, with its reason. Hard ceilings never move. */
export function budgetAdjustment(current: { max_hunts: number; hunts: number; bonus: number }, recent: RecentOutcome[]) {
  const window = recent.slice(-BUDGET.earn_window);
  const independentUseful = window.filter(r => r.useful && r.independent).length;
  if (independentUseful >= BUDGET.earn_required && current.bonus < BUDGET.max_bonus)
    return { delta: 1, reason: `${independentUseful} of the last ${window.length} tests produced useful independent evidence; +1 bounded allowance (bonus ${current.bonus + 1}/${BUDGET.max_bonus}).` };
  const lose = recent.slice(-BUDGET.lose_window);
  if (lose.length === BUDGET.lose_window && lose.every(r => r.duplicate || r.dead || !r.useful) && current.max_hunts > Math.max(BUDGET.min_allowance_floor, current.hunts))
    return { delta: -1, reason: `The last ${BUDGET.lose_window} tests were duplicates or dead ends; allowance reduced by one (never below ${Math.max(BUDGET.min_allowance_floor, current.hunts)}).` };
  return { delta: 0, reason: 'No adjustment.' };
}

// ---------------------------------------------------------------------------------------------
// Causal outcome attribution: conservative, fractional, never double-credited.
// ---------------------------------------------------------------------------------------------
export type Link = { test_id: string; strength: 'provenance' | 'derived' | 'temporal_only' };
/** Credit for ONE outcome across the tests that plausibly produced it. Sum <= 1. Temporal coincidence earns nothing. */
export function creditShares(links: Link[]) {
  const causal = [...new Map(links.filter(l => l.strength !== 'temporal_only').map(l => [l.test_id, l] as const)).values()];
  const ambiguous = links.filter(l => l.strength === 'temporal_only').map(l => l.test_id);
  if (!causal.length) return { shares: [] as Array<{ test_id: string; credit: number; basis: string }>, ambiguous, note: ambiguous.length ? 'Only temporal coincidence; no causal credit claimed.' : 'No lineage.' };
  // Direct provenance outranks derivation; derived links share what direct links leave.
  const direct = causal.filter(l => l.strength === 'provenance'), derived = causal.filter(l => l.strength === 'derived');
  const directPool = direct.length ? (derived.length ? .7 : 1) : 0, derivedPool = 1 - directPool;
  const shares = [...direct.map(l => ({ test_id: l.test_id, credit: r3(directPool / direct.length), basis: 'provenance' })), ...derived.map(l => ({ test_id: l.test_id, credit: r3(derivedPool / derived.length), basis: 'derived' }))];
  return { shares, ambiguous, note: shares.length > 1 ? 'Credit split conservatively across contributing tests.' : 'Single causal lineage.' };
}

// ---------------------------------------------------------------------------------------------
// Multi-level saturation.
// ---------------------------------------------------------------------------------------------
export type SatState = 'active' | 'temporarily_low_value' | 'exhausted' | 'waiting_for_evidence' | 'waiting_for_human' | 'waiting_for_provider';
/** Combine children states: active wins; otherwise the most actionable waiting reason; exhausted only if all are. */
export function combine(states: SatState[]): SatState {
  if (!states.length) return 'exhausted';
  for (const s of ['active', 'waiting_for_provider', 'waiting_for_human', 'waiting_for_evidence', 'temporarily_low_value'] as SatState[]) if (states.includes(s)) return s;
  return 'exhausted';
}
export function gapState(status: string): SatState {
  if (['open', 'in_progress'].includes(status)) return 'active';
  if (status === 'blocked_by_dependency') return 'waiting_for_evidence';
  if (['waiting_for_evidence', 'waiting_for_human', 'waiting_for_provider', 'temporarily_low_value'].includes(status)) return status as SatState;
  return 'exhausted';
}

/** A parked scope's watermark: any change in these counters is a wake condition. */
export type Watermark = { sites: number; wallets: number; evidence_units: number; contradictions: number; waves: number; hunter_revision: number; provider_healthy: number; human_resolved: number; budget: number };
export function wakeReasons(before: Watermark, after: Watermark): string[] {
  const out: string[] = [];
  if (after.sites > before.sites) out.push('new_site_observation');
  if (after.wallets !== before.wallets) out.push('wallet_changed');
  if (after.evidence_units > before.evidence_units) out.push('new_independent_evidence');
  if (after.contradictions > before.contradictions) out.push('contradiction_appeared');
  if (after.waves > before.waves) out.push('new_deployment_wave');
  if (after.hunter_revision !== before.hunter_revision) out.push('hunter_model_changed');
  if (after.provider_healthy > before.provider_healthy) out.push('provider_recovered');
  if (after.human_resolved > before.human_resolved) out.push('human_decision');
  if (after.budget > before.budget) out.push('budget_refreshed');
  return out;
}

export { clamp };
