/**
 * Read models for the v5 Operator Workspace. The default views answer "what is
 * the system doing, what did it find, and what needs me"; scores, telemetry,
 * routing, decisions and learning are served separately (advanced).
 */
import { getD1 } from "../platform";
import { getBool, getNum, hoursSince, parse, r3, type Row } from "./common";

const KIND_LABEL: Record<string, string> = {
  investigate_candidate: "Investigate site", revisit_changed_site: "Revisit changed site", inspect_infrastructure: "Inspect infrastructure", analyze_wallet: "Analyze wallet",
  expand_campaign: "Expand campaign", test_hypothesis: "Test hypothesis", compare_clusters: "Compare clusters", revisit_incomplete: "Revisit incomplete investigation",
  draft_report: "Draft report", review_contradiction: "Review contradiction", campaign_step: "Campaign step", form_campaign: "Form campaign", merge_campaigns: "Merge campaigns",
  split_campaign: "Split campaign", discovery_cycle: "Discovery cycle", reconstruct_operation: "Reconstruct operation (Hunter)",
};
export const kindLabel = (k: unknown) => KIND_LABEL[String(k)] ?? String(k).replace(/_/g, " ");
const q = async <T extends Row = Row>(sql: string, ...b: unknown[]) => (await getD1().prepare(sql).bind(...b).all<T>()).results;
const one = async (sql: string, ...b: unknown[]) => Number((await getD1().prepare(sql).bind(...b).first<Row>())?.n ?? 0);

function item(w: Row) {
  return { id: String(w.id), kind: String(w.kind), label: kindLabel(w.kind), target: String(w.target_key), target_type: String(w.target_type), status: String(w.status), priority: r3(Number(w.priority)),
    reason: String(w.reason ?? ""), source: String(w.source), campaign_id: w.campaign_id ?? null, investigation_id: w.investigation_id ?? null, attempts: Number(w.attempts ?? 0),
    not_before: w.not_before ?? null, last_error: w.last_error ?? null, created_at: w.created_at, updated_at: w.updated_at, finished_at: w.finished_at ?? null, result: parse<Row>(w.result, {}) };
}

export async function operationsOverview() {
  const { budgetSummary } = await import("./budgets");
  const { healthSnapshot } = await import("./health");
  const h = await healthSnapshot();
  const paused = await getBool("scheduler_paused", false), discoveryPaused = await getBool("discovery_paused", false);
  const running = (await q("SELECT * FROM work_items WHERE status='running' ORDER BY started_at DESC LIMIT 12")).map(item);
  const next = (await q("SELECT * FROM work_items WHERE status IN ('queued','deferred') ORDER BY priority DESC LIMIT 8")).map(item);
  const campaigns = await q("SELECT c.id,c.title,c.status,c.headline,c.used_investigations,c.max_investigations,m.goal,m.origin,(SELECT COUNT(*) FROM campaign_members x WHERE x.campaign_id=c.id AND x.state<>'suppressed') sites,(SELECT COUNT(*) FROM campaign_edges e WHERE e.campaign_id=c.id AND e.dst_type='wallet') wallets FROM campaigns c LEFT JOIN campaign_meta m ON m.campaign_id=c.id WHERE c.status NOT IN ('STOPPED','MERGED') ORDER BY CASE c.status WHEN 'RUNNING' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END, c.updated_at DESC LIMIT 8");
  const discoveries = await q("SELECT canonical_domain domain,score,headline,status,created_at FROM inbox_candidates WHERE created_at>=datetime('now','-1 day') ORDER BY score DESC LIMIT 6");
  const newCandidates = await one("SELECT COUNT(*) n FROM inbox_candidates WHERE created_at>=datetime('now','-1 day')");
  const findings = await q(`SELECT c.subject_key domain,c.change_kind,c.to_value,c.detected_at FROM entity_changes c WHERE c.change_kind IN ('deposit_appeared','wallet_changed','site_returned','related_domain_appeared') AND c.detected_at>=datetime('now','-7 day') ORDER BY c.detected_at DESC LIMIT 6`);
  const newWallets = await one("SELECT COUNT(DISTINCT ie.entity_id) n FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE e.entity_type='wallet' AND ie.source_module IN ('site_investigator','crypto_wallet_logger') AND ie.first_seen_at>=datetime('now','-1 day')");
  const doneToday = await q("SELECT kind,COUNT(*) n,SUM(CASE WHEN CAST(json_extract(result,'$.useful') AS REAL)>=0.5 THEN 1 ELSE 0 END) useful FROM work_items WHERE status='done' AND finished_at>=datetime('now','-1 day') GROUP BY kind");
  const failedToday = await one("SELECT COUNT(*) n FROM work_items WHERE status='failed' AND finished_at>=datetime('now','-1 day')");
  const tasks = await humanTaskCount();
  const ai = await q("SELECT id,role,task,accepted,provider,created_at FROM ai_decisions WHERE is_replay=0 ORDER BY created_at DESC LIMIT 6");
  const roles = await q("SELECT role,kind,created_at FROM ops_artifacts ORDER BY created_at DESC LIMIT 8");
  const state = paused ? "paused" : h.status === "degraded" ? "degraded" : running.length ? "working" : "idle";
  const done = doneToday.reduce((s, r) => s + Number(r.n), 0), useful = doneToday.reduce((s, r) => s + Number(r.useful ?? 0), 0);
  return {
    state, paused, discovery_paused: discoveryPaused, last_tick_minutes: h.scheduler.minutes_since,
    headline: paused ? "Operations are paused. Nothing new starts until you resume." : running.length ? `Working on ${running.length} item${running.length === 1 ? "" : "s"}: ${running[0].label.toLowerCase()} ${running[0].target}` : next.length ? `Next: ${next[0].label.toLowerCase()} ${next[0].target}` : "Nothing valuable to do right now; discovery will look for more.",
    running, next, campaigns: campaigns.map(c => ({ ...c, sites: Number(c.sites), wallets: Number(c.wallets) })),
    discoveries: { new_24h: newCandidates, top: discoveries },
    findings: { new_wallets_24h: newWallets, recent: findings.map(f => ({ ...f, to_value: parse(f.to_value, null) })) },
    human_tasks: tasks,
    throughput: { done_24h: done, useful_24h: useful, failed_24h: failedToday, by_kind: doneToday.map(r => ({ kind: String(r.kind), label: kindLabel(r.kind), n: Number(r.n), useful: Number(r.useful ?? 0) })) },
    budgets: (await budgetSummary()).filter(b => b.scope === "global"),
    ai_activity: { decisions: ai.map(d => ({ ...d, accepted: Number(d.accepted) === 1 })), roles },
    health: { status: h.status, modules: h.modules, failed_work: h.failed_work.length },
    reconstructions: await reconstructionsSummary(),
  };
}

/** Operation Hunter's reconstructions, for the Operations home (empty when Hunter is not connected). */
async function reconstructionsSummary() {
  try {
    const { hunterOperations } = await import("./hunter");
    const h = await hunterOperations(6);
    return { connected: h.connected, disclaimer: h.disclaimer, operations: h.operations.filter(o => !o.is_demo).slice(0, 5).map(o => ({ id: o.id, external_id: o.external_id, code: o.code, name: o.name, model_status: o.model_status, status_reason: o.status_reason, headline: o.headline, counts: o.counts, forecast: o.forecast, top: o.discoveries.slice(0, 2), campaign_id: o.campaign_id, ui_url: o.ui_url, last_change: o.last_change })) };
  } catch { return { connected: false, disclaimer: "", operations: [] }; }
}

export async function queueView(filter: { status?: string; kind?: string; campaignId?: string; limit?: number }) {
  const where = ["1=1"], b: unknown[] = [];
  if (filter.status) { where.push("status=?"); b.push(filter.status); }
  if (filter.kind) { where.push("kind=?"); b.push(filter.kind); }
  if (filter.campaignId) { where.push("campaign_id=?"); b.push(filter.campaignId); }
  const rows = await q(`SELECT * FROM work_items WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'waiting_human' THEN 1 WHEN 'queued' THEN 2 WHEN 'deferred' THEN 3 ELSE 4 END, priority DESC, updated_at DESC LIMIT ?`, ...b, Math.min(200, filter.limit ?? 60));
  const counts = Object.fromEntries((await q("SELECT status,COUNT(*) n FROM work_items GROUP BY status")).map(r => [String(r.status), Number(r.n)]));
  return { items: rows.map(item), counts };
}

async function humanTaskCount() {
  return await one("SELECT COUNT(*) n FROM human_checkpoints WHERE status='open'") + await one("SELECT COUNT(*) n FROM contradictions WHERE status='open'") + await one("SELECT COUNT(*) n FROM report_candidates WHERE status='needs_review'");
}

const CHECKPOINT_HELP: Record<string, string> = {
  login: "The site shows a login wall. If you have a legitimate account, sign in yourself; the investigator never guesses or creates credentials.",
  captcha: "The site shows a CAPTCHA. Solve it yourself if you choose to continue; the platform never bypasses it.",
  mfa: "The site asks for a second factor. Only you can complete it.",
  email_verification: "The site sent a verification email. Complete it yourself if appropriate.",
  analyst_review: "An analyst decision is needed before the investigation continues.",
};

/** Every task that needs a person, in one list, with what exactly is needed. */
export async function humanTasks() {
  const cps = await q("SELECT h.id,h.investigation_id,h.kind,h.title,h.instructions,h.url,h.created_at,i.title inv_title FROM human_checkpoints h LEFT JOIN investigations i ON i.id=h.investigation_id WHERE h.status='open' ORDER BY h.created_at");
  const cons = await q("SELECT * FROM contradictions WHERE status='open' ORDER BY importance DESC, created_at LIMIT 100");
  const reports = await q("SELECT r.id,r.investigation_id,r.evidence_sha256,r.created_at,i.title inv_title,c.summary,c.warnings FROM report_candidates r LEFT JOIN investigations i ON i.id=r.investigation_id LEFT JOIN report_contents c ON c.candidate_id=r.id WHERE r.status='needs_review' AND (c.candidate_id IS NULL OR (c.ready=1 AND c.superseded_by IS NULL)) ORDER BY r.created_at");
  const tasks = [
    ...cps.map(c => ({ id: String(c.id), type: String(c.kind) === "analyst_review" ? "analyst_review" : String(c.kind), group: (c.kind === "analyst_review" ? "review" : "access") as "access" | "review", title: String(c.title), need: CHECKPOINT_HELP[String(c.kind)] ?? String(c.instructions), detail: String(c.instructions ?? ""),
      url: c.url ?? null, investigation_id: String(c.investigation_id), subject: String(c.inv_title ?? c.investigation_id), since: c.created_at, resumes: "The investigation resumes on its own as soon as new evidence shows the step is done.",
      actions: [{ id: "done", label: "Mark done" }, { id: "cancel", label: "Stop this investigation" }] })),
    ...cons.map(c => ({ id: String(c.id), type: "contradiction", group: "review" as const, title: `Conflicting information about ${String(c.subject_key).slice(0, 80)}`, need: String(c.detail), detail: `A: ${String(c.a_value ?? c.a_ref).slice(0, 160)} · B: ${String(c.b_value ?? c.b_ref).slice(0, 160)}`,
      url: null, investigation_id: null, subject: String(c.subject_key), since: c.created_at, resumes: "Work that depends on this waits; your decision is recorded as a human label.", kind: String(c.kind), importance: Number(c.importance),
      actions: [{ id: "resolved", label: "Resolve" }, { id: "dismissed", label: "Not a real conflict" }] })),
    ...reports.map(r => ({ id: String(r.id), type: "report_approval", group: "approval" as const, title: `Approve report for ${String(r.inv_title ?? r.investigation_id)}`, need: "A frozen evidence snapshot is ready. Nothing is sent or filed until you approve it.", detail: `Evidence hash ${String(r.evidence_sha256).slice(0, 16)}…`,
      content_sha256:String(r.evidence_sha256), summary:parse(r.summary,null), warnings:parse(r.warnings,[]), url: null, investigation_id: String(r.investigation_id), subject: String(r.inv_title ?? r.investigation_id), since: r.created_at, resumes: "Approving marks the report ready; rejecting blocks it.",
      actions: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }] })),
  ];
  return { tasks, counts: { access: cps.filter(c => c.kind !== "analyst_review").length, review: cons.length + cps.filter(c => c.kind === "analyst_review").length, approval: reports.length } };
}

export async function investigationsView(limit = 80) {
  const rows = await q(`SELECT i.id,i.title,i.status,i.updated_at,c.canonical_domain domain,c.score,
      (SELECT r.status FROM agent_runs r WHERE r.investigation_id=i.id ORDER BY r.started_at DESC LIMIT 1) run_status,
      (SELECT r.headline FROM agent_runs r WHERE r.investigation_id=i.id ORDER BY r.started_at DESC LIMIT 1) run_headline,
      (SELECT COUNT(*) FROM evidence e WHERE e.investigation_id=i.id) evidence,
      (SELECT COUNT(DISTINCT ie.entity_id) FROM investigation_entities ie JOIN entities en ON en.id=ie.entity_id WHERE ie.investigation_id=i.id AND en.entity_type='wallet') wallets,
      (SELECT COUNT(*) FROM evidence_gaps g WHERE g.investigation_id=i.id AND g.status='open') open_gaps,
      (SELECT f.value FROM entity_facets f WHERE f.subject_type='domain' AND f.subject_key=c.canonical_domain AND f.facet='status') site_status,
      (SELECT MAX(x.detected_at) FROM entity_changes x WHERE x.subject_key=c.canonical_domain) last_change
    FROM investigations i LEFT JOIN inbox_candidates c ON c.investigation_id=i.id
    WHERE EXISTS (SELECT 1 FROM agent_runs r WHERE r.investigation_id=i.id) OR EXISTS (SELECT 1 FROM work_items w WHERE w.investigation_id=i.id)
    ORDER BY i.updated_at DESC LIMIT ?`, limit);
  return rows.map(r => ({ ...r, evidence: Number(r.evidence), wallets: Number(r.wallets), open_gaps: Number(r.open_gaps), site_status: parse(r.site_status, null) }));
}

export async function discoveryView() {
  const work = (await q("SELECT * FROM work_items WHERE kind IN ('discovery_cycle','inspect_infrastructure','expand_campaign') ORDER BY updated_at DESC LIMIT 25")).map(item);
  const byDay = await q("SELECT substr(created_at,1,10) day,COUNT(*) n,SUM(CASE WHEN status='suppressed' THEN 1 ELSE 0 END) suppressed FROM inbox_candidates WHERE created_at>=datetime('now','-14 day') GROUP BY day ORDER BY day");
  const totals = { candidates: await one("SELECT COUNT(*) n FROM inbox_candidates"), waiting: await one("SELECT COUNT(*) n FROM inbox_candidates WHERE status IN ('ready','presented')"),
    investigated: await one("SELECT COUNT(*) n FROM inbox_candidates WHERE status IN ('operations','completed','campaign')"), suppressed: await one("SELECT COUNT(*) n FROM inbox_candidates WHERE status='suppressed'") };
  const cycles = (await q("SELECT id,status,result,created_at,completed_at FROM jobs WHERE job_type='DISCOVER_SITES' ORDER BY created_at DESC LIMIT 10")).map(j => ({ ...j, result: parse<Row>(j.result, {}) }));
  const pivots = await q("SELECT action,COUNT(*) n,AVG(useful) useful,AVG(cost) cost FROM experience WHERE action IN ('inspect_infrastructure','discovery_cycle','expand_campaign') AND basis IN ('observed','human','deterministic') GROUP BY action");
  return { paused: await getBool("discovery_paused", false), min_priority: await getNum("discovery_min_priority", 0), totals, by_day: byDay, work, cycles, learned: pivots };
}

export async function campaignWorkspace(campaignId: string) {
  const db = getD1();
  const c = await db.prepare("SELECT * FROM campaigns WHERE id=?").bind(campaignId).first<Row>();
  if (!c) return null;
  const meta = await db.prepare("SELECT * FROM campaign_meta WHERE campaign_id=?").bind(campaignId).first<Row>();
  const lineage = await q("SELECT event,related_campaign_id,detail,at FROM campaign_lineage WHERE campaign_id=? ORDER BY at", campaignId);
  const gaps = (await q("SELECT g.* FROM evidence_gaps g JOIN campaign_members m ON m.investigation_id=g.investigation_id WHERE m.campaign_id=? ORDER BY CASE g.status WHEN 'open' THEN 0 ELSE 1 END, g.updated_at DESC LIMIT 60", campaignId))
    .map(g => ({ id: g.id, kind: g.gap_kind, subject: g.subject_key, status: g.status, missing: g.missing, known: parse(g.known, []), safe_actions: parse(g.safe_actions, []), resolution: g.resolution ?? null, attempts: Number(g.attempts) }));
  const queue = (await q("SELECT * FROM work_items WHERE campaign_id=? ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, priority DESC LIMIT 40", campaignId)).map(item);
  const members = await q("SELECT domain,state FROM campaign_members WHERE campaign_id=?", campaignId);
  const doms = members.map(m => String(m.domain));
  const changes = doms.length ? await q(`SELECT subject_key domain,change_kind,from_value,to_value,significance,detected_at FROM entity_changes WHERE subject_type='domain' AND subject_key IN (${doms.map(() => "?").join(",")}) ORDER BY detected_at DESC LIMIT 40`, ...doms) : [];
  const activity = await q("SELECT role,kind,body,created_at FROM campaign_artifacts WHERE campaign_id=? ORDER BY created_at DESC LIMIT 25", campaignId);
  const timeline = [
    ...lineage.map(l => ({ at: l.at, kind: "lineage", title: String(l.event).replace(/_/g, " "), detail: parse<Row>(l.detail, {}), related: l.related_campaign_id ?? null })),
    ...changes.map(x => ({ at: x.detected_at, kind: "change", title: `${x.domain}: ${String(x.change_kind).replace(/_/g, " ")}`, detail: { from: parse(x.from_value, null), to: parse(x.to_value, null), significance: x.significance }, related: null })),
    ...queue.filter(w => w.finished_at).map(w => ({ at: w.finished_at, kind: "work", title: `${w.label}: ${w.target}`, detail: { status: w.status, useful: w.result.useful ?? null }, related: null })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 60);
  const contradictions = doms.length ? await q(`SELECT id,kind,subject_key,detail,status,created_at FROM contradictions WHERE subject_key IN (${doms.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 20`, ...doms) : [];
  let reconstruction: Row | null = null;
  try { const { hunterForCampaign } = await import("./hunter"); reconstruction = await hunterForCampaign(campaignId) as Row | null; } catch { reconstruction = null; }
  return { id: campaignId, title: c.title, status: c.status, goal: meta?.goal ?? "", goal_revision: Number(meta?.goal_revision ?? 0), origin: meta?.origin ?? "manual", merged_into: meta?.merged_into ?? null, split_from: meta?.split_from ?? null,
    gaps, queue, timeline, contradictions, activity: activity.map(a => ({ ...a, body: parse(a.body, {}) })), members: members.length, reconstruction,
    age_hours: Math.round(hoursSince(c.created_at)) };
}

export async function advancedTelemetry() {
  const { healthSnapshot } = await import("./health");
  const { routingStats } = await import("../ai/router");
  const { learningSummary } = await import("./learning");
  const { schedulerStatus } = await import("./scheduler");
  const { budgetSummary } = await import("./budgets");
  return {
    health: await healthSnapshot(), routing: await routingStats(), learning: await learningSummary(), scheduler: await schedulerStatus(), budgets: await budgetSummary(),
    experiments: (await q("SELECT id,name,hypothesis,domain,arm_a,arm_b,status,used_units,budget_units,result,started_at,finished_at FROM strategy_experiments ORDER BY started_at DESC LIMIT 20")).map(e => ({ ...e, result: parse(e.result, {}) })),
    simulations: (await q("SELECT id,name,source,status,result,created_at FROM simulations ORDER BY created_at DESC LIMIT 10")).map(s => ({ ...s, result: parse(s.result, {}) })),
    decisions: await q("SELECT id,scope,role,task,provider,model,accepted,is_replay,created_at FROM ai_decisions ORDER BY created_at DESC LIMIT 30"),
    artifacts: (await q("SELECT role,kind,body,created_at FROM ops_artifacts ORDER BY created_at DESC LIMIT 20")).map(a => ({ ...a, body: parse(a.body, {}) })),
    settings: Object.fromEntries((await q("SELECT key,value FROM ops_state WHERE key NOT IN ('scheduler_lease')")).map(r => [String(r.key), String(r.value)])),
  };
}
