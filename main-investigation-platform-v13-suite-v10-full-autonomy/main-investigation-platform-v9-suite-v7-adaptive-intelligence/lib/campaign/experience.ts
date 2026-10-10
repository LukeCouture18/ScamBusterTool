/**
 * Learning v2: measurable experience.
 *
 *   context -> action -> expected -> actual -> cost -> usefulness
 *
 * Safeguards, each enforced here rather than by convention:
 *  - Basis weights: a person's Useful/Skip (1.0) outweighs an observed module
 *    result (0.8), which outweighs a deterministic platform outcome (0.6). An
 *    AI self-evaluation (`ai_self`) is stored for audit and carries weight 0, so
 *    the system can never learn from its own predictions or conclusions.
 *  - Provenance gate: every non-AI row must cite a real row (a human decision, a
 *    completed job, an agent run). A row that cannot be traced is refused, so
 *    poisoned or fabricated observations cannot enter.
 *  - Shrinkage: priors start at 0.5 and need several real outcomes to move;
 *    a context-specific prior shrinks toward the action's global prior.
 *  - Bounds: priors are clamped to [0.15, 0.85] so no action or strategy can
 *    dominate permanently or be starved forever.
 *  - Forgetting with a floor: old outcomes decay (half-life 30 days) but never
 *    below 25% weight, so history is not catastrophically forgotten.
 */
import { getD1 } from "../platform";

export type ExperienceBasis = "human" | "observed" | "deterministic" | "ai_self";
export const BASIS_WEIGHT: Record<ExperienceBasis, number> = { human: 1.0, observed: 0.8, deterministic: 0.6, ai_self: 0 };
const PROOF: Record<Exclude<ExperienceBasis, "ai_self">, Array<[string, string]>> = {
  human: [["inbox_decisions", "id"]],
  observed: [["jobs", "id"], ["agent_runs", "id"], ["evidence", "id"], ["work_items", "id"], ["work_item_events", "id"]],
  deterministic: [["jobs", "id"], ["agent_runs", "id"], ["opportunities", "id"], ["inbox_candidates", "id"], ["work_items", "id"], ["work_item_events", "id"], ["entity_changes", "id"]],
};
export const PRIOR_MIN = 0.15, PRIOR_MAX = 0.85, SHRINK = 3, HALF_LIFE_DAYS = 30, DECAY_FLOOR = 0.25;
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));

export async function recordExperience(e: { campaignId: string | null; context: string; action: string; expected: number; actual: number; cost: number; useful: number; basis: ExperienceBasis; sourceRef: string }) {
  if (!(e.basis in BASIS_WEIGHT)) throw new Error("EXPERIENCE_BASIS_INVALID");
  if (e.basis !== "ai_self") {
    let found = false;
    for (const [table, col] of PROOF[e.basis]) if (await getD1().prepare(`SELECT 1 FROM ${table} WHERE ${col}=? LIMIT 1`).bind(e.sourceRef).first()) { found = true; break; }
    if (!found) throw new Error("EXPERIENCE_SOURCE_UNVERIFIED");
  }
  const r = await getD1().prepare("INSERT OR IGNORE INTO experience (id,campaign_id,context,action,expected,actual,cost,useful,basis,source_ref) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), e.campaignId, e.context.slice(0, 200), e.action.slice(0, 120), clamp(e.expected), Number(e.actual) || 0, Math.max(0, Number(e.cost) || 0), clamp(e.useful), e.basis, e.sourceRef).run();
  return (r.meta?.changes ?? 0) === 1;
}

type Agg = { w: number; wu: number; n: number };
function decay(createdAt: string) {
  const t = new Date(String(createdAt).replace(" ", "T") + (/[Z+-]\d\d:?\d\d$|Z$/.test(String(createdAt)) ? "" : "Z")).getTime();
  const days = Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 86400000) : 0;
  return Math.max(DECAY_FLOOR, Math.pow(0.5, days / HALF_LIFE_DAYS));
}
async function aggregate(action: string, context?: string, campaignId?: string): Promise<Agg> {
  const where = ["action=?"], binds: unknown[] = [action];
  if (context) { where.push("context=?"); binds.push(context); }
  if (campaignId) { where.push("campaign_id=?"); binds.push(campaignId); }
  const rows = (await getD1().prepare(`SELECT useful,basis,created_at FROM experience WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 400`).bind(...binds).all<{ useful: number; basis: ExperienceBasis; created_at: string }>()).results;
  const agg: Agg = { w: 0, wu: 0, n: 0 };
  for (const r of rows) { const w = (BASIS_WEIGHT[r.basis] ?? 0) * decay(r.created_at); if (w <= 0) continue; agg.w += w; agg.wu += w * Number(r.useful); agg.n++; }
  return agg;
}
const shrink = (a: Agg, toward: number) => (a.wu + SHRINK * toward) / (a.w + SHRINK);

/**
 * The learned prior for an action in a context: global -> context -> campaign,
 * each level shrunk toward the one above, then clamped.
 */
export async function prior(action: string, context: string, campaignId?: string) {
  const g = await aggregate(action);
  const global = shrink(g, 0.5);
  const c = await aggregate(action, context);
  const ctx = shrink(c, global);
  let value = ctx, camp: Agg | null = null;
  if (campaignId) { camp = await aggregate(action, context, campaignId); value = shrink(camp, ctx); }
  return { value: clamp(value, PRIOR_MIN, PRIOR_MAX), global: clamp(global, PRIOR_MIN, PRIOR_MAX), n_global: g.n, n_context: c.n, n_campaign: camp?.n ?? 0 };
}

export async function experienceStats(campaignId?: string) {
  const rows = (await getD1().prepare(`SELECT action,context,basis,COUNT(*) n,AVG(useful) useful,AVG(cost) cost,AVG(expected) expected FROM experience ${campaignId ? "WHERE campaign_id=?" : ""} GROUP BY action,context,basis ORDER BY action,context`).bind(...(campaignId ? [campaignId] : [])).all<Record<string, unknown>>()).results;
  return rows.map(r => ({ action: r.action, context: r.context, basis: r.basis, n: Number(r.n), useful: Number(Number(r.useful).toFixed(3)), expected: Number(Number(r.expected).toFixed(3)), cost: Number(Number(r.cost).toFixed(2)), weight: BASIS_WEIGHT[r.basis as ExperienceBasis] }));
}
