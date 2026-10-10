/**
 * Reproducible AI decisions and developer replay.
 *
 * Every model-assisted decision stores what the model could see (the exact
 * system and prompt text, the options it was offered), the evidence it could
 * cite, the capability schema its answer had to match, the provider and model,
 * the raw structured proposal, the deterministic policy decision, and the work
 * item / job that resulted and its outcome.
 *
 * `replayDecision` re-asks a different provider or tier the same question and
 * runs the same validator, inside `withoutExecution`: it can compare answers
 * but can never create work, jobs, runs, edges or hypotheses. Replay calls are
 * marked `is_replay` and are not charged to operational budgets.
 */
import { z } from "zod";
import { getD1 } from "../platform";
import { routedComplete } from "../ai/router";
import { withoutExecution } from "./guard";
import { hash, json, parse, type Row } from "./common";
import type { ModelClass } from "../ai/models";

export type DecisionRecord = {
  scope: "global" | "campaign" | "investigation" | "command"; subjectId?: string | null; role: string; task: string;
  visibleState: { system: string; prompt: string; options?: unknown; [k: string]: unknown }; evidenceRefs?: string[]; capabilitySchema: unknown;
  provider?: string | null; model?: string | null; proposal?: unknown; policy?: unknown; accepted?: boolean; workItemId?: string | null; jobId?: string | null; replayOf?: string | null; isReplay?: boolean;
};

export async function recordDecision(d: DecisionRecord) {
  const id = crypto.randomUUID();
  const schema = json(d.capabilitySchema);
  await getD1().prepare("INSERT INTO ai_decisions (id,scope,subject_id,role,task,visible_state,evidence_refs,capability_schema,schema_hash,provider,model,proposal,policy_decision,accepted,work_item_id,job_id,replay_of,is_replay) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, d.scope, d.subjectId ?? null, d.role, d.task, json(d.visibleState), json(d.evidenceRefs ?? []), schema, await hash(schema), d.provider ?? null, d.model ?? null,
      d.proposal === undefined ? null : json(d.proposal), json(d.policy ?? {}), d.accepted ? 1 : 0, d.workItemId ?? null, d.jobId ?? null, d.replayOf ?? null, d.isReplay ? 1 : 0).run();
  return id;
}

export async function updateDecision(id: string, patch: { policy?: unknown; accepted?: boolean; workItemId?: string | null; jobId?: string | null; result?: unknown }) {
  await getD1().prepare("UPDATE ai_decisions SET policy_decision=COALESCE(?,policy_decision),accepted=COALESCE(?,accepted),work_item_id=COALESCE(?,work_item_id),job_id=COALESCE(?,job_id),result=COALESCE(?,result) WHERE id=?")
    .bind(patch.policy === undefined ? null : json(patch.policy), patch.accepted === undefined ? null : (patch.accepted ? 1 : 0), patch.workItemId ?? null, patch.jobId ?? null, patch.result === undefined ? null : json(patch.result), id).run();
}

/**
 * Pure validators per task: the same checks the live path applies, with no
 * side effects. Replay uses them to say what the policy would have done.
 */
const VALIDATORS: Record<string, (proposal: unknown, state: Row) => Promise<{ ok: boolean; reasons: string[] }>> = {
  planner_choice: async (p, state) => {
    const r = z.object({ opportunity_id: z.string().min(1).max(64), rationale: z.string().max(300) }).strict().safeParse(p);
    if (!r.success) return { ok: false, reasons: ["not a valid choice object"] };
    const ids = parse<Array<{ id: string }>>(state.options, []).map(o => String(o.id));
    return ids.includes(r.data.opportunity_id) ? { ok: true, reasons: [] } : { ok: false, reasons: ["chose an opportunity that was not offered"] };
  },
  hypothesis_proposal: async (p, state) => {
    const env = z.object({ hypotheses: z.array(z.unknown()).max(3) }).strict().safeParse(p);
    if (!env.success) return { ok: false, reasons: ["reply was not {hypotheses:[...]}"] };
    const { validateHypothesis } = await import("../campaign/hypotheses");
    const reasons: string[] = [];
    for (const h of env.data.hypotheses) { const v = await validateHypothesis(String(state.campaign_id), h); if (!v.ok) reasons.push(v.reasons.join("; ")); }
    return { ok: reasons.length < env.data.hypotheses.length || env.data.hypotheses.length === 0, reasons };
  },
  review_critique: async p => {
    const r = z.object({ reject: z.boolean(), code: z.string().optional() }).strict().safeParse(p);
    return r.success ? { ok: true, reasons: [] } : { ok: false, reasons: ["not a valid critique object"] };
  },
  command_parse: async p => {
    const { COMMAND_SCHEMA } = await import("./commands");
    const r = COMMAND_SCHEMA.safeParse(p);
    return r.success ? { ok: true, reasons: [] } : { ok: false, reasons: r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) };
  },
};

export async function replayDecision(id: string, opts: { provider?: string; tier?: ModelClass } = {}) {
  const db = getD1();
  const d = await db.prepare("SELECT * FROM ai_decisions WHERE id=?").bind(id).first<Row>();
  if (!d) throw new Error("DECISION_NOT_FOUND");
  const state = parse<Row>(d.visible_state, {});
  const validator = VALIDATORS[String(d.task)];
  const { value } = await withoutExecution(`replay of decision ${id}`, async () => {
    const res = await routedComplete({ task: String(d.task), system: String(state.system ?? ""), prompt: String(state.prompt ?? ""), maxTokens: 600, provider: opts.provider, tierOverride: opts.tier, replay: true });
    if ("skipped" in res) return { skipped: res.skipped };
    const verdict = validator ? await validator(res.parsed, state) : { ok: false, reasons: ["no validator for this task"] };
    return { provider: res.provider, model: res.model, tier: res.tier, proposal: res.parsed, verdict, tokens: res.promptTokens + res.completionTokens, cost_usd: res.costUsd };
  });
  const out = value as Row;
  const replayId = await recordDecision({ scope: d.scope as DecisionRecord["scope"], subjectId: d.subject_id ? String(d.subject_id) : null, role: String(d.role), task: String(d.task),
    visibleState: state as DecisionRecord["visibleState"], evidenceRefs: parse<string[]>(d.evidence_refs, []), capabilitySchema: parse(d.capability_schema, {}),
    provider: out.provider ? String(out.provider) : null, model: out.model ? String(out.model) : null, proposal: out.proposal, policy: { would_accept: (out.verdict as Row | undefined)?.ok ?? false, reasons: (out.verdict as Row | undefined)?.reasons ?? [out.skipped] }, replayOf: id, isReplay: true });
  const original = { provider: d.provider, model: d.model, proposal: parse(d.proposal, null), policy: parse(d.policy_decision, {}), accepted: Number(d.accepted) === 1 };
  return { replay_id: replayId, executed_nothing: true, original, replay: out, same_proposal: JSON.stringify(original.proposal) === JSON.stringify(out.proposal ?? null) };
}

export async function decisionView(id: string) {
  const db = getD1();
  const d = await db.prepare("SELECT * FROM ai_decisions WHERE id=?").bind(id).first<Row>();
  if (!d) return null;
  const calls = (await db.prepare("SELECT provider,model,tier,status,latency_ms,prompt_tokens,completion_tokens,cost_usd,useful FROM model_invocations WHERE decision_id=?").bind(id).all<Row>()).results;
  const replays = (await db.prepare("SELECT id,provider,model,proposal,policy_decision,created_at FROM ai_decisions WHERE replay_of=? ORDER BY created_at").bind(id).all<Row>()).results;
  return { ...d, visible_state: parse(d.visible_state, {}), evidence_refs: parse(d.evidence_refs, []), capability_schema: parse(d.capability_schema, {}), proposal: parse(d.proposal, null),
    policy_decision: parse(d.policy_decision, {}), result: parse(d.result, {}), model_calls: calls, replays: replays.map(r => ({ ...r, proposal: parse(r.proposal, null), policy_decision: parse(r.policy_decision, {}) })) };
}
