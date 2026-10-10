/**
 * Model-assisted roles, all optional and all untrusted.
 *
 * The campaign runs completely without a model: the Researcher, Strategist,
 * Planner, Analyst and Reviewer each have a deterministic implementation. A
 * model is consulted only where judgment can help and only when it is cheap
 * enough:
 *
 *   Planner      when the top opportunities are within 10% of each other, a
 *                fast-class model may pick one of them — by id, from the list
 *                it was shown. Anything else falls back to the deterministic top.
 *   Strategist   when the graph gained new observed structure, a model may
 *                propose hypotheses; each must cite existing edges and pass the
 *                same validator as deterministic ones.
 *   Reviewer     may add a rejection (from a fixed code list). Never approve.
 *
 * Roles exchange typed artifacts (zod schemas below). A model never receives
 * raw graphs — only the structured summary — and nothing it returns is executed
 * except by selecting an existing, validated, reviewed opportunity.
 */
import { z } from "zod";
import { getD1, json } from "../platform";
import { type ModelClass } from "../ai/models";
import { routedComplete, providerChain } from "../ai/router";
import { recordDecision, updateDecision } from "../ops/decisions";
import { proposeHypothesis } from "./hypotheses";
import { MODEL_REJECTION_CODES } from "./reviewer";
import type { GraphSummary } from "./graph";

type Row = Record<string, unknown>;
export const CLOSE_CALL = 0.10;

export const PLANNER_CHOICE = z.object({ opportunity_id: z.string().min(1).max(64), rationale: z.string().max(300) }).strict();
export const STRATEGIST_PROPOSALS = z.object({ hypotheses: z.array(z.unknown()).max(3) }).strict();
export const REVIEWER_CRITIQUE = z.object({ reject: z.boolean(), code: z.enum(MODEL_REJECTION_CODES).optional() }).strict();

export const ARTIFACT_SCHEMAS = {
  brief: z.object({ members: z.number(), edges: z.number(), new_members: z.number(), repeated_indicators: z.number(), recurring_wallets: z.number(), convergence: z.number(), unexplored_hubs: z.array(z.string()), isolated_claims: z.number() }).strict(),
  pivots: z.object({ created: z.array(z.string()), model_proposed: z.number(), model_rejected: z.array(z.string()) }).strict(),
  proposal: z.object({ opportunity_id: z.string(), kind: z.string(), target: z.string(), priority: z.number(), chosen_by: z.enum(["deterministic", "model"]), alternatives: z.array(z.string()), model_note: z.string().optional() }).strict(),
  review: z.object({ opportunity_id: z.string(), verdict: z.enum(["approve", "defer", "reject"]), reasons: z.array(z.string()), checks: z.array(z.object({ question: z.string(), pass: z.boolean(), note: z.string(), defer: z.boolean().optional() }).strict()), model_added: z.string().optional() }).strict(),
  analysis: z.object({ runs_finished: z.number(), pivots_evaluated: z.number(), hypotheses_changed: z.number(), experience_recorded: z.number(), members_waiting_human: z.number() }).strict(),
} as const;
export type ArtifactKind = keyof typeof ARTIFACT_SCHEMAS;
const ROLE_OF: Record<ArtifactKind, string> = { brief: "researcher", pivots: "strategist", proposal: "planner", review: "reviewer", analysis: "analyst" };

/** Writes a typed artifact; a body that does not match its schema is refused. */
export async function writeArtifact(campaignId: string, tick: number, kind: ArtifactKind, body: unknown, model: string | null = null) {
  const parsed = ARTIFACT_SCHEMAS[kind].safeParse(body);
  if (!parsed.success) throw new Error(`ARTIFACT_INVALID:${kind}`);
  await getD1().prepare("INSERT INTO campaign_artifacts (id,campaign_id,tick,role,kind,body,model) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(), campaignId, tick, ROLE_OF[kind], kind, json(parsed.data), model).run();
  return parsed.data;
}

type Budget = { calls: number; maxCalls: number; tokens: number; maxTokens: number };
export async function budgetOf(campaignId: string): Promise<Budget> {
  const c = await getD1().prepare("SELECT used_model_calls,max_model_calls,used_model_tokens,max_model_tokens FROM campaigns WHERE id=?").bind(campaignId).first<Row>();
  return { calls: Number(c?.used_model_calls ?? 0), maxCalls: Number(c?.max_model_calls ?? 0), tokens: Number(c?.used_model_tokens ?? 0), maxTokens: Number(c?.max_model_tokens ?? 0) };
}
const affordable = (b: Budget, tokens: number) => b.calls < b.maxCalls && b.tokens + tokens <= b.maxTokens;

/** One bounded model call, recorded as a campaign cost whether it succeeds or fails. */
const ROLE_TASK: Record<string, string> = { planner: "planner_choice", strategist: "hypothesis_proposal", reviewer: "review_critique" };

/**
 * One bounded model call through the v5 router (tiering, provider fallback,
 * global/provider budgets, telemetry), recorded as a replayable AI decision and
 * charged to the campaign whether it succeeds or fails. The campaign's own
 * model budget is checked first, as in v4.
 */
async function ask(campaignId: string, role: string, modelClass: ModelClass, system: string, prompt: unknown, maxTokens: number, schema: unknown = {}): Promise<{ raw: unknown; model: string; decisionId: string } | null> {
  if (!providerChain().length) return null;
  const b = await budgetOf(campaignId);
  if (!affordable(b, maxTokens)) return null;
  const db = getD1(); const ref = crypto.randomUUID();
  const promptText = JSON.stringify(prompt);
  const decisionId = await recordDecision({ scope: "campaign", subjectId: campaignId, role, task: ROLE_TASK[role] ?? role,
    visibleState: { system, prompt: promptText, campaign_id: campaignId, options: (prompt as Row)?.options ?? null }, capabilitySchema: schema });
  const res = await routedComplete({ task: ROLE_TASK[role] ?? role, system, prompt: promptText, maxTokens, tierOverride: modelClass, decisionId });
  if ("skipped" in res) {
    if (res.attempted) await db.batch([
      db.prepare("UPDATE campaigns SET used_model_calls=used_model_calls+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(campaignId),
      db.prepare("INSERT OR IGNORE INTO campaign_costs (id,campaign_id,kind,units,tokens,provider,ref) VALUES (?,?,'model_call',1,0,?,?)").bind(crypto.randomUUID(), campaignId, `router:error:${role}`, ref),
    ]);
    await updateDecision(decisionId, { policy: { fallback: "deterministic", reason: res.skipped } });
    return null;
  }
  const tokens = res.promptTokens + res.completionTokens;
  await db.batch([
    db.prepare("UPDATE campaigns SET used_model_calls=used_model_calls+1,used_model_tokens=used_model_tokens+?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(tokens, campaignId),
    db.prepare("INSERT OR IGNORE INTO campaign_costs (id,campaign_id,kind,units,tokens,provider,ref) VALUES (?,?,'model_call',1,?,?,?)").bind(crypto.randomUUID(), campaignId, tokens, `${res.provider}:${res.model}:${role}`, ref),
    db.prepare("UPDATE ai_decisions SET provider=?,model=?,proposal=? WHERE id=?").bind(res.provider, res.model, JSON.stringify(res.parsed ?? null), decisionId),
  ]);
  return { raw: res.parsed, model: res.model, decisionId };
}
export async function planChoice(campaignId: string, queue: Row[]): Promise<{ op: Row; chosenBy: "deterministic" | "model"; note?: string }> {
  const top = queue[0];
  const close = queue.filter(o => Number(top.priority) - Number(o.priority) <= Math.abs(Number(top.priority)) * CLOSE_CALL).slice(0, 3);
  if (close.length < 2) return { op: top, chosenBy: "deterministic" };
  const shown = close.map(o => ({ id: o.id, kind: o.kind, target: o.target_key, priority: o.priority, reason: o.reason }));
  const res = await ask(campaignId, "planner", "fast", "You choose the most valuable next investigation work from a short list. Reply with JSON {\"opportunity_id\": one id from the list, \"rationale\": short plain text}. You cannot add work.", { options: shown }, 300, { opportunity_id: "one of the offered ids", rationale: "plain text <=300" });
  if (!res) return { op: top, chosenBy: "deterministic", note: "model unavailable; deterministic top" };
  const p = PLANNER_CHOICE.safeParse(res.raw);
  if (!p.success) { await updateDecision(res.decisionId, { policy: { rejected: "not a valid choice object" }, accepted: false }); return { op: top, chosenBy: "deterministic", note: "model reply rejected: not a valid choice object" }; }
  const chosen = close.find(o => o.id === p.data.opportunity_id);
  if (!chosen) { await updateDecision(res.decisionId, { policy: { rejected: "chose an opportunity that was not offered" }, accepted: false }); return { op: top, chosenBy: "deterministic", note: "model chose an opportunity that was not offered; ignored" }; }
  await updateDecision(res.decisionId, { policy: { accepted: "choice was among the offered, already-validated opportunities" }, accepted: true });
  return { op: chosen, chosenBy: "model", note: p.data.rationale.replace(/https?:\/\/\S+/g, "").slice(0, 200) };
}

/** Strategist (model half): propose hypotheses from the summary; each is validated like a deterministic one. */
export async function modelHypotheses(campaignId: string, summary: GraphSummary) {
  const rejected: string[] = []; let proposed = 0;
  const view = { repeated_indicators: summary.repeated_indicators.map(r => ({ target: r.key, sites: r.sites.length, edge_ids: r.edge_ids.slice(0, 8) })), kits: summary.kits.filter(k => k.sites.length >= 2).map(k => ({ target: `kit:${k.kit}`, sites: k.sites.length, edge_ids: k.edge_ids.slice(0, 8) })), recurring_wallets: summary.recurring_wallets.map(w => ({ target: `wallet:${w.wallet}`, sites: w.sites.length, edge_ids: w.edge_ids.slice(0, 8) })) };
  const res = await ask(campaignId, "strategist", "fast", "Propose up to 3 disprovable hypotheses about where related sites may be found. JSON {\"hypotheses\":[{\"observation_refs\":[edge ids from the input],\"statement\":plain text,\"test_target\":one target from the input}]}. Cite only the given edge ids.", view, 600);
  if (!res) return { proposed, rejected, created: [] as string[] };
  const env = STRATEGIST_PROPOSALS.safeParse(res.raw);
  if (!env.success) return { proposed, rejected: ["reply was not {hypotheses:[...]}"], created: [] as string[] };
  const created: string[] = [];
  for (const h of env.data.hypotheses) {
    proposed++;
    const r = await proposeHypothesis(campaignId, h, "model");
    if (r.ok) created.push(r.id); else rejected.push(r.reasons.join("; ").slice(0, 300));
  }
  await updateDecision(res.decisionId, { policy: { created: created.length, rejected }, accepted: created.length > 0 });
  return { proposed, rejected, created };
}

/** Reviewer (model half): may only add a rejection. */
export async function modelCritique(campaignId: string, op: Row, checks: unknown): Promise<string | null> {
  const res = await ask(campaignId, "reviewer", "fast", "You review a proposed investigation action. If it should NOT run, reply {\"reject\":true,\"code\":one of " + JSON.stringify(MODEL_REJECTION_CODES) + "}; otherwise {\"reject\":false}.", { action: { kind: op.kind, target: op.target_key, reason: op.reason }, checks }, 120);
  if (!res) return null;
  const p = REVIEWER_CRITIQUE.safeParse(res.raw);
  if (!p.success || !p.data.reject || !p.data.code) { await updateDecision(res.decisionId, { policy: { added_rejection: false } }); return null; }
  await updateDecision(res.decisionId, { policy: { added_rejection: p.data.code }, accepted: true });
  return p.data.code;
}
