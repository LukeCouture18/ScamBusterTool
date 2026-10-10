/**
 * The autonomous investigation loop.
 *
 * One tick = one step. A step: build the digest -> ask the planner (model, or
 * the rules planner on failure) -> validate deterministically -> execute the
 * one accepted action -> evaluate the change -> update budgets and run state.
 * The loop stops itself at COMPLETE, INSUFFICIENT_EVIDENCE, WAITING_FOR_HUMAN,
 * WAITING_FOR_MODULE, BUDGET_EXHAUSTED or STOPPED — never runs unbounded.
 *
 * Every step is leased and its effects are idempotent: a crash or restart
 * between steps re-runs the tick against current state without duplicating
 * work (module jobs dedupe by agent_step_id; fingerprints prevent repeats;
 * evaluation reads live counts). Restarting the platform never loses or
 * repeats autonomous work.
 *
 * Ticks are driven by worker.scheduled and by the module-job/event lifecycle
 * (a completed INVESTIGATE_SITE or ANALYZE_WALLET wakes its run), not by a
 * hot loop. `runToQuiescence` is for tests and the CLI.
 */
import { getD1, json, now } from "../platform";
import { deriveState } from "../planner";
import { timeline } from "../orchestrator";
import { selectProvider } from "../ai/models";
import { buildDigest, openQuestions, type Digest } from "./state";
import { validatePlan, type StepHistory, type Validation } from "./policy";
import { rulesPlan } from "./rules_planner";
import { modelPlan, recordModelCall } from "./model_planner";
import { CAPABILITY_BY_NAME, openCheckpoint, type Ctx, type ExecResult, type RunRow, type RunStatus } from "./capabilities";
import { syncFromDigest } from "./memory";
import { detectBarriers } from "./barriers";
import { assertExecutionAllowed } from "../ops/guard";

type Row = Record<string, unknown>;
const ACTIVE: RunStatus[] = ["RUNNING", "WAITING_FOR_MODULE", "WAITING_FOR_HUMAN", "PAUSED"];
const TERMINAL: RunStatus[] = ["COMPLETE", "INSUFFICIENT_EVIDENCE", "BUDGET_EXHAUSTED", "STOPPED", "FAILED"];

async function getSetting(key: string, fallback: string) {
  try { const r = await getD1().prepare("SELECT value FROM agent_settings WHERE key=?").bind(key).first<{ value: string }>(); return r?.value ?? fallback; } catch { return fallback; }
}
export async function agentEnabled() { return (await getSetting("enabled", "true")) === "true"; }

/** Starts (or returns) the single active run for an investigation. */
export async function startRun(investigationId: string, startedBy = "platform"): Promise<RunRow | null> {
  assertExecutionAllowed("agent.startRun");
  const db = getD1();
  const inv = await db.prepare("SELECT id FROM investigations WHERE id=? OR external_id=?").bind(investigationId, investigationId).first<{ id: string }>();
  if (!inv) return null;
  const existing = await db.prepare(`SELECT * FROM agent_runs WHERE investigation_id=? AND status IN (${ACTIVE.map(() => "?").join(",")})`).bind(inv.id, ...ACTIVE).first<RunRow>();
  if (existing) return existing;
  const num = async (k: string, d: number) => Number(await getSetting(k, String(d)));
  const [maxActions, maxDuration, maxDiscovery, maxModuleCalls, maxModelCalls, maxModelTokens, maxRetries, maxLowValue] = await Promise.all([
    num("max_actions", 12), num("max_duration_seconds", 21600), num("max_discovery_expansions", 1), num("max_module_calls", 8), num("max_model_calls", 24), num("max_model_tokens", 80000), num("max_retries", 3), num("max_low_value_steps", 3)]);
  const provider = selectProvider();
  const id = crypto.randomUUID();
  const deadline = new Date(Date.now() + maxDuration * 1000).toISOString();
  await db.prepare(`INSERT INTO agent_runs (id,investigation_id,status,headline,started_by,provider,max_actions,max_duration_seconds,max_discovery_expansions,max_module_calls,max_model_calls,max_model_tokens,max_retries,max_low_value_steps,deadline_at,next_run_at) VALUES (?,?,'RUNNING',?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .bind(id, inv.id, "Investigating…", startedBy, provider.name, maxActions, maxDuration, maxDiscovery, maxModuleCalls, maxModelCalls, maxModelTokens, maxRetries, maxLowValue, deadline).run();
  await timeline({ investigationId: inv.id, sourceModule: "platform", eventType: "agent.started", title: "AI investigator started", detail: provider.note, reason: `Started by ${startedBy}.` });
  return db.prepare("SELECT * FROM agent_runs WHERE id=?").bind(id).first<RunRow>();
}

async function history(runId: string): Promise<StepHistory> {
  const rows = await getD1().prepare("SELECT capability,validation,outcome,realized_value,fingerprint FROM agent_steps WHERE run_id=? ORDER BY step_no").bind(runId).all<Row>();
  return rows.results.map(r => ({ capability: r.capability ? String(r.capability) : null, validation: r.validation ? String(r.validation) : null, outcome: r.outcome ? String(r.outcome) : null, realized_value: r.realized_value == null ? null : Number(r.realized_value), fingerprint: r.fingerprint ? String(r.fingerprint) : null }));
}

async function finish(run: RunRow, status: RunStatus, headline: string) {
  await getD1().prepare("UPDATE agent_runs SET status=?,stop_reason=?,headline=?,finished_at=CURRENT_TIMESTAMP,lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(status, headline, headline, run.id).run();
  await timeline({ investigationId: run.investigation_id, sourceModule: "platform", eventType: `agent.${status.toLowerCase()}`, title: statusTitle(status), detail: headline });
}
function statusTitle(s: RunStatus) {
  return { COMPLETE: "Investigation complete", INSUFFICIENT_EVIDENCE: "Not enough evidence", BUDGET_EXHAUSTED: "Budget reached", STOPPED: "Investigation stopped", FAILED: "Investigator error", WAITING_FOR_HUMAN: "Waiting for you", WAITING_FOR_MODULE: "Working…", RUNNING: "Investigating…", PAUSED: "Paused" }[s] ?? s;
}

/** Deterministic pre-checks that run before any planning: barriers and budget ceilings. */
async function preflight(run: RunRow, digest: Digest): Promise<{ done: RunStatus; headline: string } | null> {
  const n = (k: string) => Number((run as Row)[k] ?? 0);
  if (new Date(String(run.deadline_at).replace(" ", "T") + (/[Z+-]\d*:?\d*$/.test(String(run.deadline_at).slice(-6)) ? "" : "Z")).getTime() < Date.now()) return { done: "BUDGET_EXHAUSTED", headline: "Time budget reached before finishing." };
  if (n("used_actions") >= n("max_actions")) return { done: "BUDGET_EXHAUSTED", headline: "Action budget reached." };
  // A newly observed barrier pauses for a person regardless of what a planner would say.
  const barrier = digest.barriers.find(b => !digest.checkpoints.some(c => c.kind === b.kind && c.status !== "cancelled"));
  if (barrier) {
    const id = await openCheckpoint(run, barrier.kind, "deterministic", barrier.evidence_ids, digest);
    await recordSystemStep(run, digest, `Observed a ${barrier.kind} barrier; pausing for you.`, "waiting", { checkpoint_id: id, kind: barrier.kind });
    return { done: "WAITING_FOR_HUMAN", headline: barrier.reason };
  }
  return null;
}

async function recordSystemStep(run: RunRow, digest: Digest, headline: string, outcome: string, result: Row) {
  const db = getD1();
  const stepNo = Number(run.last_step_no ?? 0) + 1;
  await db.batch([
    db.prepare("INSERT INTO agent_steps (id,run_id,investigation_id,step_no,kind,state,validation,rationale,outcome,result,evidence_before,evidence_after,completed_at) VALUES (?,?,?,?,'system','done','system',?,?,?,?,?,CURRENT_TIMESTAMP)")
      .bind(crypto.randomUUID(), run.id, run.investigation_id, stepNo, headline, outcome, json(result), digest.evidence.total, digest.evidence.total),
    db.prepare("UPDATE agent_runs SET last_step_no=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(stepNo, run.id),
  ]);
}

/** Runs one step. Returns the run's status after it. */
export async function tick(runId: string, owner = crypto.randomUUID()): Promise<{ status: RunStatus; headline: string; stepNo?: number }> {
  const db = getD1();
  // Lease the run so two ticks never run a step at once.
  const lease = new Date(Date.now() + 120000).toISOString();
  const claimed = await db.prepare("UPDATE agent_runs SET lease_owner=?,lease_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='RUNNING' AND (lease_until IS NULL OR lease_until<?)").bind(owner, lease, runId, now()).run();
  let run = await db.prepare("SELECT * FROM agent_runs WHERE id=?").bind(runId).first<RunRow>();
  if (!run) return { status: "FAILED", headline: "run not found" };
  if ((claimed.meta?.changes ?? 0) !== 1) return { status: run.status, headline: String(run.headline ?? "") };

  try {
    const digest = await buildDigest(run.investigation_id);
    if (!digest) { await finish(run, "FAILED", "Investigation vanished."); return { status: "FAILED", headline: "investigation missing" }; }

    const pre = await preflight(run, digest);
    if (pre) { await finish(run, pre.done, pre.headline); return { status: pre.done, headline: pre.headline }; }

    const hist = await history(run.id);
    const profile = String((await db.prepare("SELECT automation_profile_id FROM investigations WHERE id=?").bind(run.investigation_id).first<{ automation_profile_id: string }>())?.automation_profile_id ?? "standard-investigation");

    // Plan: model with bounded retries on rejection, then the rules planner.
    const provider = selectProvider();
    let validation: Validation | null = null;
    let planSource = "rules", modelMeta: { model: string; modelClass: string; raw: unknown; promptTokens: number; completionTokens: number } | null = null;
    const rejections: string[][] = [];
    if (provider.provider && Number(run.used_model_calls) < Number(run.max_model_calls) && Number(run.used_model_tokens) < Number(run.max_model_tokens)) {
      for (let attempt = 0; attempt <= Number(run.max_retries) && Number(run.used_model_calls) < Number(run.max_model_calls); attempt++) {
        const started = Date.now();
        try {
          const budget = Math.min(1500, Number(run.max_model_tokens) - Number(run.used_model_tokens));
          const p = await modelPlan(provider.provider, digest, profile, hist, rejections[rejections.length - 1] ?? [], budget);
          await recordModelCall(run.id, null, provider.name, p.model, p.modelClass, "ok", Date.now() - started, p.promptTokens, p.completionTokens);
          await db.prepare("UPDATE agent_runs SET used_model_calls=used_model_calls+1,used_model_tokens=used_model_tokens+? WHERE id=?").bind(p.promptTokens + p.completionTokens, run.id).run();
          run = await db.prepare("SELECT * FROM agent_runs WHERE id=?").bind(runId).first<RunRow>() as RunRow;
          const v = validatePlan(p.raw, { run, digest, profile, history: hist });
          modelMeta = { model: p.model, modelClass: p.modelClass, raw: p.raw, promptTokens: p.promptTokens, completionTokens: p.completionTokens };
          if (v.ok) { validation = v; planSource = provider.name; break; }
          rejections.push(v.reasons);
          await recordRejectedStep(run, digest, provider.name, modelMeta, v.reasons);
          run = await bumpRejection(run);
        } catch (error) {
          await recordModelCall(run.id, null, provider.name, provider.provider.model(attempt ? "deep" : "standard"), attempt ? "deep" : "standard", error instanceof Error && "kind" in error ? String((error as { kind: string }).kind) : "error", Date.now() - started, 0, 0, error instanceof Error ? error.message : String(error));
          await db.prepare("UPDATE agent_runs SET used_retries=used_retries+1,used_model_calls=used_model_calls+1 WHERE id=?").bind(run.id).run();
          run = await db.prepare("SELECT * FROM agent_runs WHERE id=?").bind(runId).first<RunRow>() as RunRow;
        }
      }
    }
    if (!validation) {
      const v = validatePlan(rulesPlan(digest, run), { run, digest, profile, history: hist });
      if (!v.ok) {
        // The rules planner should always yield a valid plan; if not, wait rather than loop.
        await releaseLease(run.id);
        await db.prepare("UPDATE agent_runs SET status='WAITING_FOR_MODULE',headline=?,next_run_at=datetime('now','+120 seconds'),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind("Waiting before the next step.", run.id).run();
        return { status: "WAITING_FOR_MODULE", headline: "waiting" };
      }
      validation = v; planSource = provider.provider ? "rules-fallback" : "rules";
    }

    const result = await executeStep(run, digest, validation, planSource, modelMeta);
    return result;
  } catch (error) {
    await db.prepare("UPDATE agent_runs SET lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(run.id).run();
    // A tick failure is not fatal to the run: record and let it be retried, up to a bound.
    const fails = Number(run.consecutive_rejections ?? 0) + 1;
    if (fails >= Number(run.max_retries) + 3) { await finish(run, "FAILED", error instanceof Error ? error.message.slice(0, 200) : "investigator error"); return { status: "FAILED", headline: "investigator error" }; }
    await db.prepare("UPDATE agent_runs SET next_run_at=datetime('now','+60 seconds'),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(run.id).run();
    return { status: "RUNNING", headline: "retrying after error" };
  }
}

async function bumpRejection(run: RunRow) {
  await getD1().prepare("UPDATE agent_runs SET consecutive_rejections=consecutive_rejections+1 WHERE id=?").bind(run.id).run();
  return await getD1().prepare("SELECT * FROM agent_runs WHERE id=?").bind(run.id).first<RunRow>() as RunRow;
}
async function releaseLease(runId: string) { await getD1().prepare("UPDATE agent_runs SET lease_owner=NULL,lease_until=NULL WHERE id=?").bind(runId).run(); }

async function recordRejectedStep(run: RunRow, digest: Digest, provider: string, meta: { model: string; modelClass: string; raw: unknown; promptTokens: number; completionTokens: number }, reasons: string[]) {
  const db = getD1(); const stepNo = Number(run.last_step_no ?? 0) + 1;
  const raw = meta.raw as Row | undefined;
  await db.batch([
    db.prepare("INSERT INTO agent_steps (id,run_id,investigation_id,step_no,kind,state,provider,model,model_class,prompt_tokens,completion_tokens,raw_output,validation,rejection_reasons,capability,arguments,rationale,outcome,evidence_before,evidence_after,realized_value,completed_at) VALUES (?,?,?,?,'plan','done',?,?,?,?,?,?,'rejected',?,?,?,?,'rejected',?,?,0,CURRENT_TIMESTAMP)")
      .bind(crypto.randomUUID(), run.id, run.investigation_id, stepNo, provider, meta.model, meta.modelClass, meta.promptTokens, meta.completionTokens, json(meta.raw).slice(0, 8000), json(reasons),
        raw && typeof raw.action === "object" ? String((raw.action as Row).capability ?? "") : "", raw && typeof raw.action === "object" ? json((raw.action as Row).arguments) : "{}",
        raw ? String(raw.rationale ?? "").slice(0, 600) : "", digest.evidence.total, digest.evidence.total),
    db.prepare("UPDATE agent_runs SET last_step_no=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(stepNo, run.id),
  ]);
  await timeline({ investigationId: run.investigation_id, sourceModule: "platform", eventType: "agent.rejected", title: "AI action rejected", detail: reasons.slice(0, 3).join("; "), severity: "warning", data: { step: stepNo } });
}

async function executeStep(run: RunRow, digest: Digest, v: Extract<Validation, { ok: true }>, planSource: string, meta: { model: string; modelClass: string; raw: unknown; promptTokens: number; completionTokens: number } | null) {
  const db = getD1(); const stepNo = Number(run.last_step_no ?? 0) + 1;
  const stepId = crypto.randomUUID();
  const capability = v.capability;
  // Claim the step row with its fingerprint; the unique index blocks a duplicate accepted action even under a race.
  try {
    await db.prepare("INSERT INTO agent_steps (id,run_id,investigation_id,step_no,kind,state,provider,model,model_class,prompt_tokens,completion_tokens,raw_output,validation,capability,arguments,fingerprint,triggering_evidence,expected_value,rationale,evidence_before) VALUES (?,?,?,?,'plan','executing',?,?,?,?,?,?,'accepted',?,?,?,?,?,?,?)")
      .bind(stepId, run.id, run.investigation_id, stepNo, planSource, meta?.model ?? null, meta?.modelClass ?? null, meta?.promptTokens ?? 0, meta?.completionTokens ?? 0, meta ? json(meta.raw).slice(0, 8000) : null,
        capability.name, json(v.args), v.fingerprint, json(v.plan.triggering_evidence), v.plan.expected_value, v.plan.rationale.slice(0, 600), digest.evidence.total).run();
  } catch {
    await releaseLease(run.id);
    return { status: run.status, headline: "duplicate step skipped" };
  }
  await db.prepare("UPDATE agent_runs SET last_step_no=? WHERE id=?").bind(stepNo, run.id).run();

  // Record inferences (validated citations only) — never as evidence.
  for (const inf of v.plan.inferences)
    await db.prepare("INSERT INTO agent_inferences (id,investigation_id,run_id,step_id,claim,entity_id,cited_evidence) VALUES (?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), run.investigation_id, run.id, stepId, inf.claim.slice(0, 300), inf.entity_id ?? null, json(inf.cited_evidence)).run();

  const ctx: Ctx = { run, stepId, stepNo, digest, rationale: v.plan.rationale, triggeringEvidence: v.plan.triggering_evidence };
  let exec: ExecResult;
  try { exec = await capability.execute(v.args, ctx); }
  catch (error) {
    await db.prepare("UPDATE agent_steps SET state='done',outcome='error',result=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").bind(json({ error: error instanceof Error ? error.message : String(error) }), stepId).run();
    await db.prepare("UPDATE agent_steps SET fingerprint=NULL WHERE id=?").bind(stepId).run();
    throw error;
  }

  // Evaluate: did evidence change? Record realized value and update budgets.
  const after = await buildDigest(run.investigation_id) ?? digest;
  const evidenceGain = after.evidence.total - digest.evidence.total;
  const meaningfulGain = after.evidence.meaningful - digest.evidence.meaningful;
  const realized = exec.outcome === "concluded" ? 1 : exec.outcome === "waiting" ? 0.5 : exec.outcome === "queued" ? 0.5
    : meaningfulGain > 0 ? 1 : exec.informative ? 0.5 : evidenceGain > 0 ? 0.4 : 0;
  const lowValue = realized <= 0 && !["queued", "waiting", "concluded"].includes(exec.outcome);
  if (exec.releaseFingerprint) await db.prepare("UPDATE agent_steps SET fingerprint=NULL WHERE id=?").bind(stepId).run();
  await db.prepare("UPDATE agent_steps SET state='done',outcome=?,job_id=?,checkpoint_id=?,result=?,evidence_after=?,realized_value=?,completed_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(exec.outcome, exec.jobId ?? null, exec.checkpointId ?? null, json({ headline: exec.headline, ...(exec.result && typeof exec.result === "object" ? exec.result as Record<string, unknown> : { value: exec.result }) }), after.evidence.total, realized, stepId).run();

  await db.prepare(`UPDATE agent_runs SET used_actions=used_actions+1,used_module_calls=used_module_calls+?,used_discovery_expansions=used_discovery_expansions+?,consecutive_rejections=0,consecutive_low_value=CASE WHEN ? THEN consecutive_low_value+1 ELSE 0 END,new_evidence=0,evidence_seen=?,headline=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(exec.moduleCall ? 1 : 0, exec.discovery ? 1 : 0, lowValue ? 1 : 0, after.evidence.total, exec.headline.slice(0, 200), run.id).run();
  run = await db.prepare("SELECT * FROM agent_runs WHERE id=?").bind(run.id).first<RunRow>() as RunRow;

  await timeline({ investigationId: run.investigation_id, entityId: after.site?.entity_id ?? null, sourceModule: "platform", eventType: `agent.${capability.name}`, title: exec.headline, detail: v.plan.rationale.slice(0, 200), reason: `AI investigator step ${stepNo} (${planSource}).`, data: { step: stepNo, outcome: exec.outcome, job_id: exec.jobId } });
  await syncFromDigest(after).catch(() => {});

  // Decide the run's next state.
  let status: RunStatus = "RUNNING";
  let headline = exec.headline;
  if (exec.status) status = exec.status;
  else if (exec.outcome === "concluded") status = (v.args.status as RunStatus);
  else if (after.in_flight.length) { status = "WAITING_FOR_MODULE"; headline = "Working…"; }
  else if (Number(run.consecutive_low_value) >= Number(run.max_low_value_steps)) { status = "INSUFFICIENT_EVIDENCE"; headline = "Repeated low-value steps; stopping."; }
  else if (Number(run.used_actions) >= Number(run.max_actions)) { status = "BUDGET_EXHAUSTED"; headline = "Action budget reached."; }

  if (TERMINAL.includes(status)) { await finish(run, status, headline); await syncFromDigest(after, status).catch(() => {}); }
  else if (status === "WAITING_FOR_HUMAN") await db.prepare("UPDATE agent_runs SET status='WAITING_FOR_HUMAN',headline=?,lease_owner=NULL,lease_until=NULL,next_run_at=datetime('now','+3650 days'),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(headline, run.id).run();
  else if (status === "WAITING_FOR_MODULE") await db.prepare("UPDATE agent_runs SET status='WAITING_FOR_MODULE',headline=?,lease_owner=NULL,lease_until=NULL,next_run_at=datetime('now','+900 seconds'),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(headline, run.id).run();
  else await db.prepare("UPDATE agent_runs SET status='RUNNING',headline=?,lease_owner=NULL,lease_until=NULL,next_run_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(headline, run.id).run();
  await deriveState(run.investigation_id).catch(() => {});
  return { status, headline, stepNo };
}

/**
 * Wakes a run that was waiting on a module job or a human step, when the thing
 * it waited for has happened. Called from the job/event lifecycle and the
 * checkpoint-resolve route. Never advances a run that is genuinely still
 * waiting; that would let a stalled module spin the loop.
 */
export async function wake(investigationId: string, reason: string) {
  const db = getD1();
  const run = await db.prepare(`SELECT * FROM agent_runs WHERE investigation_id=? AND status IN ('WAITING_FOR_MODULE','WAITING_FOR_HUMAN','RUNNING') ORDER BY started_at DESC LIMIT 1`).bind(investigationId).first<RunRow>();
  if (!run) return null;
  const digest = await buildDigest(investigationId); if (!digest) return null;
  if (run.status === "WAITING_FOR_MODULE" && digest.in_flight.length && reason !== "job") return run.status;
  if (run.status === "WAITING_FOR_HUMAN") {
    const open = digest.checkpoints.some(c => c.status === "open");
    if (open) return run.status;                       // still blocked
  }
  await db.prepare("UPDATE agent_runs SET status='RUNNING',next_run_at=CURRENT_TIMESTAMP,lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('WAITING_FOR_MODULE','WAITING_FOR_HUMAN')").bind(run.id).run();
  return "RUNNING";
}

/** Runs due steps across all active runs, oldest first. Called by worker.scheduled. */
export async function tickDueRuns(limit = 10) {
  if (!(await agentEnabled())) return { ticked: 0 };
  const due = await getD1().prepare("SELECT id FROM agent_runs WHERE status='RUNNING' AND next_run_at<=CURRENT_TIMESTAMP AND (lease_until IS NULL OR lease_until<?) ORDER BY next_run_at LIMIT ?").bind(now(), limit).all<{ id: string }>();
  let ticked = 0;
  for (const r of due.results) { await tick(r.id); ticked++; }
  return { ticked };
}

/** For tests and the CLI: tick one run until it leaves RUNNING (bounded by max_actions+slack). */
export async function runToQuiescence(runId: string, maxTicks = 40): Promise<{ status: RunStatus; steps: number }> {
  for (let i = 0; i < maxTicks; i++) {
    const r = await tick(runId);
    if (r.status !== "RUNNING") return { status: r.status, steps: i + 1 };
  }
  const run = await getD1().prepare("SELECT status FROM agent_runs WHERE id=?").bind(runId).first<{ status: RunStatus }>();
  return { status: run?.status ?? "FAILED", steps: maxTicks };
}

export { detectBarriers, openQuestions };
