/**
 * Read models for the campaign UI. The default view is deliberately small:
 * status, what the AI is doing and why, useful findings, what needs a person,
 * progress and budget. Scores, artifacts, costs, experience and provenance are
 * served separately under Advanced.
 */
import { getD1 } from "../platform";
import { graphForView } from "./graph";
import { experienceStats } from "./experience";

type Row = Record<string, unknown>;
function parse<T>(v: unknown, f: T): T { try { return typeof v === "string" ? JSON.parse(v) as T : (v as T) ?? f; } catch { return f; } }
const STATUS_LABEL: Record<string, string> = { RUNNING: "Running", PAUSED: "Paused", STOPPED: "Stopped", COMPLETE: "Complete", BUDGET_EXHAUSTED: "Budget reached" };

export async function economics(campaignId: string) {
  const db = getD1();
  const c = await db.prepare("SELECT * FROM campaigns WHERE id=?").bind(campaignId).first<Row>();
  const inv = (await db.prepare("SELECT result FROM opportunities WHERE campaign_id=? AND kind='investigate_candidate' AND status='done'").bind(campaignId).all<Row>()).results.map(r => parse<Row>(r.result, {}));
  const humanUseful = Number((await db.prepare("SELECT COUNT(DISTINCT d.canonical_domain) n FROM inbox_decisions d JOIN campaign_members m ON m.domain=d.canonical_domain WHERE m.campaign_id=? AND d.decision='useful'").bind(campaignId).first<{ n: number }>())?.n ?? 0);
  const usefulInvestigations = Math.max(inv.filter(r => Number(r.useful ?? 0) >= 0.5).length, humanUseful);
  const usefulEvidence = Number((await db.prepare("SELECT COUNT(*) n FROM evidence e JOIN campaign_members m ON m.investigation_id=e.investigation_id WHERE m.campaign_id=? AND e.source_module IN ('site_investigator','crypto_wallet_logger','wallet_investigator')").bind(campaignId).first<{ n: number }>())?.n ?? 0);
  const pivots = (await db.prepare("SELECT result FROM opportunities WHERE campaign_id=? AND kind='test_hypothesis' AND status='done'").bind(campaignId).all<Row>()).results.map(r => parse<Row>(r.result, {}));
  const newSites = pivots.reduce((s, r) => s + Number(r.verified_count ?? 0), 0);
  const actions = Number(c?.used_investigations ?? 0) + Number(c?.used_discovery_requests ?? 0);
  const costUnits = Number(c?.used_module_jobs ?? 0) + Number(c?.used_discovery_requests ?? 0) + Number(c?.used_model_calls ?? 0);
  const hyp = (await db.prepare("SELECT status,COUNT(*) n FROM hypotheses WHERE campaign_id=? GROUP BY status").bind(campaignId).all<Row>()).results;
  const byStatus = Object.fromEntries(hyp.map(h => [String(h.status), Number(h.n)]));
  const opp = Object.fromEntries((await db.prepare("SELECT status,COUNT(*) n FROM opportunities WHERE campaign_id=? GROUP BY status").bind(campaignId).all<Row>()).results.map(r => [String(r.status), Number(r.n)]));
  const wasted = inv.filter(r => Number(r.useful ?? 0) === 0).length + pivots.filter(r => !Number(r.verified_count ?? 0)).length;
  return {
    investigations: Number(c?.used_investigations ?? 0), useful_investigations: usefulInvestigations, useful_evidence: usefulEvidence,
    discovery_requests: Number(c?.used_discovery_requests ?? 0), new_sites_from_discovery: newSites, module_jobs: Number(c?.used_module_jobs ?? 0),
    model_calls: Number(c?.used_model_calls ?? 0), model_tokens: Number(c?.used_model_tokens ?? 0),
    cost_per_useful_investigation: usefulInvestigations ? Number((costUnits / usefulInvestigations).toFixed(2)) : null,
    useful_evidence_per_action: actions ? Number((usefulEvidence / actions).toFixed(2)) : null,
    duplicates_suppressed: opp.suppressed ?? 0, rejected_by_review: opp.rejected ?? 0, saturated_paths: opp.saturated ?? 0, wasted_actions: wasted,
    hypotheses: { supported: byStatus.supported ?? 0, disproved: byStatus.disproved ?? 0, open: (byStatus.proposed ?? 0) + (byStatus.testing ?? 0), inconclusive: byStatus.inconclusive ?? 0 },
    duration_seconds: c ? Math.max(0, Math.round(((c.finished_at ? new Date(String(c.finished_at).replace(" ", "T") + "Z").getTime() : Date.now()) - new Date(String(c.created_at).replace(" ", "T") + "Z").getTime()) / 1000)) : 0,
  };
}

/** Everything that needs a person: checkpoints in member investigations, and report approvals. */
export async function humanTasks(campaignId: string) {
  const db = getD1();
  const checkpoints = (await db.prepare("SELECT h.id,h.kind,h.title,h.instructions,h.created_at,h.investigation_id,i.external_id,m.domain FROM human_checkpoints h JOIN campaign_members m ON m.investigation_id=h.investigation_id JOIN investigations i ON i.id=h.investigation_id WHERE m.campaign_id=? AND h.status='open' ORDER BY h.created_at").bind(campaignId).all<Row>()).results;
  const reports = (await db.prepare("SELECT r.id,r.investigation_id,r.status,i.external_id,m.domain FROM report_candidates r JOIN campaign_members m ON m.investigation_id=r.investigation_id JOIN investigations i ON i.id=r.investigation_id WHERE m.campaign_id=? AND r.status IN ('needs_review','awaiting_approval')").bind(campaignId).all<Row>()).results;
  return [
    ...checkpoints.map(c => ({ type: "checkpoint", id: String(c.id), kind: String(c.kind), domain: String(c.domain), title: String(c.title), instructions: String(c.instructions), investigation: String(c.external_id), since: String(c.created_at) })),
    ...reports.map(r => ({ type: "report_approval", id: String(r.id), kind: "report", domain: String(r.domain), title: `Approve report for ${r.domain}`, instructions: "Review the evidence and approve the report if it is ready. Nothing is sent without your approval.", investigation: String(r.external_id), since: "" })),
  ];
}

export async function campaignOverview(campaignId: string) {
  const db = getD1();
  const c = await db.prepare("SELECT * FROM campaigns WHERE id=?").bind(campaignId).first<Row>();
  if (!c) return null;
  const members = (await db.prepare("SELECT state,COUNT(*) n FROM campaign_members WHERE campaign_id=? GROUP BY state").bind(campaignId).all<Row>()).results;
  const counts = Object.fromEntries(members.map(m => [String(m.state), Number(m.n)]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const setAside = Number((await db.prepare("SELECT COUNT(*) n FROM opportunities WHERE campaign_id=? AND kind='investigate_candidate' AND status IN ('suppressed','rejected')").bind(campaignId).first<{ n: number }>())?.n ?? 0);
  const findings = (await db.prepare("SELECT o.target_key domain,o.result,o.investigation_id,i.external_id FROM opportunities o LEFT JOIN investigations i ON i.id=o.investigation_id WHERE o.campaign_id=? AND o.kind='investigate_candidate' AND o.status='done' ORDER BY o.updated_at DESC LIMIT 20").bind(campaignId).all<Row>()).results
    .map(r => ({ r, x: parse<Row>(r.result, {}) })).filter(({ x }) => Number(x.useful ?? 0) > 0)
    .map(({ r, x }) => ({ kind: "site", title: String(r.domain), detail: Number(x.wallets) ? `${x.wallets} wallet${Number(x.wallets) === 1 ? "" : "s"} observed · ${x.meaningful_evidence} evidence item${Number(x.meaningful_evidence) === 1 ? "" : "s"}` : `${x.meaningful_evidence} evidence item${Number(x.meaningful_evidence) === 1 ? "" : "s"}`, investigation: r.external_id ? String(r.external_id) : null }));
  const hyps = (await db.prepare("SELECT id,statement,status,confidence,test_target FROM hypotheses WHERE campaign_id=? AND status IN ('supported','disproved') ORDER BY updated_at DESC LIMIT 6").bind(campaignId).all<Row>()).results
    .map(h => ({ kind: "hypothesis", title: h.status === "supported" ? "Supported lead" : "Ruled out", detail: String(h.statement), status: String(h.status), confidence: Number(Number(h.confidence).toFixed(2)) }));
  const next = (await db.prepare("SELECT kind,target_key,reason,result FROM opportunities WHERE campaign_id=? AND status='open' ORDER BY priority DESC LIMIT 3").bind(campaignId).all<Row>()).results
    .map(o => { const d = String(parse<Row>(o.result, {}).deferred ?? "");
      return { kind: String(o.kind), target: String(o.target_key), reason: String(o.reason), waiting: d.includes("budget") ? "Waiting for budget" : d.includes("waiting for the result") ? "Waiting for a similar result" : d ? "Waiting for cheaper work first" : "" }; });
  const e = await economics(campaignId);
  const budget = (used: string, max: string, label: string) => ({ label, used: Number(c[used] ?? 0), max: Number(c[max] ?? 0) });
  return {
    id: String(c.id), title: String(c.title), status: String(c.status), status_label: STATUS_LABEL[String(c.status)] ?? String(c.status),
    doing: String(c.headline ?? ""), why: String(c.why ?? ""), stop_reason: c.stop_reason ? String(c.stop_reason) : null,
    progress: { sites: total, investigated: (counts.done ?? 0), in_progress: (counts.investigating ?? 0), waiting_for_you: counts.waiting_human ?? 0,
      queued: Math.max(0, (counts.pending ?? 0) - setAside), set_aside: (counts.suppressed ?? 0) + setAside },
    findings: [...findings, ...hyps].slice(0, 10),
    human_tasks: await humanTasks(campaignId),
    next_up: next,
    budget: [budget("used_investigations", "max_investigations", "Investigations"), budget("used_discovery_requests", "max_discovery_requests", "Discovery requests"), budget("used_module_jobs", "max_module_jobs", "Module jobs"), budget("used_model_calls", "max_model_calls", "Model calls")],
    headline_numbers: { useful_investigations: e.useful_investigations, new_sites: e.new_sites_from_discovery, duplicates_avoided: e.duplicates_suppressed },
    can: { pause: c.status === "RUNNING", resume: ["PAUSED", "BUDGET_EXHAUSTED"].includes(String(c.status)), stop: ["RUNNING", "PAUSED", "BUDGET_EXHAUSTED"].includes(String(c.status)) },
    created_at: String(c.created_at),
  };
}

export async function campaignGraph(campaignId: string) { return graphForView(campaignId); }

export async function campaignAdvanced(campaignId: string) {
  const db = getD1();
  const c = await db.prepare("SELECT * FROM campaigns WHERE id=?").bind(campaignId).first<Row>();
  if (!c) return null;
  const [opps, artifacts, hyps, costs, members, edgesByBasis] = await Promise.all([
    db.prepare("SELECT id,kind,target_key,status,priority,factors,cost,reason,hypothesis_id,run_id,job_id,result,updated_at FROM opportunities WHERE campaign_id=? ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'executing' THEN 1 ELSE 2 END, priority DESC LIMIT 200").bind(campaignId).all<Row>(),
    db.prepare("SELECT tick,role,kind,body,model,created_at FROM campaign_artifacts WHERE campaign_id=? ORDER BY tick DESC, created_at DESC LIMIT 120").bind(campaignId).all<Row>(),
    db.prepare("SELECT * FROM hypotheses WHERE campaign_id=? ORDER BY created_at").bind(campaignId).all<Row>(),
    db.prepare("SELECT kind,provider,COUNT(*) n,SUM(units) units,SUM(tokens) tokens FROM campaign_costs WHERE campaign_id=? GROUP BY kind,provider").bind(campaignId).all<Row>(),
    db.prepare("SELECT m.domain,m.state,m.role,m.reason,m.investigation_id,i.external_id FROM campaign_members m LEFT JOIN investigations i ON i.id=m.investigation_id WHERE m.campaign_id=? ORDER BY m.created_at").bind(campaignId).all<Row>(),
    db.prepare("SELECT basis,source_table,COUNT(*) n FROM campaign_edges WHERE campaign_id=? GROUP BY basis,source_table").bind(campaignId).all<Row>(),
  ]);
  return {
    campaign: c,
    economics: await economics(campaignId),
    opportunities: opps.results.map(o => ({ ...o, factors: parse(o.factors, {}), result: parse(o.result, {}) })),
    traces: artifacts.results.map(a => ({ ...a, body: parse(a.body, {}) })),
    hypotheses: hyps.results.map(h => ({ ...h, observation_refs: parse(h.observation_refs, []), history: parse(h.history, []) })),
    costs: costs.results,
    members: members.results,
    provenance: { edges_by_basis_and_source: edgesByBasis.results, note: "Every campaign edge cites a row in its source table. Hypotheses are stored separately and never appear as edges." },
    experience: await experienceStats(campaignId),
    raw_jobs: (await db.prepare("SELECT j.id,j.job_type,j.status,j.target_module,j.created_at,j.completed_at FROM jobs j WHERE instr(j.payload, ?) > 0 OR j.investigation_id IN (SELECT investigation_id FROM campaign_members WHERE campaign_id=? AND investigation_id IS NOT NULL) ORDER BY j.created_at DESC LIMIT 100").bind(`"campaign_id":"${campaignId}"`, campaignId).all<Row>()).results,
  };
}

export async function listCampaigns() {
  const rows = (await getD1().prepare("SELECT id,title,status,headline,created_at,updated_at,(SELECT COUNT(*) FROM campaign_members m WHERE m.campaign_id=c.id) members FROM campaigns c ORDER BY CASE status WHEN 'RUNNING' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END, updated_at DESC LIMIT 100").all<Row>()).results;
  return rows.map(r => ({ id: String(r.id), title: String(r.title), status: String(r.status), status_label: STATUS_LABEL[String(r.status)] ?? String(r.status), doing: String(r.headline ?? ""), members: Number(r.members), updated_at: String(r.updated_at) }));
}
