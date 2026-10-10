/**
 * The v5 executor: turns one approved work item into work on EXISTING machinery.
 * It adds no new way to touch a site:
 *
 *   investigate_candidate            the v3 AI investigator (startRun + tick)
 *   revisit_changed_site/_incomplete a RECHECK_SITE job for Site Investigator (read-only)
 *   analyze_wallet                   an ANALYZE_WALLET job for Wallet Investigator (read-only chain data)
 *   inspect_infrastructure           a passive Site Finder pivot (FIND_RELATED_SITES with `pivot`)
 *   discovery_cycle                  a bounded DISCOVER_SITES request to Site Finder
 *   campaign_step                    one leased v4 campaign tick
 *   expand_campaign                  raises a campaign's discovery allowance by a bounded step
 *   compare_clusters                 a read-only comparison (may propose a merge)
 *   form/merge/split_campaign        lib/ops/formation (graph-validated)
 *   draft_report                     a frozen reporting candidate awaiting human approval
 *   review_contradiction             never executed: a person decides
 *   find_related_sites               a FIND_RELATED_SITES job carrying seed sites (an evidence gap from Hunter
 *                                    or an analyst); Site Finder pivots from them
 *   reconstruct_operation            a HUNT_OPERATION job for Operation Hunter (passive reconstruction; Hunter
 *                                    reports back through /api/v1/operations/sync and Main turns its proposals
 *                                    into ordinary work items)
 *
 * Every job carries the platform's automation policy (no credentials, no
 * bypasses, no financial actions) and a dedupe scope tied to the work item and
 * attempt, so a restart can never create the same job twice.
 */
import { getD1 } from "../platform";
import { enqueueJob } from "../jobs";
import { AUTOMATION_POLICY } from "../agent/capabilities";
import { selectModuleForCapability } from "../events";
import { assertExecutionAllowed } from "./guard";
import { parse, type Row } from "./common";

export type ExecOutcome = { status: "running" | "done" | "waiting_human" | "deferred" | "failed"; result?: Row; jobId?: string; runId?: string; notBefore?: string; error?: string };

async function siteEntity(investigationId: string) {
  const db = getD1();
  const c = await db.prepare("SELECT entity_id,canonical_domain FROM inbox_candidates WHERE investigation_id=?").bind(investigationId).first<Row>();
  if (c?.entity_id) return String(c.entity_id);
  const e = await db.prepare("SELECT e.id FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='site' LIMIT 1").bind(investigationId).first<Row>();
  return e ? String(e.id) : null;
}

async function job(w: Row, jobType: string, capability: string, input: { investigationId: string | null; entityId: string | null; payload: Row; priority?: number }) {
  const targetModule = await selectModuleForCapability(capability, "platform");
  if (!targetModule) return { deferred: `no connected module can ${capability} right now` };
  const q = await enqueueJob({ job_type: jobType, investigation_id: input.investigationId, target_entity_id: input.entityId, target_module: targetModule as never, created_by_module: "platform",
    priority: input.priority ?? 55, trigger_reason: `v5 operations: ${String(w.reason).slice(0, 160)}`, dedupe_scope: `wi:${w.id}`,
    max_attempts: String(w.fingerprint).startsWith('operation:') ? 1 : undefined,
    payload: { ...input.payload, work_item_id: w.id, automation_policy: AUTOMATION_POLICY } });
  return { jobId: String((q.job as Row).id), created: q.created };
}

export async function executeWork(w: Row): Promise<ExecOutcome> {
  assertExecutionAllowed(`work:${w.kind}`);
  const db = getD1();
  switch (String(w.kind)) {
    case "investigate_candidate": {
      const cand = await db.prepare("SELECT * FROM inbox_candidates WHERE canonical_domain=?").bind(w.target_key).first<Row>();
      if (!cand?.investigation_id) return { status: "failed", error: "candidate has no investigation record" };
      if (cand.decision === "skip") return { status: "done", result: { skipped: "a person skipped this site" } };
      const owned = await db.prepare("SELECT c.id FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE m.domain=? AND c.status='RUNNING' AND m.state IN ('pending','investigating','waiting_human')").bind(w.target_key).first<Row>();
      if (owned) return { status: "done", result: { skipped: `campaign ${String(owned.id).slice(0, 8)} owns this site` } };
      if (cand.source_module === "operation_hunter" && cand.entity_id) {
        // A member site of a Hunter operation shares the operation's investigation: investigate this one site.
        const r = await job(w, "INVESTIGATE_SITE", "site:investigate", { investigationId: String(cand.investigation_id), entityId: String(cand.entity_id), payload: { canonical_key: w.target_key, reason: "operation_member", source: "operation_hunter" } });
        if ("deferred" in r) return { status: "deferred", notBefore: new Date(Date.now() + 10 * 60000).toISOString(), result: { deferred: r.deferred } };
        await db.prepare("UPDATE inbox_candidates SET status='operations',progress_state='ops_investigating',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('ready','presented','suppressed')").bind(cand.id).run();
        return { status: "running", jobId: r.jobId };
      }
      const active = await db.prepare("SELECT id FROM agent_runs WHERE investigation_id=? AND status IN ('RUNNING','WAITING_FOR_MODULE','WAITING_FOR_HUMAN','PAUSED')").bind(cand.investigation_id).first<Row>();
      if (active) return { status: "running", runId: String(active.id), result: { adopted_existing_run: true } };
      const done = await db.prepare("SELECT 1 FROM jobs WHERE investigation_id=? AND job_type='INVESTIGATE_SITE' AND status='completed'").bind(cand.investigation_id).first();
      if (done) return { status: "done", result: { already_investigated: true } };
      const { startRun, tick } = await import("../agent/runner");
      const run = await startRun(String(cand.investigation_id), `ops:${w.id}`);
      if (!run) return { status: "failed", error: "investigation not found" };
      await db.batch([
        db.prepare("UPDATE agent_runs SET max_discovery_expansions=0 WHERE id=? AND started_by=?").bind(run.id, `ops:${w.id}`),
        db.prepare("UPDATE inbox_candidates SET status='operations',progress_state='ops_investigating',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('ready','presented','suppressed')").bind(cand.id),
      ]);
      if (run.status === "RUNNING") await tick(String(run.id));
      return { status: "running", runId: String(run.id) };
    }
    case "revisit_changed_site": case "revisit_incomplete": {
      const inv = w.investigation_id ? String(w.investigation_id) : String((await db.prepare("SELECT investigation_id FROM inbox_candidates WHERE canonical_domain=?").bind(w.target_key).first<Row>())?.investigation_id ?? "");
      if (!inv) return { status: "failed", error: "no investigation for this site" };
      const entity = await siteEntity(inv);
      if (!entity) return { status: "failed", error: "site entity missing" };
      // v7: an adaptive test may name its focus (e.g. likely deposit pages); Site Investigator still runs its bounded public collection.
      const focus = parse<Row>(w.result, {}).focus;
      const r = await job(w, "RECHECK_SITE", "site:investigate", { investigationId: inv, entityId: entity, payload: { canonical_key: w.target_key, reason: String(w.kind), ...(focus ? { focus: String(focus).slice(0, 60) } : {}) } });
      if ("deferred" in r) return { status: "deferred", notBefore: new Date(Date.now() + 10 * 60000).toISOString(), result: { deferred: r.deferred } };
      return { status: "running", jobId: r.jobId };
    }
    case "analyze_wallet": {
      const fresh = await db.prepare("SELECT 1 FROM entity_analysis_state WHERE entity_id=? AND analysis_type='ANALYZE_WALLET' AND fresh_until>CURRENT_TIMESTAMP").bind(w.target_key).first();
      if (fresh) return { status: "done", result: { already_fresh: true } };
      const inv = w.investigation_id ? String(w.investigation_id) : String((await db.prepare("SELECT investigation_id FROM investigation_entities WHERE entity_id=? LIMIT 1").bind(w.target_key).first<Row>())?.investigation_id ?? "");
      if (!inv) return { status: "failed", error: "wallet is not part of an investigation" };
      if (await db.prepare("SELECT 1 FROM wallet_candidates WHERE entity_id=? AND investigation_id=? LIMIT 1").bind(w.target_key,inv).first()) return {status:"done",result:{no_action:true,completed_analysis:false,reason:"The wallet pipeline owns this analysis"}};
      if (!await db.prepare("SELECT 1 FROM observation_versions WHERE entity_id=? AND source_module IN ('site_investigator','crypto_wallet_logger') LIMIT 1").bind(w.target_key).first()) return {status:"done",result:{no_action:true,completed_analysis:false,reason:"No eligible upstream page observation for legacy wallet analysis"}};
      const r = await job(w, "ANALYZE_WALLET", "wallet:analyze", { investigationId: inv, entityId: String(w.target_key), payload: {} });
      if ("deferred" in r) return { status: "deferred", notBefore: new Date(Date.now() + 10 * 60000).toISOString(), result: { deferred: r.deferred } };
      return { status: "running", jobId: r.jobId };
    }
    case "inspect_infrastructure": case "expand_campaign": case "discovery_cycle": {
      if (w.kind === "expand_campaign") {
        await db.prepare("UPDATE campaigns SET max_discovery_requests=MIN(max_discovery_requests+2,100),next_tick_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('RUNNING','BUDGET_EXHAUSTED')").bind(w.target_key).run();
        await db.prepare("UPDATE campaigns SET status='RUNNING',stop_reason=NULL,finished_at=NULL WHERE id=? AND status='BUDGET_EXHAUSTED'").bind(w.target_key).run();
        return { status: "done", result: { discovery_allowance_raised_by: 2 } };
      }
      if (w.kind === "discovery_cycle") {
        const r = await job(w, "DISCOVER_SITES", "site:discover", { investigationId: null, entityId: null, payload: { requested: 10, budget: { http: 120 }, reason: "v5_continuous_discovery", mode: "continuous", sources: parse<Row>(w.result, {}).sources ?? null } });
        if ("deferred" in r) return { status: "deferred", notBefore: new Date(Date.now() + 15 * 60000).toISOString(), result: { deferred: r.deferred } };
        return { status: "running", jobId: r.jobId };
      }
      const kind = String(w.target_type) === "nameserver" ? "ns" : String(w.target_type) === "certificate" ? "san" : String(w.target_type);
      const r = await job(w, "FIND_RELATED_SITES", "site:relate", { investigationId: null, entityId: null, payload: { pivot: { kind, value: w.target_key }, campaign_id: w.campaign_id ?? null, context: "source=ops", requested: 8, reason: "v5_infrastructure_pivot" } });
      if ("deferred" in r) return { status: "deferred", notBefore: new Date(Date.now() + 15 * 60000).toISOString(), result: { deferred: r.deferred } };
      return { status: "running", jobId: r.jobId, result: { pivot: { kind, value: w.target_key }, known_before: Number((await db.prepare("SELECT COUNT(*) n FROM inbox_candidates").first<Row>())?.n ?? 0) } };
    }
    case "campaign_step": {
      const { tickCampaign } = await import("../campaign/campaign");
      const r = await tickCampaign(String(w.target_key), `ops:${w.id}` as ReturnType<typeof crypto.randomUUID>);
      return { status: "done", result: { status: r.status, executed: r.executed, headline: r.headline } };
    }
    case "compare_clusters": {
      const [a, b] = String(w.target_key).split("|");
      const { compareCampaigns, proposeMerges } = await import("./formation");
      const res = await compareCampaigns(a, b);
      if (res.merge_supported) await proposeMerges();
      return { status: "done", result: res as unknown as Row };
    }
    case "form_campaign": case "merge_campaigns": case "split_campaign": {
      const f = await import("./formation");
      const res: Row = w.kind === "form_campaign" ? await f.executeFormation(w) : w.kind === "merge_campaigns" ? await f.executeMerge(w) : await f.executeSplit(w);
      if (res.defer) return { status: "deferred", notBefore: new Date(Date.now() + 10 * 60000).toISOString(), result: res };
      return { status: res.refused ? "failed" : "done", result: res, error: res.refused ? String(res.refused) : undefined };
    }
    case "draft_report": {
      const { createReportCandidate } = await import("../reporting");
      const r = await createReportCandidate(String(w.investigation_id ?? w.target_key));
      if (!r.ok) return { status: "done", result: { not_ready: r.message } };
      const { notify } = await import("./notifications");
      await notify({ kind: "report_ready", title: `Report ready for review: ${w.target_key}`, body: "A frozen evidence snapshot is waiting for your approval. Nothing is sent without it.", link: "/tasks", dedupeKey: `report:${r.candidate_id}` });
      return { status: "done", result: r as unknown as Row };
    }
    case "review_contradiction":
      return { status: "waiting_human" };
    case "find_related_sites": {
      // Seeds come from the request (Hunter evidence gap or an analyst); Site Finder pivots from them.
      const r0 = parse<Row>(w.result, {});
      const seeds = (Array.isArray(r0.seeds) ? r0.seeds as unknown[] : []).map(x => String(x)).filter(Boolean).slice(0, 10);
      if (!seeds.length) return { status: "done", result: { skipped: "no seed sites" } };
      const opRow = String(w.target_type) === "operation"
        ? await db.prepare("SELECT code,name FROM hunter_operations WHERE external_id=? OR id=? LIMIT 1").bind(String(w.target_key), String(w.target_key)).first<Row>().catch(() => null) : null;
      const r = await job(w, "FIND_RELATED_SITES", "site:relate", { investigationId: w.investigation_id ? String(w.investigation_id) : null, entityId: null,
        payload: { domain: seeds[0], seeds, operation_id: r0.operation_id ?? (String(w.target_type) === "operation" ? String(w.target_key) : null),
          operation_name: opRow ? `${String(opRow.code ?? "").trim()} ${String(opRow.name ?? "").trim()}`.trim().slice(0, 120) || null : null, campaign_id: w.campaign_id ?? null, requested: 8, reason: String(r0.reason ?? "evidence_gap").slice(0, 160), source: String(r0.source ?? "main"),
          artifacts: Array.isArray(r0.artifacts) ? (r0.artifacts as unknown[]).slice(0, 40) : [],
          // v7: a structured, bounded objective (observations only; Finder draws no ownership conclusion).
          ...(r0.objective && typeof r0.objective === "object" ? { objective: r0.objective } : {}), ...(r0.budget && typeof r0.budget === "object" ? { budget: r0.budget } : {}) } });
      if ("deferred" in r) return { status: "deferred", notBefore: new Date(Date.now() + 15 * 60000).toISOString(), result: { ...r0, deferred: r.deferred } };
      return { status: "running", jobId: r.jobId, result: { ...r0, known_before: Number((await db.prepare("SELECT COUNT(*) n FROM inbox_candidates").first<Row>())?.n ?? 0) } };
    }
    case "reconstruct_operation": {
      const { reconstructPayload } = await import("./hunter");
      const built = await reconstructPayload(w);
      if ("error" in built) return { status: "failed", error: built.error };
      const r = await job(w, "HUNT_OPERATION", "operation:reconstruct", { investigationId: built.investigationId, entityId: null, payload: built.payload, priority: 50 });
      if ("deferred" in r) return { status: "deferred", notBefore: new Date(Date.now() + 30 * 60000).toISOString(), result: { deferred: r.deferred } };
      return { status: "running", jobId: r.jobId };
    }
    default:
      return { status: "failed", error: `unknown work kind ${String(w.kind)}` };
  }
}

/**
 * For running items: has the underlying work finished, and what did it produce?
 * `useful` comes only from observed outcomes (evidence, wallets, verified sites).
 */
export async function reconcileWork(w: Row): Promise<{ status: "running" | "done" | "failed" | "waiting_human"; useful?: number; actual?: number; cost?: number; result?: Row; error?: string } > {
  const db = getD1();
  const since = String(w.started_at ?? w.updated_at);
  if (w.run_id) {
    const run = await db.prepare("SELECT status,headline,investigation_id,used_module_calls FROM agent_runs WHERE id=?").bind(w.run_id).first<Row>();
    if (!run) return { status: "failed", error: "run vanished" };
    if (run.status === "WAITING_FOR_HUMAN") return { status: "waiting_human" };
    if (["RUNNING", "WAITING_FOR_MODULE", "PAUSED"].includes(String(run.status))) return { status: "running" };
    const wallets = Number((await db.prepare("SELECT COUNT(DISTINCT ie.entity_id) n FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='wallet' AND ie.source_module IN ('site_investigator','crypto_wallet_logger')").bind(run.investigation_id).first<Row>())?.n ?? 0);
    const evidence = Number((await db.prepare("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND source_module IN ('site_investigator','crypto_wallet_logger','wallet_investigator')").bind(run.investigation_id).first<Row>())?.n ?? 0);
    return { status: "done", useful: wallets ? 1 : evidence ? 0.4 : 0, actual: wallets + evidence, cost: Number(run.used_module_calls ?? 1) + 1, result: { run_status: run.status, wallets, evidence } };
  }
  if (w.job_id) {
    const j = await db.prepare("SELECT status,job_type,result,last_error,investigation_id FROM jobs WHERE id=?").bind(w.job_id).first<Row>();
    if (!j) return { status: "failed", error: "job vanished" };
    if (["pending", "running", "retrying", "awaiting-approval"].includes(String(j.status))) return { status: "running" };
    if (j.status !== "completed") return { status: "failed", error: `job ${j.status}: ${String(j.last_error ?? "").slice(0, 160)}` };
    if (j.job_type === "RECHECK_SITE") {
      // Only what changed counts: a recheck that saw the same thing produced no new evidence.
      const changes = Number((await db.prepare("SELECT COUNT(*) n FROM entity_changes WHERE subject_key=? AND detected_at>=? AND source_table IN ('evidence','investigation_entities','jobs')").bind(w.target_key, since).first<Row>())?.n ?? 0);
      const newEvidence = Number((await db.prepare("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND created_at>=? AND source_module='site_investigator'").bind(j.investigation_id, since).first<Row>())?.n ?? 0);
      return { status: "done", useful: changes ? 1 : 0, actual: changes, cost: 1, result: { changes, new_evidence_rows: newEvidence } };
    }
    if (j.job_type === "ANALYZE_WALLET") return { status: "done", useful: 0.6, actual: 1, cost: 1, result: { analyzed: true } };
    if (j.job_type === "HUNT_OPERATION") { const { reconcileReconstruction } = await import("./hunter"); const r = await reconcileReconstruction(j); return { status: "done", useful: r.useful, actual: r.actual, cost: 1, result: r.result }; }
    if (j.job_type === "INVESTIGATE_SITE") {
      const wallets = Number((await db.prepare("SELECT COUNT(*) n FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='wallet' AND ie.source_module IN ('site_investigator','crypto_wallet_logger') AND ie.first_seen_at>=?").bind(j.investigation_id, since).first<Row>())?.n ?? 0);
      const evidence = Number((await db.prepare("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND created_at>=? AND source_module='site_investigator'").bind(j.investigation_id, since).first<Row>())?.n ?? 0);
      return { status: "done", useful: wallets ? 1 : evidence ? 0.4 : 0, actual: wallets + evidence, cost: 1, result: { wallets, evidence } };
    }
    if (j.job_type === "FIND_RELATED_SITES") {
      const res = parse<Row>(j.result, {});
      const claimed = (Array.isArray(res.new_candidates) ? res.new_candidates as unknown[] : []).map(String);
      const verified = claimed.length ? Number((await db.prepare(`SELECT COUNT(*) n FROM inbox_candidates WHERE canonical_domain IN (${claimed.map(() => "?").join(",")})`).bind(...claimed).first<Row>())?.n ?? 0) : 0;
      return { status: "done", useful: Math.min(1, verified / 2), actual: verified, cost: 1, result: { claimed: claimed.length, verified, saturated: Boolean(res.saturated) } };
    }
    if (j.job_type === "DISCOVER_SITES") {
      const res = parse<Row>(j.result, {});
      const delivered = Number(res.delivered ?? 0);
      return { status: "done", useful: Math.min(1, delivered / 5), actual: delivered, cost: 1, result: res };
    }
    return { status: "done", useful: 0.3, actual: 0, cost: 1, result: parse<Row>(j.result, {}) };
  }
  return { status: "done", useful: 0, actual: 0, cost: 0 };
}
