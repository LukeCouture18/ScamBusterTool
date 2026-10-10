/**
 * Read models for the UI. The simple view is what the investigation screen
 * shows: a status, one activity line, and the current human step if any. The
 * advanced view exposes the full audit trail (steps, rejections, budgets,
 * model calls, inferences, knowledge classes) for the expander.
 */
import { getD1 } from "../platform";
import { buildDigest, openQuestions } from "./state";
import { openCheckpoints } from "./checkpoints";

type Row = Record<string, unknown>;
function parse<T>(value: unknown, fallback: T): T { try { return typeof value === "string" ? JSON.parse(value) as T : (value as T) ?? fallback; } catch { return fallback; } }

const PHASE: Record<string, string> = {
  RUNNING: "AI investigating…", WAITING_FOR_MODULE: "Working…", WAITING_FOR_HUMAN: "Waiting for you",
  COMPLETE: "Investigation complete", INSUFFICIENT_EVIDENCE: "Not enough evidence", BUDGET_EXHAUSTED: "Budget reached",
  STOPPED: "Stopped", FAILED: "Investigator error", PAUSED: "Paused",
};

export async function investigationView(investigationId: string) {
  const db = getD1();
  const inv = await db.prepare("SELECT id,external_id,title FROM investigations WHERE id=? OR external_id=?").bind(investigationId, investigationId).first<Row>();
  if (!inv) return null;
  const id = String(inv.id);
  const run = await db.prepare("SELECT * FROM agent_runs WHERE investigation_id=? ORDER BY started_at DESC LIMIT 1").bind(id).first<Row>();
  const digest = await buildDigest(id);
  const checkpoints = await openCheckpoints(id);
  const activity = await db.prepare("SELECT step_no,kind,capability,rationale,outcome,validation,rejection_reasons,created_at,result FROM agent_steps WHERE run_id=? ORDER BY step_no DESC LIMIT 12")
    .bind(run?.id ?? "").all<Row>().catch(() => ({ results: [] as Row[] }));
  const stream = activity.results.map(s => ({
    step: Number(s.step_no), capability: s.capability ? String(s.capability) : null, validation: String(s.validation ?? ""),
    text: s.validation === "rejected" ? `Proposed action rejected: ${parse<string[]>(s.rejection_reasons, []).slice(0, 2).join("; ")}` : String(parse<Row>(s.result, {}).headline ?? s.rationale ?? s.capability ?? ""),
    outcome: s.outcome ? String(s.outcome) : null, at: String(s.created_at),
  })).reverse();
  const status = run ? String(run.status) : "none";
  return {
    investigation: { id, external_id: String(inv.external_id), title: String(inv.title ?? "") },
    status, phase: PHASE[status] ?? "Idle",
    headline: run ? String(run.headline ?? "") : "No AI investigation yet.",
    new_evidence: Boolean(run?.new_evidence),
    site: digest?.site ?? null,
    counts: digest ? { evidence: digest.evidence.meaningful, wallets: digest.wallets.length, wallets_analyzed: digest.progress.wallets_analyzed, related: digest.related.length } : null,
    waiting_for_human: checkpoints.map(c => ({ id: String(c.id), kind: String(c.kind), title: String(c.title), instructions: String(c.instructions), url: c.url ? String(c.url) : null })),
    activity: stream,
    open_questions: digest ? openQuestions(digest) : [],
    can_start: !run || ["COMPLETE", "INSUFFICIENT_EVIDENCE", "BUDGET_EXHAUSTED", "STOPPED", "FAILED"].includes(status),
  };
}

export async function investigationAdvanced(investigationId: string) {
  const db = getD1();
  const inv = await db.prepare("SELECT id FROM investigations WHERE id=? OR external_id=?").bind(investigationId, investigationId).first<{ id: string }>();
  if (!inv) return null;
  const run = await db.prepare("SELECT * FROM agent_runs WHERE investigation_id=? ORDER BY started_at DESC LIMIT 1").bind(inv.id).first<Row>();
  const digest = await buildDigest(inv.id);
  const steps = run ? (await db.prepare("SELECT step_no,kind,state,provider,model,model_class,validation,rejection_reasons,capability,arguments,rationale,outcome,job_id,checkpoint_id,expected_value,realized_value,evidence_before,evidence_after,triggering_evidence,prompt_tokens,completion_tokens,created_at FROM agent_steps WHERE run_id=? ORDER BY step_no").bind(run.id).all<Row>()).results : [];
  const inferences = run ? (await db.prepare("SELECT claim,entity_id,cited_evidence,status,created_at FROM agent_inferences WHERE run_id=? ORDER BY created_at").bind(run.id).all<Row>()).results : [];
  const modelCalls = run ? (await db.prepare("SELECT provider,model,model_class,status,latency_ms,prompt_tokens,completion_tokens,error,created_at FROM agent_model_calls WHERE run_id=? ORDER BY created_at").bind(run.id).all<Row>()).results : [];
  const conclusions = (await db.prepare("SELECT conclusion,cited_evidence,author,created_at FROM analyst_conclusions WHERE investigation_id=? ORDER BY created_at").bind(inv.id).all<Row>()).results;
  const budgets = run ? {
    actions: { used: Number(run.used_actions), max: Number(run.max_actions) }, module_calls: { used: Number(run.used_module_calls), max: Number(run.max_module_calls) },
    discovery_expansions: { used: Number(run.used_discovery_expansions), max: Number(run.max_discovery_expansions) }, model_calls: { used: Number(run.used_model_calls), max: Number(run.max_model_calls) },
    model_tokens: { used: Number(run.used_model_tokens), max: Number(run.max_model_tokens) }, retries: { used: Number(run.used_retries), max: Number(run.max_retries) }, deadline_at: run.deadline_at,
  } : null;
  return {
    run: run ? { id: run.id, status: run.status, provider: run.provider, started_by: run.started_by, headline: run.headline, started_at: run.started_at, finished_at: run.finished_at } : null,
    budgets,
    knowledge_classes: digest?.evidence.by_class ?? null,
    steps: steps.map(s => ({ ...s, arguments: parse<Row>(s.arguments, {}), rejection_reasons: parse<string[]>(s.rejection_reasons, []), triggering_evidence: parse<string[]>(s.triggering_evidence, []) })),
    inferences: inferences.map(i => ({ ...i, cited_evidence: parse<string[]>(i.cited_evidence, []) })),
    model_calls: modelCalls,
    analyst_conclusions: conclusions.map(c => ({ ...c, cited_evidence: parse<string[]>(c.cited_evidence, []) })),
    provenance_note: "Evidence rows are module observations. AI inferences are the model's opinions with citations and never become evidence. Analyst conclusions are yours.",
  };
}
