/**
 * Learning engine v3: operational outcomes across the whole platform.
 *
 *   context -> decision -> action -> cost -> result -> usefulness
 *
 * Built on the v4 experience ledger (lib/campaign/experience.ts), which already
 * enforces the safeguards: basis weights (human 1.0 > observed 0.8 >
 * deterministic 0.6 > AI self-evaluation 0), a provenance check on every row,
 * shrinkage, bounded priors, and decay with a floor. v5 adds platform-wide
 * actions (work-item kinds), human-need prediction, revisit value and campaign
 * stopping, and bounded exploration in the scheduler.
 */
import { getD1 } from "../platform";
import { prior, recordExperience } from "../campaign/experience";
import { parse, type Row } from "./common";

export async function learnedPrior(action: string, context: string, campaignId?: string) {
  return prior(action, context, campaignId);
}

/** Context string for a work item: kind-specific, low-cardinality, stable. */
export function workContext(w: Row) {
  const f = parse<Record<string, number>>(w.factors, {});
  const band = (x: number) => (x >= 0.66 ? "hi" : x >= 0.33 ? "mid" : "lo");
  return `kind=${w.kind}|campaign=${w.campaign_id ? 1 : 0}|gain=${band(Number(f.info_gain ?? 0.5))}|source=${w.source}`;
}

/**
 * Records what a finished work item actually produced. `useful` must come from
 * observed module results, a person, or a deterministic check, never from a
 * model's opinion of its own work.
 */
export async function recordWorkOutcome(w: Row, outcome: { useful: number; actual: number; cost: number; basis: "observed" | "deterministic"; eventId: string }) {
  const f = parse<Record<string, number>>(w.factors, {});
  const ctx = workContext(w);
  try {
    await recordExperience({ campaignId: w.campaign_id ? String(w.campaign_id) : null, context: ctx, action: String(w.kind), expected: Number(f.info_gain ?? 0.5), actual: outcome.actual, cost: outcome.cost, useful: outcome.useful, basis: outcome.basis, sourceRef: outcome.eventId });
  } catch { /* refused: unverifiable source */ }
  if (w.experiment_id) {
    await getD1().prepare("UPDATE experiment_assignments SET outcome=?,cost=? WHERE experiment_id=? AND work_item_id=?").bind(outcome.useful, outcome.cost, w.experiment_id, w.id).run();
  }
}

/** Human-need prediction: how often similar work ended up needing a person. */
export async function recordHumanNeed(context: string, needed: boolean, sourceRef: string) {
  try { await recordExperience({ campaignId: null, context, action: "human_needed", expected: 0.2, actual: needed ? 1 : 0, cost: 0, useful: needed ? 1 : 0, basis: "observed", sourceRef }); } catch { /* unverifiable */ }
}

export async function learningSummary() {
  const rows = (await getD1().prepare("SELECT action,COUNT(*) n,AVG(useful) useful,AVG(cost) cost,SUM(CASE WHEN basis='ai_self' THEN 1 ELSE 0 END) ai_self FROM experience GROUP BY action ORDER BY n DESC LIMIT 40").all<Row>()).results;
  return rows.map(r => ({ action: String(r.action), n: Number(r.n), useful: Number(Number(r.useful).toFixed(3)), cost: Number(Number(r.cost).toFixed(2)), ignored_ai_self_rows: Number(r.ai_self) }));
}
