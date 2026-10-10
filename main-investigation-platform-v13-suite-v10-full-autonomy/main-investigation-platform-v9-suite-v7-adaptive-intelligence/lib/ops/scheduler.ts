/**
 * The autonomous scheduler (v5).
 *
 * One tick, under a single global lease so two workers never schedule at once:
 *
 *   1. recover     adopt or requeue work interrupted by a crash (never duplicate it)
 *   2. reconcile   finish running items whose job/run ended; record observed outcomes
 *   3. refresh     graph sync, temporal/gap review, contradictions, formation,
 *                  experiments, calibration, health (team roles, chosen per tick)
 *   4. generate    typed opportunities from Site Finder candidates, the discovery
 *                  plan, due campaigns and finished investigations
 *   5. select      order by deterministic priority + bounded starvation boost x
 *                  bounded experiment weight, with a small exploration share;
 *                  enforce global/module concurrency, pause state and budgets
 *   6. review      the Reviewer's pre-start checks (skipped by a person, already
 *                  running, cooldown, module unavailable, budget)
 *   7. start       claim atomically, then hand to the executor
 *
 * The scheduler decides what runs now, what waits (deferred with a reason and
 * a time), what needs a human (waiting_human) and what is revisited later
 * (cooldowns). Pausing stops new starts only; running module work finishes and
 * is reconciled.
 */
import { getD1 } from "../platform";
import { executeWork, reconcileWork } from "./executor";
import { backoffMs, failForGood, recover } from "./health";
import { effectivePriority, proposeWork, markWork, workEvent, type Kind } from "./workitems";
import { recordWorkOutcome, learnedPrior, workContext } from "./learning";
import { canSpend, spend, type BudgetKind } from "./budgets";
import { experimentWeight, assign } from "./experiments";
import { clamp, getBool, getNum, getState, setState, hoursSince, json, parse, r3, type Row } from "./common";

const DISCOVERY_KINDS = new Set(["discovery_cycle", "inspect_infrastructure", "expand_campaign"]);
const BUDGET_OF: Partial<Record<Kind, BudgetKind>> = {
  investigate_candidate: "investigations", revisit_changed_site: "module_jobs", revisit_incomplete: "module_jobs", analyze_wallet: "module_jobs",
  inspect_infrastructure: "discovery_requests", discovery_cycle: "discovery_requests", reconstruct_operation: "module_jobs", find_related_sites: "discovery_requests",
};
const REFRESH_MINUTES = 5;

export type TickSummary = { tick_id: string | null; skipped?: string; recovered?: Row; reconciled: number; generated: number; started: Array<{ id: string; kind: string; target: string; status: string }>; deferred: Array<{ id: string; why: string }>; waiting_human: number; roles?: string[]; paused: boolean };

async function acquire(owner: string, seconds: number) {
  const db = getD1();
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  await db.prepare("INSERT OR IGNORE INTO ops_state (key,value) VALUES ('scheduler_lease','{}')").run();
  const r = await db.prepare("UPDATE ops_state SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key='scheduler_lease' AND (json_extract(value,'$.until') IS NULL OR json_extract(value,'$.until')<? OR json_extract(value,'$.owner')=?)")
    .bind(json({ owner, until }), new Date().toISOString(), owner).run();
  return (r.meta?.changes ?? 0) === 1;
}
async function release(owner: string) {
  await getD1().prepare("UPDATE ops_state SET value='{}',updated_at=CURRENT_TIMESTAMP WHERE key='scheduler_lease' AND json_extract(value,'$.owner')=?").bind(owner).run();
}

/** Runs one scheduler tick. Safe to call concurrently: only the lease holder works. */
export async function schedulerTick(opts: { owner?: string; maxStarts?: number; skipRefresh?: boolean } = {}): Promise<TickSummary> {
  const owner = opts.owner ?? `sched:${crypto.randomUUID()}`;
  const db = getD1();
  const paused = await getBool("scheduler_paused", false);
  const summary: TickSummary = { tick_id: null, reconciled: 0, generated: 0, started: [], deferred: [], waiting_human: 0, paused };
  const leaseS = await getNum("lease_seconds", 180);
  if (!(await acquire(owner, leaseS))) return { ...summary, skipped: "another scheduler holds the lease" };
  const tickId = crypto.randomUUID();
  summary.tick_id = tickId;
  await db.prepare("INSERT INTO scheduler_ticks (id,owner,status) VALUES (?,?,'running')").bind(tickId, owner).run();
  try {
    summary.recovered = await recover(owner);
    // v9: the same maintenance entry point advances legacy runs. A web tick and
    // scheduled tick must not have different liveness behavior.
    const { tickDueRuns, wake } = await import('../agent/runner');
    const sleeping=(await db.prepare("SELECT id,investigation_id FROM agent_runs r WHERE status='WAITING_FOR_MODULE' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.investigation_id=r.investigation_id AND j.status IN ('pending','running','retrying')) ORDER BY r.updated_at LIMIT 20").all<Row>()).results;
    for(const r of sleeping)await wake(String(r.investigation_id),'job');
    if(!paused)await tickDueRuns(20);
    summary.reconciled = await reconcileAll();
    const {reconcileStaleSiteWork}=await import('../scientific/queue');
    summary.reconciled+= (await reconcileStaleSiteWork()).resolved;
    try { const { reconcileWalletPipeline } = await import("../wallet-pipeline"); await reconcileWalletPipeline(undefined,{startPending:!paused}); } catch (error) { console.error("wallet pipeline reconcile:", error); }
    if (!opts.skipRefresh) summary.roles = await refresh(tickId);
    if (!paused) {
      summary.generated = await generate(tickId);
      const sel = await selectAndStart(owner, tickId, opts.maxStarts ?? 20);
      summary.started = sel.started; summary.deferred = sel.deferred;
    }
    const { directorTick } = await import("../director/director");
    await directorTick(paused);
    const { operationIntelligenceTick } = await import('./intelligence');
    await operationIntelligenceTick(paused);
    const {autonomyTick}=await import('../autonomy');
    await autonomyTick();
    const {missionTick}=await import('../missions');await missionTick(8,paused);
    summary.waiting_human = Number((await db.prepare("SELECT COUNT(*) n FROM work_items WHERE status='waiting_human'").first<Row>())?.n ?? 0);
    await notifyAttention();
    await db.prepare("UPDATE scheduler_ticks SET status='done',finished_at=CURRENT_TIMESTAMP,summary=? WHERE id=?").bind(json(summary), tickId).run();
    return summary;
  } catch (error) {
    await db.prepare("UPDATE scheduler_ticks SET status='failed',finished_at=CURRENT_TIMESTAMP,summary=? WHERE id=?").bind(json({ ...summary, error: error instanceof Error ? error.message : String(error) }), tickId).run();
    throw error;
  } finally {
    await release(owner);
  }
}

/** Finishes running (and human-waiting) items whose job or run has ended. */
async function reconcileAll() {
  const db = getD1();
  const rows = (await db.prepare("SELECT * FROM work_items WHERE status IN ('running','waiting_human') AND (job_id IS NOT NULL OR run_id IS NOT NULL) LIMIT 100").all<Row>()).results;
  let n = 0;
  for (const w of rows) {
    const r = await reconcileWork(w);
    if (r.status === "running") { if (w.status === "waiting_human") { await markWork(String(w.id), "running"); n++; } continue; }
    if (r.status === "waiting_human") {
      if (w.status !== "waiting_human") {
        await markWork(String(w.id), "waiting_human", { result: { waiting: "a person is needed; the investigator resumes on its own afterwards" } });
        const { recordHumanNeed } = await import("./learning");
        await recordHumanNeed(workContext(w), true, String(w.id));
        n++;
      }
      continue;
    }
    if (r.status === "done") {
      const eventId = await markWork(String(w.id), "done", { result: { ...parse<Row>(w.result, {}), ...(r.result ?? {}), useful: r.useful ?? 0 } });
      await recordWorkOutcome(w, { useful: r.useful ?? 0, actual: r.actual ?? 0, cost: r.cost ?? 1, basis: "observed", eventId });
      await markDecisionsUseful(String(w.id), r.useful ?? 0);
      if (w.gap_id) { const { noteGapAttempt } = await import("./gaps"); await noteGapAttempt(String(w.gap_id)); }
      if (w.investigation_id || w.kind === "investigate_candidate") await afterInvestigation(w);
      n++; continue;
    }
    await retryOrFail(w, r.error ?? "failed");
    n++;
  }
  return n;
}

async function afterInvestigation(w: Row) {
  const db = getD1();
  const inv = w.investigation_id ? String(w.investigation_id) : String((await db.prepare("SELECT investigation_id FROM inbox_candidates WHERE canonical_domain=?").bind(w.target_key).first<Row>())?.investigation_id ?? "");
  if (!inv) return;
  const { observeInvestigation } = await import("./temporal");
  const { evaluateGaps } = await import("./gaps");
  await observeInvestigation(inv);
  await evaluateGaps(inv);
  if (w.kind === "investigate_candidate") await db.prepare("UPDATE inbox_candidates SET status='completed',progress_state='ops_done',updated_at=CURRENT_TIMESTAMP WHERE canonical_domain=? AND status='operations'").bind(w.target_key).run();
}

async function markDecisionsUseful(workItemId: string, useful: number) {
  const { markUsefulness } = await import("../ai/router");
  const ds = (await getD1().prepare("SELECT id FROM ai_decisions WHERE work_item_id=?").bind(workItemId).all<Row>()).results;
  for (const d of ds) await markUsefulness(String(d.id), useful);
}

async function retryOrFail(w: Row, error: string) {
  if (Number(w.attempts) < Number(w.max_attempts)) {
    await getD1().prepare("UPDATE work_items SET status='queued',job_id=NULL,run_id=NULL,lease_owner=NULL,lease_until=NULL,last_error=?,not_before=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(error.slice(0, 300), new Date(Date.now() + backoffMs(Number(w.attempts))).toISOString(), w.id).run();
    await workEvent(String(w.id), "retry_scheduled", { error, attempt: w.attempts });
  } else await failForGood(w, error);
}

/** Team roles chosen for this tick; each writes a typed artifact. Throttled to every few minutes. */
async function refresh(tickId: string) {
  const last = await getState("last_refresh_at", "");
  if (last && hoursSince(last) * 60 < REFRESH_MINUTES) return [];
  await setState("last_refresh_at", new Date().toISOString());
  const { syncGlobalGraph } = await import("./intel");
  await syncGlobalGraph(300);
  const team = await import("./team");
  const { roles } = await team.selectRoles();
  const run = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { console.error(`ops role ${name} failed`, error instanceof Error ? error.message : error); await getD1().prepare("INSERT INTO ops_artifacts (id,tick_id,role,kind,body) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), tickId, name, "role_error", json({ error: error instanceof Error ? error.message : String(error) })).run(); } };
  if (roles.includes("evidence_analyst")) await run("evidence_analyst", () => team.evidenceAnalyst(tickId));
  if (roles.includes("graph_analyst")) await run("graph_analyst", () => team.graphAnalyst(tickId));
  if (roles.includes("hypothesis_analyst")) await run("hypothesis_analyst", () => team.hypothesisAnalyst(tickId));
  if (roles.includes("campaign_planner")) await run("campaign_planner", () => team.campaignPlanner(tickId));
  if (roles.includes("report_analyst")) await run("report_analyst", () => team.reportAnalyst(tickId));
  await run("contradictions", async () => { const { detectContradictions } = await import("./contradictions"); await detectContradictions(); });
  await run("experiments", async () => { const { evaluateExperiments } = await import("./experiments"); await evaluateExperiments(); });
  await run("calibration", async () => { const { calibrateEvidence } = await import("./confidence"); await calibrateEvidence(100); });
  await run("health", async () => { const { recordHealth } = await import("./health"); await recordHealth(); });
  await run("inactive", async () => {
    const { checkInactive } = await import("./formation");
    for (const c of (await getD1().prepare("SELECT id FROM campaigns WHERE status IN ('RUNNING','COMPLETE','BUDGET_EXHAUSTED')").all<Row>()).results) await checkInactive(String(c.id));
  });
  await team.advanceTeamCursor();
  return roles;
}

/** Latest artifact of a kind written in this tick (or the most recent one). */
async function artifact(kind: string, tickId: string) {
  const r = await getD1().prepare("SELECT body FROM ops_artifacts WHERE kind=? ORDER BY CASE WHEN tick_id=? THEN 0 ELSE 1 END, created_at DESC LIMIT 1").bind(kind, tickId).first<Row>();
  return r ? parse<Row>(r.body, {}) : null;
}

/** Turns platform state and this tick's artifacts into typed work items. */
async function generate(tickId: string) {
  const db = getD1();
  let n = 0;
  const team = await import("./team");
  const alloc = await team.resourceManager(tickId);
  // Due v4 campaigns: one leased campaign step each.
  for (const c of (await db.prepare("SELECT id,next_tick_at FROM campaigns WHERE status='RUNNING' AND next_tick_at<=CURRENT_TIMESTAMP AND (lease_until IS NULL OR lease_until<?) ORDER BY next_tick_at LIMIT 10").bind(new Date().toISOString()).all<Row>()).results) {
    const r = await proposeWork({ kind: "campaign_step", targetType: "campaign", targetKey: String(c.id), source: "campaign", reason: "campaign is due for its next step", campaignId: String(c.id), reopen: true, maxAttempts: 10,
      factors: { info_gain: 0.6, campaign_relevance: 1, evidence_strength: 0.6, novelty: 0.3, cost: 0.1, open_gaps: 0.5 } });
    if (r.outcome !== "unchanged") n++;
  }
  // Investigate promising Site Finder candidates nobody owns yet.
  if (await getBool("auto_investigate", true)) {
    const minScore = await getNum("auto_investigate_min_score", 0.5);
    const cands = (await db.prepare(`SELECT c.* FROM inbox_candidates c WHERE c.status IN ('ready','presented') AND c.investigation_id IS NOT NULL AND c.decision IS NULL AND c.score>=?
      AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.kind='investigate_candidate' AND w.target_key=c.canonical_domain)
      AND NOT EXISTS (SELECT 1 FROM campaign_members m JOIN campaigns k ON k.id=m.campaign_id WHERE m.domain=c.canonical_domain AND k.status IN ('RUNNING','PAUSED'))
      ORDER BY c.score DESC LIMIT 25`).bind(minScore).all<Row>()).results;
    for (const c of cands) {
      const quality=parse<Row>(parse<Row>(c.details,{}).discovery_quality,{});
      if(typeof quality.marginal==='number'&&quality.marginal<.5)continue;
      const factors = await candidateFactors(c);
      await proposeWork({ kind: "investigate_candidate", targetType: "domain", targetKey: String(c.canonical_domain), source: "discovery", investigationId: String(c.investigation_id),
        reason: `Site Finder surfaced it (score ${Number(c.score).toFixed(2)})${c.headline ? `: ${String(c.headline).slice(0, 120)}` : ""}`, factors });
      n++;
    }
  }
  // Re-score queued candidate work: evidence elsewhere changes duplicate probability and saturation.
  for (const w of (await db.prepare("SELECT w.id,w.target_key,w.reason,w.investigation_id FROM work_items w WHERE w.kind='investigate_candidate' AND w.status IN ('queued','deferred','suppressed') LIMIT 50").all<Row>()).results) {
    const c = await db.prepare("SELECT * FROM inbox_candidates WHERE canonical_domain=?").bind(w.target_key).first<Row>();
    if (!c) continue;
    if (c.decision === "skip") { const { cancelWork } = await import("./workitems"); await cancelWork({ id: String(w.id) }, "a person skipped this site"); continue; }
    await proposeWork({ kind: "investigate_candidate", targetType: "domain", targetKey: String(w.target_key), source: "discovery", investigationId: w.investigation_id ? String(w.investigation_id) : null, reason: String(w.reason), factors: await candidateFactors(c) });
  }
  // The discovery plan: passive pivots and a discovery cycle when supply is low.
  if (alloc.discovery_allowed) {
    const plan = await team.discoveryStrategist(tickId, alloc);
    for (const p of plan.pivots.slice(0, 4)) {
      const r = await proposeWork({ kind: "inspect_infrastructure", targetType: p.type, targetKey: p.key, source: "discovery", reason: `Discovery strategist: ${p.why}`, reopen: false,
        factors: { info_gain: p.score, novelty: 0.6, evidence_strength: 0.5, previous_outcomes: p.score, cost: 0.3, freshness: 0.8 } });
      if (r.outcome === "created") n++;
    }
    if (plan.cycle) {
      const interval = await getNum("discovery_interval_minutes", 60);
      const bucket = Math.floor(Date.now() / (interval * 60000));
      const prior = (await learnedPrior("discovery_cycle", "kind=discovery_cycle|campaign=0|gain=hi|source=discovery")).value;
      const r = await proposeWork({ kind: "discovery_cycle", targetType: "discovery", targetKey: `cycle:${bucket}`, source: "discovery", reason: plan.why,
        factors: { info_gain: 0.7, novelty: 0.8, previous_outcomes: prior, cost: 0.3, saturation: clamp(1 - prior * 1.5), freshness: 1 } });
      if (r.outcome === "created") n++;
    }
  }
  // Operation reconstruction: campaigns and wallet-bearing sites no Hunter operation covers yet (only while Hunter is registered).
  try { const { proposeReconstructions } = await import("./hunter"); n += await proposeReconstructions(); } catch (error) { console.error("reconstruction proposals skipped", error instanceof Error ? error.message : error); }
  // Report drafts for finished, well-evidenced investigations (a person still approves every report).
  const rq = await artifact("report_queue", tickId);
  for (const inv of parse<string[]>(rq?.investigations, [])) {
    const r = await proposeWork({ kind: "draft_report", targetType: "investigation", targetKey: inv, investigationId: inv, source: "scheduler", reason: "investigation finished with wallets and at least two evidence items", factors: { info_gain: 0.3, evidence_strength: 0.8, cost: 0.1 } });
    if (r.outcome === "created") n++;
  }
  return n;
}

/** Deterministic factors for investigating a candidate, from observable state only. */
export async function candidateFactors(c: Row) {
  const db = getD1();
  const cluster = String(c.cluster_key ?? "");
  const wallets = parse<string[]>(c.wallets, []).map(w => w.toLowerCase());
  const siblings = (await db.prepare("SELECT canonical_domain,wallets,status FROM inbox_candidates WHERE cluster_key=? AND canonical_domain<>? AND status IN ('operations','completed','campaign')").bind(cluster, c.canonical_domain).all<Row>()).results;
  const knownWallets = new Set(siblings.flatMap(s => parse<string[]>(s.wallets, []).map(w => w.toLowerCase())));
  const newWallets = wallets.filter(w => !knownWallets.has(w)).length;
  const dup = siblings.length && wallets.length && !newWallets ? 0.7 : siblings.length ? 0.35 : 0;
  const status = await db.prepare("SELECT value FROM entity_facets WHERE subject_type='domain' AND subject_key=? AND facet='status'").bind(c.canonical_domain).first<Row>();
  const dead = parse<string>(status?.value, "") === "dead";
  const prior = (await learnedPrior("investigate_candidate", `kind=investigate_candidate|campaign=0|gain=${Number(c.score) >= 0.66 ? "hi" : Number(c.score) >= 0.33 ? "mid" : "lo"}|source=discovery`)).value;
  const saturation = clamp(siblings.length / 6);
  // Relevance from observed evidence: does this site share non-generic infrastructure, a template or a
  // wallet with a site where a module actually observed a deposit wallet (or at least investigated)?
  const linked = (await db.prepare(`SELECT DISTINCT o.node_key d FROM intel_nodes me JOIN intel_edges e1 ON e1.src_node=me.id AND e1.active=1 JOIN intel_nodes x ON x.id=e1.dst_node AND x.generic=0 AND x.node_type IN ('ip','nameserver','certificate','template','favicon','wallet')
      JOIN intel_edges e2 ON e2.dst_node=x.id AND e2.active=1 AND e2.src_node<>me.id JOIN intel_nodes o ON o.id=e2.src_node AND o.node_type='domain' WHERE me.node_type='domain' AND me.node_key=? LIMIT 40`).bind(c.canonical_domain).all<Row>()).results.map(r => String(r.d));
  let relevance = 0;
  if (linked.length) {
    const ph = linked.map(() => "?").join(",");
    const proven = await db.prepare(`SELECT 1 FROM inbox_candidates k JOIN investigation_entities ie ON ie.investigation_id=k.investigation_id JOIN entities en ON en.id=ie.entity_id AND en.entity_type='wallet' WHERE k.canonical_domain IN (${ph}) AND ie.source_module IN ('site_investigator','crypto_wallet_logger') LIMIT 1`).bind(...linked).first();
    const investigated = proven ? null : await db.prepare(`SELECT 1 FROM inbox_candidates k JOIN jobs j ON j.investigation_id=k.investigation_id AND j.job_type='INVESTIGATE_SITE' WHERE k.canonical_domain IN (${ph}) LIMIT 1`).bind(...linked).first();
    relevance = proven ? 1 : investigated ? 0.4 : 0.1;
  }
  return {
    info_gain: clamp(Number(c.score) * (newWallets || !wallets.length ? 1 : 0.6)), novelty: siblings.length ? 0.3 : 1, evidence_strength: clamp(Number(c.score)),
    campaign_relevance: relevance, accessibility: dead ? 0.1 : 1, previous_outcomes: prior, cost: 0.5, dup_prob: dup, saturation,
    freshness: clamp(1 - hoursSince(c.created_at) / (24 * 14)), open_gaps: 0.5,
  };
}

type Candidate = Row & { eff: number; weight: number; expId?: string; arm?: string };

/** Selection and start: priority order, limits, budgets, Reviewer. */
async function selectAndStart(owner: string, tickId: string, maxStarts: number) {
  const db = getD1();
  const now = new Date().toISOString();
  const started: TickSummary["started"] = [], deferred: TickSummary["deferred"] = [];
  const boost = await getNum("starvation_boost_per_hour", 0.02), cap = await getNum("starvation_boost_cap", 0.25);
  const rows = (await db.prepare("SELECT * FROM work_items WHERE status IN ('queued','deferred') AND (not_before IS NULL OR not_before<=?) ORDER BY priority DESC LIMIT 200").bind(now).all<Row>()).results;
  const cands: Candidate[] = [];
  for (const w of rows) {
    const e = await experimentWeight(w);
    cands.push({ ...w, weight: e.weight, expId: e.experimentId, arm: e.arm, eff: r3(effectivePriority(Number(w.priority), hoursSince(w.created_at), boost, cap) * e.weight) });
  }
  cands.sort((a, b) => b.eff - a.eff || String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  // Bounded exploration: every 1/share-th start goes to the best item from a context with little history.
  const share = clamp(await getNum("exploration_share", 0.1), 0, 0.3);
  let counter = await getNum("exploration_counter", 0);
  if (share > 0 && cands.length > 1 && (counter + 1) % Math.round(1 / share) === 0) {
    const low = [] as Candidate[];
    for (const c of cands.slice(0, 40)) if (!c.campaign_id && (await contextCount(c)) < 3) low.push(c);
    if (low[0] && low[0] !== cands[0]) { cands.splice(cands.indexOf(low[0]), 1); cands.unshift({ ...low[0], exploration: true }); }
  }
  const alloc = await artifact("allocation", tickId);
  let slots = Number(alloc?.slots ?? (await getNum("max_concurrent_work", 6)));
  const moduleSlots = parse<Record<string, number>>(alloc?.module_slots, {});
  const discoveryPaused = await getBool("discovery_paused", false);
  const discoveryMin = await getNum("discovery_min_priority", 0);
  let startedCount = 0;
  for (const w of cands) {
    if (startedCount >= maxStarts) break;
    const kind = String(w.kind) as Kind;
    const mod = w.module ? String(w.module) : null;
    if (DISCOVERY_KINDS.has(kind) && (discoveryPaused || Number(w.priority) < discoveryMin)) continue;          // waits, not deferred: resumes when discovery does
    if (mod && slots <= 0) break;
    if (mod && (moduleSlots[mod] ?? 1) <= 0) continue;
    const review = await reviewer(w);
    if (review.action === "cancel") { await markWork(String(w.id), "cancelled", { result: { reviewer: review.why } }); continue; }
    if (review.action === "defer") { await db.prepare("UPDATE work_items SET status='deferred',not_before=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(review.until, `waiting: ${review.why}`, w.id).run(); await workEvent(String(w.id), "deferred", { why: review.why, until: review.until }); deferred.push({ id: String(w.id), why: review.why }); continue; }
    // Claim atomically: a second scheduler (or a restart) cannot start it twice.
    const claim = await db.prepare("UPDATE work_items SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1,started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','deferred')")
      .bind(owner, new Date(Date.now() + (await getNum("lease_seconds", 180)) * 1000).toISOString(), w.id).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;
    const cur = { ...w, attempts: Number(w.attempts) + 1 };
    await workEvent(String(w.id), "started", { tick: tickId, effective_priority: w.eff, experiment: w.expId ? { id: w.expId, arm: w.arm, weight: w.weight } : null, exploration: Boolean(w.exploration) });
    if (w.expId && w.arm) await assign(w.expId, w.arm, cur, 1);
    await setState("exploration_counter", ++counter);
    let out;
    try { out = await executeWork(cur); }
    catch (error) { out = { status: "failed" as const, error: error instanceof Error ? error.message : String(error) }; }
    // Budget is charged when module work actually starts (not for items that turn out to be covered
    // already), once per attempt; the Reviewer checked it fits before the start.
    const bk = BUDGET_OF[kind];
    if (bk && out.status === "running" && !(out.result as Row | undefined)?.adopted_existing_run) await spend(bk, 1, `wi:${w.id}:${cur.attempts}`, mod ? [`module:${mod}`] : []);
    if (out.status === "running") await markWork(String(w.id), "running", { jobId: out.jobId ?? null, runId: out.runId ?? null, result: out.result });
    else if (out.status === "done") {
      // Finished without module work (already covered, skipped, or a platform-internal step): no outcome to learn from.
      await markWork(String(w.id), "done", { result: out.result ?? {} });
    } else if (out.status === "waiting_human") await markWork(String(w.id), "waiting_human", { result: out.result });
    else if (out.status === "deferred") {
      await db.prepare("UPDATE work_items SET status='deferred',attempts=MAX(0,attempts-1),not_before=?,lease_owner=NULL,lease_until=NULL,result=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(out.notBefore ?? new Date(Date.now() + 600000).toISOString(), json(out.result ?? {}), w.id).run();
      await workEvent(String(w.id), "deferred", out.result ?? {});
      deferred.push({ id: String(w.id), why: String((out.result as Row | undefined)?.deferred ?? "module unavailable") });
      continue;
    } else await retryOrFail(cur, out.error ?? "failed");
    started.push({ id: String(w.id), kind, target: String(w.target_key), status: out.status });
    startedCount++;
    if (mod && out.status === "running") { slots--; moduleSlots[mod] = (moduleSlots[mod] ?? 1) - 1; }
  }
  return { started, deferred };
}

async function contextCount(w: Row) {
  return Number((await getD1().prepare("SELECT COUNT(*) n FROM experience WHERE action=? AND context=?").bind(w.kind, workContext(w)).first<Row>())?.n ?? 0);
}

/**
 * The Reviewer's pre-start check. Deterministic; it can cancel (the work no
 * longer makes sense), defer (not now: budget, cooldown, busy target) or allow.
 */
export async function reviewer(w: Row): Promise<{ action: "allow" } | { action: "cancel"; why: string } | { action: "defer"; why: string; until: string }> {
  const db = getD1();
  const later = (min: number) => new Date(Date.now() + min * 60000).toISOString();
  const kind = String(w.kind) as Kind;
  if (["investigate_candidate", "revisit_changed_site", "revisit_incomplete"].includes(kind)) {
    const c = await db.prepare("SELECT decision FROM inbox_candidates WHERE canonical_domain=?").bind(w.target_key).first<Row>();
    if (c?.decision === "skip") return { action: "cancel", why: "a person skipped this site" };
  }
  if (w.gap_id) {
    const g = await db.prepare("SELECT status FROM evidence_gaps WHERE id=?").bind(w.gap_id).first<Row>();
    if (g && g.status !== "open") return { action: "cancel", why: `its evidence gap is ${g.status}` };
  }
  const same = await db.prepare("SELECT id FROM work_items WHERE status='running' AND target_key=? AND id<>? AND module IS NOT NULL AND module=?").bind(w.target_key, w.id, w.module ?? "").first<Row>();
  if (same && w.module) return { action: "defer", why: "other work on the same target is running", until: later(10) };
  if (kind === "revisit_changed_site" || kind === "revisit_incomplete") {
    const cool = await getNum("revisit_cooldown_hours", 24);
    const last = await db.prepare("SELECT finished_at FROM work_items WHERE kind IN ('revisit_changed_site','revisit_incomplete') AND target_key=? AND status='done' AND id<>? ORDER BY finished_at DESC LIMIT 1").bind(w.target_key, w.id).first<Row>();
    if (last && hoursSince(last.finished_at) < cool) return { action: "defer", why: `revisit cooldown (${cool}h)`, until: new Date(Date.now() + (cool - hoursSince(last.finished_at)) * 3600000).toISOString() };
  }
  const bk = BUDGET_OF[kind];
  if (bk) {
    const ok = await canSpend(bk, 1, w.module ? [`module:${w.module}`] : []);
    if (!ok.ok) return { action: "defer", why: `${bk.replace(/_/g, " ")} budget reached (${ok.scope})`, until: nextDay() };
  }
  if (w.campaign_id && kind !== "campaign_step") {
    const c = await db.prepare("SELECT status FROM campaigns WHERE id=?").bind(w.campaign_id).first<Row>();
    if (c && ["STOPPED", "MERGED"].includes(String(c.status))) return { action: "cancel", why: `campaign is ${String(c.status).toLowerCase()}` };
  }
  if (kind === "campaign_step") {
    const c = await db.prepare("SELECT status FROM campaigns WHERE id=?").bind(w.target_key).first<Row>();
    if (!c || c.status !== "RUNNING") return { action: "cancel", why: "campaign is not running" };
  }
  return { action: "allow" };
}

function nextDay() { const d = new Date(); d.setUTCHours(24, 5, 0, 0); return d.toISOString(); }

/** Budget warnings and human-needed notifications (deduplicated; routine work never notifies). */
async function notifyAttention() {
  const { notify } = await import("./notifications");
  const { budgetSummary } = await import("./budgets");
  for (const b of await budgetSummary()) if (b.share >= 0.85) await notify({ kind: "budget_warning", severity: b.share >= 1 ? "warning" : "info", title: `${b.kind.replace(/_/g, " ")} budget ${b.share >= 1 ? "exhausted" : "nearly exhausted"} (${b.scope})`, body: `${b.used} of ${b.max} used today. Work that needs it waits until tomorrow or until you raise the limit.`, link: "/operations", dedupeKey: `budget:${b.scope}:${b.kind}:${new Date().toISOString().slice(0, 10)}` });
  const waiting = (await getD1().prepare("SELECT id,kind,target_key FROM work_items WHERE status='waiting_human' ORDER BY updated_at DESC LIMIT 20").all<Row>()).results;
  for (const w of waiting) await notify({ kind: "human_action", title: w.kind === "review_contradiction" ? `Review a contradiction on ${String(w.target_key).slice(0, 60)}` : `Your help is needed: ${String(w.target_key).slice(0, 60)}`, body: "Open Human Tasks to see exactly what is needed. Work resumes on its own afterwards.", link: "/tasks", dedupeKey: `human:${w.id}` });
}

/** Operator controls. */
export async function pauseOperations(paused: boolean) { await setState("scheduler_paused", paused); return { paused }; }
export async function schedulerStatus() {
  const db = getD1();
  const last = (await db.prepare("SELECT id,started_at,finished_at,status,summary FROM scheduler_ticks ORDER BY started_at DESC LIMIT 5").all<Row>()).results;
  return { paused: await getBool("scheduler_paused", false), discovery_paused: await getBool("discovery_paused", false), discovery_min_priority: await getNum("discovery_min_priority", 0), recent_ticks: last.map(t => ({ ...t, summary: parse(t.summary, {}) })) };
}
