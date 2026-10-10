/**
 * The global opportunity queue.
 *
 * Every piece of investigation work the platform could do is a typed work item
 * with a deterministic priority built from named factors. Only the scheduler
 * executes work items, and only through existing machinery (the v3 investigator,
 * v4 campaigns, typed module jobs). AI may reason about work items; it can never
 * create an executable one that bypasses these rules.
 *
 * Fingerprints make work idempotent: the same work is one row, however many
 * times it is proposed. Re-proposing queued work re-scores it; re-proposing
 * finished work only re-opens it when the caller says the world changed
 * (`reopen`), and then only after its cooldown.
 */
import { z } from "zod";
import { getD1 } from "../platform";
import { assertExecutionAllowed } from "./guard";
import { clamp, json, parse, r3, type Row } from "./common";

export const KINDS = ["investigate_candidate", "revisit_changed_site", "inspect_infrastructure", "analyze_wallet", "expand_campaign", "test_hypothesis", "compare_clusters",
  "revisit_incomplete", "draft_report", "review_contradiction", "campaign_step", "form_campaign", "merge_campaigns", "split_campaign", "discovery_cycle",
  // Platform v5 + Operation Hunter v2.0: ask Hunter to reconstruct and pursue the operation behind a campaign or site.
  "reconstruct_operation",
  // Next generation: Main or Hunter asks Site Finder for more sites like a set of known ones (an evidence gap).
  "find_related_sites"] as const;
export type Kind = (typeof KINDS)[number];
export const HUMAN_KINDS = new Set<Kind>(["review_contradiction"]);
export const MODULE_OF: Partial<Record<Kind, string>> = {
  investigate_candidate: "site_investigator", revisit_changed_site: "site_investigator", revisit_incomplete: "site_investigator",
  analyze_wallet: "wallet_investigator", inspect_infrastructure: "site_finder", discovery_cycle: "site_finder", expand_campaign: "site_finder",
  reconstruct_operation: "operation_hunter", find_related_sites: "site_finder",
};

export type Factors = {
  info_gain: number; novelty: number; evidence_strength: number; campaign_relevance: number; accessibility: number;
  previous_outcomes: number; cost: number; dup_prob: number; saturation: number; freshness: number; open_gaps: number;
};
export const WEIGHTS: Record<keyof Factors, number> = {
  info_gain: 0.22, novelty: 0.12, evidence_strength: 0.1, campaign_relevance: 0.12, accessibility: 0.08, previous_outcomes: 0.1,
  open_gaps: 0.1, freshness: 0.06, cost: -0.1, dup_prob: -0.5, saturation: -0.4,
};
export const DEFAULT_FACTORS: Factors = { info_gain: 0.5, novelty: 0.5, evidence_strength: 0.5, campaign_relevance: 0, accessibility: 1, previous_outcomes: 0.5, cost: 0.3, dup_prob: 0, saturation: 0, freshness: 1, open_gaps: 0 };

/** Pure: the deterministic priority of a set of factors. */
export function priorityOf(f: Factors) {
  let p = 0;
  for (const k of Object.keys(WEIGHTS) as Array<keyof Factors>) p += WEIGHTS[k] * clamp(Number(f[k] ?? 0));
  return r3(p);
}

/** Pure: the scheduler's effective priority, adding a bounded boost for time spent waiting (starvation prevention). */
export function effectivePriority(priority: number, waitedHours: number, boostPerHour: number, boostCap: number) {
  return r3(priority + Math.min(boostCap, Math.max(0, waitedHours) * boostPerHour));
}

/** One sentence naming the two strongest positive factors. */
export function explain(f: Factors) {
  const text: Partial<Record<keyof Factors, string>> = { info_gain: "it could reveal new wallets or infrastructure", novelty: "it is new to the platform", evidence_strength: "strong public signals",
    campaign_relevance: "it matters to an active campaign", previous_outcomes: "similar work paid off before", open_gaps: "it closes an open evidence gap", freshness: "it is recent" };
  return (Object.keys(text) as Array<keyof Factors>).map(k => [k, WEIGHTS[k] * clamp(Number(f[k] ?? 0))] as const).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => text[k]).join(" and ");
}

export const WORK_ITEM_INPUT = z.object({
  kind: z.enum(KINDS), targetType: z.string().min(1).max(40), targetKey: z.string().min(1).max(400), fingerprint: z.string().min(3).max(500).optional(),
  source: z.enum(["discovery", "change", "gap", "campaign", "contradiction", "command", "formation", "scheduler", "experiment"]),
  reason: z.string().max(400), factors: z.record(z.string(), z.number()).optional(),
  campaignId: z.string().nullable().optional(), investigationId: z.string().nullable().optional(), gapId: z.string().nullable().optional(),
  experimentId: z.string().nullable().optional(), experimentArm: z.string().nullable().optional(),
  notBefore: z.string().nullable().optional(), maxAttempts: z.number().int().min(1).max(10).optional(), reopen: z.boolean().optional(),
}).strict();
export type WorkItemInput = z.infer<typeof WORK_ITEM_INPUT>;

async function event(id: string, ev: string, detail: unknown = {}) {
  const eid = crypto.randomUUID();
  await getD1().prepare("INSERT INTO work_item_events (id,work_item_id,event,detail) VALUES (?,?,?,?)").bind(eid, id, ev, json(detail)).run();
  return eid;
}
export { event as workEvent };

/** Creates, re-scores or (when `reopen`) re-opens a work item. Returns its id and what happened. */
export async function proposeWork(raw: WorkItemInput): Promise<{ id: string; outcome: "created" | "rescored" | "reopened" | "unchanged" }> {
  assertExecutionAllowed("workitem.propose");
  const w = WORK_ITEM_INPUT.parse(raw);
  const db = getD1();
  const factors: Factors = { ...DEFAULT_FACTORS, ...(w.factors ?? {}) } as Factors;
  const priority = priorityOf(factors);
  const fp = w.fingerprint ?? `${w.kind}:${w.targetType}:${w.targetKey}`;
  const cur = await db.prepare("SELECT id,status,not_before FROM work_items WHERE fingerprint=?").bind(fp).first<Row>();
  if (!cur) {
    const id = crypto.randomUUID();
    const r = await db.prepare("INSERT OR IGNORE INTO work_items (id,kind,target_type,target_key,fingerprint,status,priority,factors,reason,source,module,campaign_id,investigation_id,gap_id,experiment_id,experiment_arm,not_before,max_attempts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, w.kind, w.targetType, w.targetKey, fp, HUMAN_KINDS.has(w.kind) ? "waiting_human" : factors.dup_prob >= 0.85 ? "suppressed" : "queued", priority, json(factors), w.reason.slice(0, 400), w.source, MODULE_OF[w.kind] ?? null,
        w.campaignId ?? null, w.investigationId ?? null, w.gapId ?? null, w.experimentId ?? null, w.experimentArm ?? null, w.notBefore ?? null, w.maxAttempts ?? 3).run();
    if ((r.meta?.changes ?? 0) === 1) { await event(id, "created", { source: w.source, reason: w.reason, priority }); return { id, outcome: "created" }; }
    const raced = await db.prepare("SELECT id FROM work_items WHERE fingerprint=?").bind(fp).first<Row>();
    return { id: String(raced?.id), outcome: "unchanged" };
  }
  const id = String(cur.id);
  if (["queued", "deferred", "suppressed"].includes(String(cur.status))) {
    await db.prepare("UPDATE work_items SET priority=?,factors=?,reason=?,status=CASE WHEN ?>=0.85 THEN 'suppressed' WHEN status='suppressed' THEN 'queued' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(priority, json(factors), w.reason.slice(0, 400), factors.dup_prob, id).run();
    return { id, outcome: "rescored" };
  }
  if (w.reopen && ["done", "failed", "cancelled"].includes(String(cur.status))) {
    await db.prepare("UPDATE work_items SET status=?,priority=?,factors=?,reason=?,source=?,attempts=0,last_error=NULL,job_id=NULL,run_id=NULL,lease_owner=NULL,lease_until=NULL,not_before=?,gap_id=COALESCE(?,gap_id),result='{}',updated_at=CURRENT_TIMESTAMP,finished_at=NULL WHERE id=?")
      .bind(HUMAN_KINDS.has(w.kind) ? "waiting_human" : "queued", priority, json(factors), w.reason.slice(0, 400), w.source, w.notBefore ?? null, w.gapId ?? null, id).run();
    await event(id, "reopened", { source: w.source, reason: w.reason });
    return { id, outcome: "reopened" };
  }
  return { id, outcome: "unchanged" };
}

export async function cancelWork(where: { gapId?: string; campaignId?: string; id?: string }, reason: string) {
  const db = getD1();
  const cond = where.id ? ["id=?", where.id] : where.gapId ? ["gap_id=?", where.gapId] : ["campaign_id=?", where.campaignId];
  const rows = (await db.prepare(`SELECT id FROM work_items WHERE ${cond[0]} AND status IN ('queued','deferred','suppressed')`).bind(cond[1]).all<Row>()).results;
  for (const r of rows) {
    await db.prepare("UPDATE work_items SET status='cancelled',result=?,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','deferred','suppressed')").bind(json({ cancelled: reason }), r.id).run();
    await event(String(r.id), "cancelled", { reason });
  }
  return rows.length;
}

export async function markWork(id: string, status: string, patch: { result?: unknown; error?: string; jobId?: string | null; runId?: string | null; notBefore?: string | null } = {}) {
  await getD1().prepare("UPDATE work_items SET status=?,result=COALESCE(?,result),last_error=COALESCE(?,last_error),job_id=COALESCE(?,job_id),run_id=COALESCE(?,run_id),not_before=COALESCE(?,not_before),lease_owner=NULL,lease_until=NULL,finished_at=CASE WHEN ? IN ('done','failed','cancelled') THEN CURRENT_TIMESTAMP ELSE finished_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(status, patch.result === undefined ? null : json(patch.result), patch.error ?? null, patch.jobId ?? null, patch.runId ?? null, patch.notBefore ?? null, status, id).run();
  return event(id, status, patch);
}

export async function workItemView(id: string) {
  const db = getD1();
  const w = await db.prepare("SELECT * FROM work_items WHERE id=?").bind(id).first<Row>();
  if (!w) return null;
  const events = (await db.prepare("SELECT event,detail,at FROM work_item_events WHERE work_item_id=? ORDER BY at, rowid").bind(id).all<Row>()).results;
  return { ...w, factors: parse(w.factors, {}), result: parse(w.result, {}), events: events.map(e => ({ ...e, detail: parse(e.detail, {}) })) };
}
