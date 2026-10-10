/**
 * AI Investigation Team v2 and hierarchical planning.
 *
 * Roles are chosen per scheduler tick from the state of the platform, not run
 * in a fixed pipeline. Each role reads platform state and returns ONE typed
 * artifact (validated with zod and stored in `ops_artifacts`). Roles never
 * call each other and never execute anything: the scheduler is the only
 * consumer that turns artifacts into work, and it does so through
 * `proposeWork` (typed kinds, fingerprints, Reviewer, budgets).
 *
 *   resource_manager     allocation: slots, budget pressure, whether discovery may run
 *   discovery_strategist discovery_plan: which passive pivots / cycles are worth it
 *   graph_analyst        graph_findings: shared wallets, formation candidates; may
 *                        forward a model's grouping, which must pass validateGrouping
 *   evidence_analyst     evidence_review: gaps evaluated for recently active investigations
 *   hypothesis_analyst   hypothesis_review: hypotheses contradicted by evidence or people
 *   campaign_planner     campaign_plan: per-campaign goal and next steps (campaign level)
 *   report_analyst       report_queue: investigations with enough evidence to report
 *   reviewer             (in the scheduler) the pre-start check on every item
 *
 * Planning is hierarchical: the global plan is the allocation + discovery plan
 * of each tick; campaign plans are goals kept in `campaign_meta.goal` and
 * revised when their gaps or members change; investigation plans remain the v3
 * investigator's. Every level re-plans from evidence each loop.
 */
import { z } from "zod";
import { getD1 } from "../platform";
import { routedComplete, providerChain } from "../ai/router";
import { recordDecision, updateDecision } from "./decisions";
import { getBool, getNum, getState, setState, json, parse, clamp, r3, type Row } from "./common";

export const ROLES = ["resource_manager", "discovery_strategist", "graph_analyst", "evidence_analyst", "hypothesis_analyst", "campaign_planner", "report_analyst", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const ARTIFACTS = {
  allocation: z.object({ slots: z.number().int().min(0), module_slots: z.record(z.string(), z.number().int().min(0)), budget_pressure: z.record(z.string(), z.number()), discovery_allowed: z.boolean(), notes: z.array(z.string()) }).strict(),
  discovery_plan: z.object({ pivots: z.array(z.object({ node_id: z.string(), type: z.string(), key: z.string(), score: z.number(), why: z.string() }).strict()).max(20), cycle: z.boolean(), why: z.string(), ordered_by: z.enum(["deterministic", "model"]) }).strict(),
  graph_findings: z.object({ multi_site_wallets: z.number().int(), formation_proposals: z.number().int(), merge_proposals: z.number().int(), split_proposals: z.number().int(), model_groupings: z.object({ proposed: z.number().int(), accepted: z.number().int(), rejected_reasons: z.array(z.string()) }).strict() }).strict(),
  evidence_review: z.object({ investigations: z.number().int(), open_gaps: z.number().int(), closed_gaps: z.number().int() }).strict(),
  hypothesis_review: z.object({ contradicted: z.array(z.object({ hypothesis_id: z.string(), campaign_id: z.string(), why: z.string() }).strict()) }).strict(),
  campaign_plan: z.object({ campaigns: z.array(z.object({ campaign_id: z.string(), goal: z.string(), revised: z.boolean(), open_gaps: z.number().int(), next: z.array(z.string()) }).strict()) }).strict(),
  report_queue: z.object({ investigations: z.array(z.string()) }).strict(),
} as const;
export type ArtifactKind = keyof typeof ARTIFACTS;

export async function writeOpsArtifact<K extends ArtifactKind>(tickId: string | null, role: Role, kind: K, body: z.infer<(typeof ARTIFACTS)[K]>, decisionId: string | null = null) {
  const parsed = ARTIFACTS[kind].parse(body);
  await getD1().prepare("INSERT INTO ops_artifacts (id,tick_id,role,kind,body,decision_id) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), tickId, role, kind, json(parsed), decisionId).run();
  return parsed as z.infer<(typeof ARTIFACTS)[K]>;
}

/** Deterministic role selection: which roles have something to do this tick. */
export async function selectRoles(): Promise<{ roles: Role[]; why: Record<string, string> }> {
  const db = getD1(); const why: Record<string, string> = {};
  const n = async (sql: string, ...b: unknown[]) => Number((await db.prepare(sql).bind(...b).first<Row>())?.n ?? 0);
  why.resource_manager = "always: decides this tick's capacity";
  why.reviewer = "always: checks every item before it starts";
  const since = await getState("team_cursor", "1970-01-01 00:00:00");
  const ready = await n("SELECT COUNT(*) n FROM inbox_candidates WHERE status IN ('ready','presented','operations')");
  const infra = await n("SELECT COUNT(*) n FROM intel_nodes WHERE node_type IN ('ip','nameserver','certificate','template') AND generic=0 AND degree>=2");
  if (ready < (await getNum("discovery_target_ready", 12)) || infra) why.discovery_strategist = `${ready} candidate(s) waiting; ${infra} shared infrastructure node(s) to consider`;
  const newEdges = await n("SELECT COUNT(*) n FROM intel_edges WHERE first_seen_at>?", since);
  if (newEdges) why.graph_analyst = `${newEdges} new graph relationship(s) since the last review`;
  const active = await n("SELECT COUNT(DISTINCT investigation_id) n FROM evidence WHERE created_at>?", since);
  if (active) why.evidence_analyst = `${active} investigation(s) produced evidence`;
  const hyp = await n("SELECT COUNT(*) n FROM hypotheses WHERE status IN ('proposed','testing','supported')");
  if (hyp) why.hypothesis_analyst = `${hyp} live hypothesis(es)`;
  const camps = await n("SELECT COUNT(*) n FROM campaigns WHERE status='RUNNING'");
  if (camps) why.campaign_planner = `${camps} running campaign(s)`;
  const reportable = await n("SELECT COUNT(*) n FROM agent_runs r WHERE r.status='COMPLETED' AND r.updated_at>? AND NOT EXISTS (SELECT 1 FROM report_candidates rc WHERE rc.investigation_id=r.investigation_id)", since);
  if (reportable) why.report_analyst = `${reportable} investigation(s) finished`;
  return { roles: ROLES.filter(r => why[r]), why };
}

/** Resource Manager: capacity and budget pressure for this tick. */
export async function resourceManager(tickId: string | null) {
  const db = getD1();
  const { budgetSummary } = await import("./budgets");
  const running = (await db.prepare("SELECT module,COUNT(*) n FROM work_items WHERE status='running' AND module IS NOT NULL GROUP BY module").all<Row>()).results;
  const busy = Object.fromEntries(running.map(r => [String(r.module), Number(r.n)]));
  const max = await getNum("max_concurrent_work", 6);
  const slots = Math.max(0, max - running.reduce((s, r) => s + Number(r.n), 0));
  const module_slots: Record<string, number> = {};
  for (const m of ["site_investigator", "wallet_investigator", "site_finder", "crypto_wallet_logger", "operation_hunter"]) module_slots[m] = Math.max(0, (await getNum(`module_limit:${m}`, 2)) - (busy[m] ?? 0));
  const budget_pressure: Record<string, number> = {};
  const notes: string[] = [];
  for (const b of await budgetSummary()) if (b.scope === "global") { budget_pressure[b.kind] = r3(b.share); if (b.share >= 0.9) notes.push(`${b.kind} is at ${Math.round(b.share * 100)}% of today's limit`); }
  const discovery_allowed = !(await getBool("discovery_paused", false)) && (budget_pressure.discovery_requests ?? 0) < 1;
  if (!discovery_allowed) notes.push("discovery is paused or out of budget");
  return writeOpsArtifact(tickId, "resource_manager", "allocation", { slots, module_slots, budget_pressure, discovery_allowed, notes });
}

/**
 * Discovery Strategist: ranks passive pivots on shared, non-generic
 * infrastructure seen around sites that turned out to matter, using learned
 * pivot-type usefulness and the saturation of each neighbourhood. A model may
 * re-order the offered pivots; it cannot add any.
 */
export async function discoveryStrategist(tickId: string | null, allocation: { discovery_allowed: boolean }) {
  const db = getD1();
  const { learnedPrior } = await import("./learning");
  const nodes = (await db.prepare(`SELECT n.id,n.node_type,n.node_key,n.degree,(SELECT MAX(e2.strength) FROM intel_edges e2 WHERE e2.dst_node=n.id AND e2.active=1) strength,
      (SELECT COUNT(*) FROM intel_edges e JOIN intel_nodes d ON d.id=e.src_node JOIN inbox_candidates c ON c.canonical_domain=d.node_key WHERE e.dst_node=n.id AND e.active=1 AND (c.decision='useful' OR c.status IN ('operations','completed','working'))) useful_sites,
      (SELECT COUNT(*) FROM intel_edges e JOIN intel_nodes d ON d.id=e.src_node JOIN inbox_candidates c ON c.canonical_domain=d.node_key WHERE e.dst_node=n.id AND c.decision='skip') skipped_sites
    FROM intel_nodes n WHERE n.node_type IN ('ip','nameserver','certificate','template') AND n.generic=0 AND n.degree>=1 ORDER BY n.degree DESC, n.last_seen_at DESC LIMIT 60`).all<Row>()).results;
  const pivots: Array<{ node_id: string; type: string; key: string; score: number; why: string }> = [];
  for (const n of nodes) {
    if (Number(n.skipped_sites) > Number(n.useful_sites)) continue;
    const kind = String(n.node_type);
    const done = await db.prepare("SELECT status,result FROM work_items WHERE kind='inspect_infrastructure' AND target_type=? AND target_key=?").bind(kind, n.node_key).first<Row>();
    if (done && ["queued", "running", "deferred"].includes(String(done.status))) continue;
    const res = parse<Row>(done?.result, {});
    const saturated = done && (res.saturated || Number(res.verified ?? 1) === 0);
    const prior = (await learnedPrior("inspect_infrastructure", `kind=inspect_infrastructure|campaign=0|gain=mid|source=discovery`)).value;
    const score = clamp(0.35 * Math.min(1, Number(n.useful_sites) / 2) + 0.25 * Number(n.strength ?? 0.4) + 0.25 * Number(prior) + 0.15 * (kind === "template" || kind === "certificate" ? 1 : 0.6) - (saturated ? 0.5 : 0));
    if (score < 0.2) continue;
    pivots.push({ node_id: String(n.id), type: kind, key: String(n.node_key), score: r3(score), why: `${n.useful_sites} investigated site(s) share this ${kind}${saturated ? "; last pivot found nothing new" : ""}` });
  }
  pivots.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  let top = pivots.slice(0, 8), orderedBy: "deterministic" | "model" = "deterministic", decisionId: string | null = null;
  if (top.length > 3 && providerChain().length && (await getBool("ai_discovery_ordering", true))) {
    const system = "You order infrastructure pivots for passive public discovery. Reply only JSON {\"order\":[ids]} using only the ids offered. Prefer pivots likely to reveal new, distinct sites; avoid generic hosting.";
    const prompt = JSON.stringify(top.map(p => ({ id: p.node_id, type: p.type, key: p.key, why: p.why })));
    decisionId = await recordDecision({ scope: "global", role: "discovery_strategist", task: "planner_choice", visibleState: { system, prompt, options: top.map(p => ({ id: p.node_id })) }, capabilitySchema: { order: "subset of offered ids" } });
    const res = await routedComplete({ task: "classification", system, prompt, maxTokens: 200, decisionId });
    if (!("skipped" in res)) {
      const order = z.object({ order: z.array(z.string()).max(20) }).strict().safeParse(res.parsed);
      const offered = new Set(top.map(p => p.node_id));
      const ok = order.success && order.data.order.every((id: string) => offered.has(id));
      await updateDecision(decisionId, { accepted: ok, policy: { valid: ok, reasons: ok ? [] : ["order must be a subset of the offered pivots"] }, result: { proposal: res.parsed } });
      if (ok) { const rank = new Map<string, number>(order.data.order.map((id: string, i: number) => [id, i] as [string, number])); top = [...top].sort((a, b) => (rank.get(a.node_id) ?? 99) - (rank.get(b.node_id) ?? 99)); orderedBy = "model"; }
    } else await updateDecision(decisionId, { accepted: false, policy: { skipped: res.skipped } });
  }
  const ready = Number((await db.prepare("SELECT COUNT(*) n FROM inbox_candidates WHERE status IN ('ready','presented')").first<Row>())?.n ?? 0);
  const cycle = allocation.discovery_allowed && ready < (await getNum("discovery_target_ready", 12));
  return writeOpsArtifact(tickId, "discovery_strategist", "discovery_plan", { pivots: allocation.discovery_allowed ? top : [], cycle, why: cycle ? `only ${ready} candidate(s) waiting` : allocation.discovery_allowed ? "supply is sufficient" : "discovery not allowed this tick", ordered_by: orderedBy }, decisionId);
}

/**
 * Graph Analyst: deterministic formation/merge/split proposals; optionally a
 * model may suggest a grouping, which is forwarded ONLY if validateGrouping
 * confirms every cited edge exists, is active, is not generic and connects
 * every proposed domain.
 */
export async function graphAnalyst(tickId: string | null) {
  const f = await import("./formation");
  const { multiSiteWallets } = await import("./intel");
  const formation = await f.proposeFormations();
  const merges = (await getBool("auto_merge_campaigns", true)) ? await f.proposeMerges() : [];
  const splits = await f.proposeSplits();
  const model = { proposed: 0, accepted: 0, rejected_reasons: [] as string[] };
  if (providerChain().length && (await getBool("ai_graph_groupings", false))) {
    const db = getD1();
    const edges = (await db.prepare("SELECT e.id,d.node_key domain,n.node_type t,n.node_key k FROM intel_edges e JOIN intel_nodes d ON d.id=e.src_node AND d.node_type='domain' JOIN intel_nodes n ON n.id=e.dst_node WHERE e.active=1 AND n.generic=0 AND n.node_type IN ('wallet','ip','nameserver','certificate','template') ORDER BY e.last_seen_at DESC LIMIT 80").all<Row>()).results;
    const system = "Propose at most 2 groupings of domains that should be investigated together. Cite supporting edge ids from the list. Reply only JSON {\"groupings\":[{\"domains\":[...],\"edge_ids\":[...],\"why\":\"...\"}]}. Shared infrastructure is a reason to look together, not proof of ownership.";
    const prompt = JSON.stringify(edges.map(e => ({ id: e.id, domain: e.domain, shares: `${e.t}:${e.k}` })));
    const decisionId = await recordDecision({ scope: "global", role: "graph_analyst", task: "graph_analysis", visibleState: { system, prompt }, evidenceRefs: edges.map(e => String(e.id)), capabilitySchema: { groupings: "domains[], edge_ids[] (must validate)" } });
    const res = await routedComplete({ task: "graph_analysis", system, prompt, maxTokens: 500, decisionId });
    if (!("skipped" in res)) {
      const g = z.object({ groupings: z.array(z.object({ domains: z.array(z.string()).min(2).max(20), edge_ids: z.array(z.string()).max(60), why: z.string().max(300) }).strict()).max(2) }).strict().safeParse(res.parsed);
      if (!g.success) model.rejected_reasons.push("reply did not match the schema");
      else for (const grp of g.data.groupings) {
        model.proposed++;
        const v = await f.validateGrouping(grp.domains, grp.edge_ids);
        if (!v.ok) { model.rejected_reasons.push(...v.reasons.slice(0, 3)); continue; }
        if (grp.domains.length < f.MIN_FORMATION) { model.rejected_reasons.push(`fewer than ${f.MIN_FORMATION} sites`); continue; }
        const { proposeWork } = await import("./workitems");
        const w = await proposeWork({ kind: "form_campaign", targetType: "domain", targetKey: grp.domains[0], fingerprint: `form_campaign:${[...grp.domains].sort().slice(0, 3).join(",")}`, source: "formation", reason: `Graph analyst grouping (validated against ${grp.edge_ids.length} edges): ${grp.why}`, factors: { info_gain: 0.6, novelty: 0.6, evidence_strength: 0.5 } });
        await db.prepare("UPDATE work_items SET result=? WHERE id=? AND status='queued'").bind(json({ domains: grp.domains, refs: grp.edge_ids, kinds: ["model_grouping"] }), w.id).run();
        model.accepted++;
      }
      await updateDecision(decisionId, { accepted: model.accepted > 0, policy: { proposed: model.proposed, accepted: model.accepted, reasons: model.rejected_reasons } });
    } else await updateDecision(decisionId, { accepted: false, policy: { skipped: res.skipped } });
  }
  return writeOpsArtifact(tickId, "graph_analyst", "graph_findings", { multi_site_wallets: (await multiSiteWallets(200)).length, formation_proposals: formation.length, merge_proposals: merges.length, split_proposals: splits.length, model_groupings: model });
}

/** Evidence Analyst: re-derives temporal facets and gaps for investigations with new evidence. */
export async function evidenceAnalyst(tickId: string | null) {
  const db = getD1();
  const since = await getState("team_cursor", "1970-01-01 00:00:00");
  const active = (await db.prepare("SELECT DISTINCT investigation_id id FROM evidence WHERE created_at>? AND investigation_id IS NOT NULL LIMIT 25").bind(since).all<Row>()).results.map(r => String(r.id));
  // Also re-check the oldest open gaps: circumstances other than new evidence (a campaign setting a site aside, a skip) can close them.
  const stale = (await db.prepare("SELECT DISTINCT investigation_id id FROM evidence_gaps WHERE status='open' AND investigation_id IS NOT NULL ORDER BY updated_at LIMIT 15").all<Row>()).results.map(r => String(r.id));
  const invs = [...new Set([...active, ...stale])];
  const { evaluateGaps } = await import("./gaps");
  const { observeInvestigation } = await import("./temporal");
  let open = 0, closed = 0;
  for (const id of invs) { await observeInvestigation(id); const g = await evaluateGaps(id) as Row; open += Number(g?.open ?? 0); closed += Number(g?.closed ?? 0); }
  return writeOpsArtifact(tickId, "evidence_analyst", "evidence_review", { investigations: invs.length, open_gaps: open, closed_gaps: closed });
}

/** Hypothesis Analyst: live hypotheses that an open contradiction touches. It never changes confidence itself. */
export async function hypothesisAnalyst(tickId: string | null) {
  const rows = (await getD1().prepare("SELECT h.id,h.campaign_id,c.detail FROM hypotheses h JOIN contradictions c ON c.subject_type='hypothesis' AND c.subject_key=h.id WHERE c.status='open' AND h.status IN ('proposed','testing','supported') LIMIT 20").all<Row>()).results;
  return writeOpsArtifact(tickId, "hypothesis_analyst", "hypothesis_review", { contradicted: rows.map(r => ({ hypothesis_id: String(r.id), campaign_id: String(r.campaign_id), why: String(r.detail).slice(0, 200) })) });
}

/**
 * Campaign Planner (campaign-level plan): a goal derived from the campaign's
 * graph and gaps, revised when they change; plus the next steps it implies.
 */
export async function campaignPlanner(tickId: string | null) {
  const db = getD1();
  const camps = (await db.prepare("SELECT c.id,c.title,(SELECT x.domain FROM campaign_members x WHERE x.campaign_id=c.id ORDER BY CASE x.role WHEN 'seed' THEN 0 ELSE 1 END, x.created_at LIMIT 1) seed_domain,m.goal,m.goal_revision FROM campaigns c LEFT JOIN campaign_meta m ON m.campaign_id=c.id WHERE c.status='RUNNING' LIMIT 20").all<Row>()).results;
  const out = [];
  for (const c of camps) {
    const n = async (sql: string) => Number((await db.prepare(sql).bind(c.id).first<Row>())?.n ?? 0);
    const members = await n("SELECT COUNT(*) n FROM campaign_members WHERE campaign_id=? AND state<>'suppressed'");
    const verified = await n("SELECT COUNT(*) n FROM campaign_members WHERE campaign_id=? AND state='done'");
    const wallets = await n("SELECT COUNT(*) n FROM campaign_edges WHERE campaign_id=? AND dst_type='wallet'");
    const gaps = (await db.prepare("SELECT g.gap_kind,COUNT(*) n FROM evidence_gaps g JOIN campaign_members m ON m.investigation_id=g.investigation_id WHERE m.campaign_id=? AND g.status='open' GROUP BY g.gap_kind").bind(c.id).all<Row>()).results;
    const openGaps = gaps.reduce((s, g) => s + Number(g.n), 0);
    const next = gaps.sort((a, b) => Number(b.n) - Number(a.n)).slice(0, 3).map(g => `close ${g.n} ${String(g.gap_kind).replace(/_/g, " ")} gap(s)`);
    if (verified < members) next.push(`investigate ${members - verified} unverified member site(s)`);
    // The goal states what the campaign is trying to learn; live counts are shown next to it, not baked in.
    const goal = wallets ? `Map where deposits from the sites linked to ${c.seed_domain} go, and whether they share one payment flow.` : `Find the deposit destinations of the sites linked to ${c.seed_domain}.`;
    const revised = goal !== String(c.goal ?? "");
    if (revised) await db.prepare("INSERT INTO campaign_meta (campaign_id,goal,goal_revision) VALUES (?,?,1) ON CONFLICT(campaign_id) DO UPDATE SET goal=excluded.goal,goal_revision=goal_revision+1,updated_at=CURRENT_TIMESTAMP").bind(c.id, goal).run();
    out.push({ campaign_id: String(c.id), goal, revised, open_gaps: openGaps, next });
  }
  return writeOpsArtifact(tickId, "campaign_planner", "campaign_plan", { campaigns: out });
}

/** Report Analyst: finished investigations with at least two evidence items and a wallet, not yet reported. */
export async function reportAnalyst(tickId: string | null) {
  const rows = (await getD1().prepare(`SELECT DISTINCT r.investigation_id id FROM agent_runs r WHERE r.status='COMPLETED'
    AND NOT EXISTS (SELECT 1 FROM report_candidates rc WHERE rc.investigation_id=r.investigation_id)
    AND (SELECT COUNT(*) FROM evidence e WHERE e.investigation_id=r.investigation_id)>=2
    AND EXISTS (SELECT 1 FROM investigation_entities ie JOIN entities en ON en.id=ie.entity_id WHERE ie.investigation_id=r.investigation_id AND en.entity_type='wallet') LIMIT 10`).all<Row>()).results;
  return writeOpsArtifact(tickId, "report_analyst", "report_queue", { investigations: rows.map(r => String(r.id)) });
}

export async function advanceTeamCursor() { await setState("team_cursor", new Date().toISOString().replace("T", " ").slice(0, 19)); }
