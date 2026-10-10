/**
 * The seams where the deterministic platform notifies the AI layer. Everything
 * here is best-effort and swallows its own errors: the AI layer must never
 * break ingestion, the planner, or a module job lifecycle. Callers use dynamic
 * import() to avoid a module cycle (events/jobs -> agent -> capabilities ->
 * events).
 */
import { getD1 } from "../platform";

/** A module produced evidence or a job finished: resolve any human step it satisfied and wake the run. */
export async function onInvestigationActivity(investigationId: string | null, reason: "evidence" | "job") {
  if (!investigationId) return;
  try {
    const id = await resolveId(investigationId); if (!id) return;
    await getD1().prepare("UPDATE agent_runs SET new_evidence=1,updated_at=CURRENT_TIMESTAMP WHERE investigation_id=? AND status IN ('WAITING_FOR_MODULE','WAITING_FOR_HUMAN','RUNNING')").bind(id).run();
    const { tryResolveFromEvidence } = await import("./checkpoints");
    await tryResolveFromEvidence(id);
    const { wake } = await import("./runner");
    await wake(id, reason);
  } catch { /* best-effort */ }
  try { const { wakeCampaigns } = await import("../campaign/campaign"); await wakeCampaigns({ investigationId }); } catch { /* v4 campaigns are best-effort here too */ }
  try {
    // v5: derive temporal facets (live/dead, deposit page, wallets) and re-evaluate evidence gaps.
    const id = await resolveId(investigationId); if (!id) return;
    const { observeInvestigation } = await import("../ops/temporal");
    const { evaluateGaps } = await import("../ops/gaps");
    await observeInvestigation(id);
    await evaluateGaps(id);
  } catch (error) { console.error("v5 observation after module activity failed", investigationId, error instanceof Error ? error.message : error); }
}

/** An inbox candidate was decided: record the Site Finder outcome, and on USEFUL start the investigator. */
export async function onInboxDecision(investigationId: string | null, domain: string, finderCandidateId: string | null, decision: "useful" | "skip", reason: string | null) {
  try {
    const { recordOutcome } = await import("./memory");
    await recordOutcome(domain, decision === "useful" ? "useful" : "skip", "human", investigationId, { reason }, finderCandidateId);
  } catch { /* best-effort */ }
  try { const { wakeCampaigns } = await import("../campaign/campaign"); await wakeCampaigns({ domain }); } catch { /* best-effort */ }
  if (decision !== "useful" || !investigationId) return;
  try {
    if ((await getD1().prepare("SELECT value FROM agent_settings WHERE key='auto_start_on_useful'").first<{ value: string }>())?.value === "false") return;
    if ((await getD1().prepare("SELECT value FROM agent_settings WHERE key='enabled'").first<{ value: string }>())?.value === "false") return;
    const { startRun, tick } = await import("./runner");
    const run = await startRun(investigationId, "inbox_useful");
    if (run && run.status === "RUNNING") await tick(run.id);
  } catch { /* best-effort */ }
}

async function resolveId(value: string) {
  const row = await getD1().prepare("SELECT id FROM investigations WHERE id=? OR external_id=? LIMIT 1").bind(value, value).first<{ id: string }>();
  return row?.id ?? null;
}
