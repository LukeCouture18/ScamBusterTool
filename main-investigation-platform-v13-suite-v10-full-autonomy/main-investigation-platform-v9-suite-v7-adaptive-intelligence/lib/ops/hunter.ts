/**
 * Operation Hunter <-> Platform v5 · Operations.
 *
 * Division of labour (nothing is done twice):
 *
 *   Main (coordinator)                          Operation Hunter (reconstruction engine)
 *   ------------------------------------------  ----------------------------------------------
 *   decides WHAT is worth reconstructing        reconstructs the operation behind a site,
 *     (work kind `reconstruct_operation`)          wallet or campaign, pursues it autonomously,
 *   runs site / wallet investigations through     keeps a living model (members, lifecycles,
 *     its modules, under its budgets              waves & forecast, money, competing
 *   owns temporal change reactions, human         explanations, contradictions) and hunts for
 *     tasks, notifications and reports            the operation's return
 *
 * Hunter -> Main (POST /api/v1/operations/sync): the model summary, members, the
 * 3-5 strongest discoveries, next leads, observed changes on member sites and
 * contradictions, plus *proposals*. Main never executes a proposal directly: it
 * maps each one onto its own typed work (investigate a member site, analyse an
 * operation wallet, review a contradiction) and the scheduler decides when,
 * within budgets, like any other work. Changes Hunter observed on sites flow into
 * Main's temporal layer, whose existing reactions (revisits, contradictions) apply.
 *
 * Membership is Hunter's inference from operator-level evidence; it is shown as
 * such everywhere and never as proof of common ownership.
 */
import { getD1 } from "../platform";
import { proposeWork } from "./workitems";
import { clamp, getBool, getNum, hoursSince, json, parse, r3, type Row } from "./common";

export const HUNTER_MODULE = "operation_hunter";
const DISCLAIMER = "Operation membership is Hunter's inference from shared operator settings, certificates, hosting and money flows. Shared infrastructure, kits or wallets are not proof of common ownership.";

const str = (v: unknown, max = 400) => String(v ?? "").slice(0, max);
const domainOf = (v: unknown) => { const s = String(v ?? "").trim().toLowerCase(); if (!s) return ""; try { return new URL(s.includes("://") ? s : `https://${s}`).hostname.replace(/^www\./, ""); } catch { return ""; } };

export type SyncPayload = {
  schema_version: string;
  operation: Row & { external_id: string };
  model?: Row | null;
  members?: Array<Row>;
  proposals?: Array<Row>;
  changes?: Array<Row>;
  contradictions?: Array<Row>;
};

/** Accept one operation snapshot from Hunter. Idempotent: the same snapshot twice changes nothing. */
export async function syncFromHunter(p: SyncPayload) {
  const db = getD1();
  const op = p.operation;
  const ext = str(op.external_id, 200);
  if (!ext) throw new Error("OPERATION_EXTERNAL_ID_REQUIRED");
  const model = (p.model ?? {}) as Row;
  const existing = await db.prepare("SELECT id,campaign_id,revision FROM hunter_operations WHERE external_id=?").bind(ext).first<Row>();
  const id = existing ? String(existing.id) : crypto.randomUUID();
  const campaignId = await resolveCampaign(op, p.members ?? [], existing?.campaign_id ? String(existing.campaign_id) : null);
  const values = [str(op.code, 40), str(op.name, 200), str(op.status || "ACTIVE", 40), str(model.status || "unknown", 20), str(model.status_reason, 600), str(op.headline, 600), str(op.narrative, 4000),
    clamp(Number(op.confidence ?? 0)), Math.round(Number(op.depth_score ?? 0)), json(model.counts ?? op.stats ?? {}), json(model.forecast ?? {}), json(model.explanations ?? []),
    json((op.top_findings as unknown[] ?? []).slice(0, 5)), json(((model.leads ?? []) as unknown[]).slice(0, 5)), json(((model.unknowns ?? []) as unknown[]).slice(0, 6)),
    json(((p.contradictions ?? []) as unknown[]).slice(0, 10)), json(op.pursuit ?? {}), model.version == null ? null : Number(model.version), str(model.last_change, 600),
    Math.round(Number(op.revision ?? 0)), op.is_demo ? 1 : 0, str(op.seed, 400), op.investigation_id ? str(op.investigation_id, 240) : null, campaignId, op.ui_url ? str(op.ui_url, 500) : null, str(op.hunter_version, 40)];
  if (existing) {
    await db.prepare("UPDATE hunter_operations SET code=?,name=?,status=?,model_status=?,status_reason=?,headline=?,narrative=?,confidence=?,depth_score=?,counts=?,forecast=?,explanations=?,discoveries=?,leads=?,unknowns=?,contradictions=?,pursuit=?,model_version=?,last_change=?,revision=?,is_demo=?,seed=?,investigation_id=COALESCE(?,investigation_id),campaign_id=?,ui_url=?,hunter_version=?,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(...values, id).run();
  } else {
    await db.prepare("INSERT INTO hunter_operations (code,name,status,model_status,status_reason,headline,narrative,confidence,depth_score,counts,forecast,explanations,discoveries,leads,unknowns,contradictions,pursuit,model_version,last_change,revision,is_demo,seed,investigation_id,campaign_id,ui_url,hunter_version,id,external_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(...values, id, ext).run();
  }
  const members = p.members ? await replaceMembers(id, p.members) : { sites: 0, wallets: 0, unchanged: true };
  const { ingestOperationAnalysis, projectOperation } = await import('./intelligence');
  await ingestOperationAnalysis(id,p);
  await projectOperation(id);
  if (op.is_demo) return { operation_id: id, created: !existing, members, proposals: { received: 0 }, changes: { observed: 0 }, contradictions: 0, campaign_id: campaignId };
  const proposals = await applyProposals(id, ext, String(op.code ?? ext), campaignId, op.investigation_id ? String(op.investigation_id) : null, p.proposals ?? []);
  const changes = await applyChanges(id, ext, p.changes ?? []);
  const contradictions = await applyContradictions(id, ext, p.contradictions ?? []);
  if (!existing && Number((model.counts as Row | undefined)?.members ?? 0) >= 2) {
    const { notify } = await import("./notifications");
    await notify({ kind: "useful_discovery", title: `Operation reconstructed: ${str(op.code, 40)} · ${str(op.name, 80)}`, body: `${str(op.headline, 300)} ${DISCLAIMER}`, link: "/", dedupeKey: `hunter:new:${ext}` });
  }
  return { operation_id: id, created: !existing, members, proposals, changes, contradictions, campaign_id: campaignId };
}

const ARTIFACT_KINDS = new Set(["asset", "kitfile", "title", "favicon", "apihost", "service", "linked", "analytics", "contact", "wallet", "ip", "ns", "domain"]);
/** Public artifacts a module asks Site Finder to hunt for: known kinds only, bounded, plain strings. */
export function sanitizeArtifacts(raw: unknown): Array<{ kind: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ kind: string; value: string }> = [];
  for (const a of raw.slice(0, 60)) {
    const kind = str((a as Row)?.kind, 30).toLowerCase(), value = str((a as Row)?.value, 300).trim();
    if (ARTIFACT_KINDS.has(kind) && value && !out.some(x => x.kind === kind && x.value === value)) out.push({ kind, value });
  }
  return out.slice(0, 40);
}

/** A Hunter operation belongs to a campaign when the job said so, or when two or more of its member sites are campaign members. */
async function resolveCampaign(op: Row, members: Row[], current: string | null) {
  const db = getD1();
  if (op.campaign_id) { const c = await db.prepare("SELECT id FROM campaigns WHERE id=?").bind(str(op.campaign_id, 80)).first<Row>(); if (c) return String(c.id); }
  if (current) return current;
  const sites = members.filter(m => String(m.entity_type) === "site" && String(m.role) !== "probable").map(m => domainOf(m.canonical_key)).filter(Boolean).slice(0, 200);
  if (sites.length < 2) return null;
  const hit = await db.prepare(`SELECT campaign_id,COUNT(*) n FROM campaign_members WHERE domain IN (${sites.map(() => "?").join(",")}) GROUP BY campaign_id ORDER BY n DESC LIMIT 1`).bind(...sites).first<Row>();
  return hit && Number(hit.n) >= 2 ? String(hit.campaign_id) : null;
}

async function replaceMembers(opId: string, members: Row[]) {
  const db = getD1();
  const rows = members.slice(0, 500).map(m => {
    const type = String(m.entity_type) === "wallet" ? "wallet" : "site";
    const key = type === "site" ? domainOf(m.canonical_key) : str(m.canonical_key, 200).toLowerCase();
    return { type, key, role: str(m.role, 40), p: clamp(Number(m.probability ?? 0)), state: str(m.state || "unknown", 20), why: str(m.why, 300) };
  }).filter(m => m.key);
  const stmts = [db.prepare("DELETE FROM hunter_operation_members WHERE operation_id=?").bind(opId)];
  for (const m of rows) stmts.push(db.prepare("INSERT OR REPLACE INTO hunter_operation_members (operation_id,entity_type,canonical_key,role,probability,state,why,updated_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)").bind(opId, m.type, m.key, m.role, m.p, m.state, m.why));
  await db.batch(stmts);
  return { sites: rows.filter(r => r.type === "site").length, wallets: rows.filter(r => r.type === "wallet").length };
}

/**
 * Proposals become Main's own work. Main decides; Hunter only says why it would help.
 *   investigate_site      -> investigate_candidate for a site Main tracks, or a new inbox candidate
 *                            (source operation_hunter) for a member site Main has never seen
 *   analyze_wallet        -> analyze_wallet for an operation wallet present in a Main investigation
 * Anything else is recorded as not actionable.
 */
async function applyProposals(opId: string, ext: string, code: string, campaignId: string | null, investigationRef: string | null, proposals: Row[]) {
  const db = getD1();
  const out = { received: proposals.length, work: 0, candidates: 0, not_actionable: 0, unchanged: 0 };
  const investigationId = investigationRef ? String((await db.prepare("SELECT id FROM investigations WHERE id=? OR external_id=? LIMIT 1").bind(investigationRef, investigationRef).first<Row>())?.id ?? "") || null : null;
  for (const raw of proposals.slice(0, 40)) {
    const kind = str(raw.kind, 40);
    const key = str(raw.key || `${kind}:${raw.target_key}`, 300);
    const value = clamp(Number(raw.value ?? 0.5));
    const reason = `Operation Hunter (${code}): ${str(raw.reason, 300)}`;
    const prior = await db.prepare("SELECT id,outcome,work_item_id FROM hunter_proposals WHERE operation_id=? AND proposal_key=?").bind(opId, key).first<Row>();
    let outcome = "not_actionable", workItemId: string | null = null; const detail: Row = {};
    if (kind === "investigate_site") {
      const domain = domainOf(raw.target_key);
      let cand = domain ? await db.prepare("SELECT id,investigation_id,decision,status,source_module FROM inbox_candidates WHERE canonical_domain=?").bind(domain).first<Row>() : null;
      if (cand && cand.source_module === HUNTER_MODULE && !cand.investigation_id && investigationId) {
        // A candidate Hunter proposed before its operation had a Main investigation: attach it now.
        const entity = await db.prepare("SELECT id FROM entities WHERE entity_type IN ('site','related_site') AND canonical_key=? ORDER BY CASE entity_type WHEN 'site' THEN 0 ELSE 1 END LIMIT 1").bind(domain).first<Row>();
        const evidence = await db.prepare("SELECT id FROM evidence WHERE investigation_id=? AND source_module=? ORDER BY created_at DESC LIMIT 1").bind(investigationId, HUNTER_MODULE).first<Row>();
        const siteInvestigation=await siteInvestigationFor(domain,entity?.id?String(entity.id):null);
        await db.prepare("UPDATE inbox_candidates SET investigation_id=?,entity_id=COALESCE(entity_id,?),evidence_id=COALESCE(evidence_id,?),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(siteInvestigation, entity?.id ?? null, evidence?.id ?? null, cand.id).run();
        cand = { ...cand, investigation_id: siteInvestigation };
      }
      if (!domain) outcome = "invalid_target";
      else if (cand?.decision === "skip") outcome = "skipped_by_person";
      else if (cand?.investigation_id) {
        if (prior?.work_item_id) { out.unchanged++; continue; }
        const w = await proposeWork({ kind: "investigate_candidate", targetType: "domain", targetKey: domain, source: "discovery", reason, investigationId: String(cand.investigation_id), campaignId,
          factors: { info_gain: 0.5 + 0.4 * value, evidence_strength: clamp(Number(raw.probability ?? value)), campaign_relevance: campaignId ? 1 : 0.7, novelty: 0.5, open_gaps: 0.3, cost: 0.3, freshness: 1 } });
        outcome = "work_proposed"; workItemId = w.id; detail.work = w.outcome;
      } else if (!cand) {
        const created = await createCandidate(domain, ext, code, raw, investigationId);
        outcome = created ? "candidate_created" : "not_actionable"; detail.candidate = created;
        if (created) {
          // Queue the candidate within its own site-report boundary.
          const siteInvestigation=String((await db.prepare("SELECT investigation_id FROM inbox_candidates WHERE id=?").bind(created).first<Row>())!.investigation_id);
          const w = await proposeWork({ kind: "investigate_candidate", targetType: "domain", targetKey: domain, source: "discovery", reason, investigationId:siteInvestigation, campaignId,
            factors: { info_gain: 0.5 + 0.4 * value, evidence_strength: clamp(Number(raw.probability ?? value)), campaign_relevance: campaignId ? 1 : 0.7, novelty: 0.8, open_gaps: 0.3, cost: 0.3, freshness: 1 } });
          workItemId = w.id; detail.work = w.outcome;
        }
      } else outcome = "awaiting_candidate_investigation";
    } else if (kind === "find_related") {
      // Hunter's evidence gap: "find more sites like these". Site Finder is the discovery tool; Main decides and budgets it.
      const seeds = [...new Set((Array.isArray(raw.seeds) ? raw.seeds as unknown[] : [raw.target_key]).map(x => domainOf(x)).filter((x): x is string => Boolean(x)))].slice(0, 10);
      if (!seeds.length) outcome = "invalid_target";
      else if (prior?.work_item_id) { out.unchanged++; continue; }
      else {
        const w = await proposeWork({ kind: "find_related_sites", targetType: "operation", targetKey: ext, fingerprint: `find_related:${ext}:${key}`, source: "discovery", reason, campaignId, investigationId,
          factors: { info_gain: 0.45 + 0.4 * value, evidence_strength: 0.6, campaign_relevance: campaignId ? 1 : 0.7, novelty: 0.7, open_gaps: 0.8, cost: 0.3, freshness: 1 } });
        const artifacts = sanitizeArtifacts(raw.artifacts);
        await db.prepare("UPDATE work_items SET result=? WHERE id=? AND status IN ('queued','deferred')").bind(json({ seeds, artifacts, reason: str(raw.reason, 200), source: "hunter", operation: ext }), w.id).run();
        outcome = "work_proposed"; workItemId = w.id; detail.work = w.outcome; detail.seeds = seeds;
      }
    } else if (kind === "analyze_wallet") {
      const address = str(raw.target_key, 200).toLowerCase();
      const entity = address ? await db.prepare("SELECT e.id FROM entities e JOIN investigation_entities ie ON ie.entity_id=e.id WHERE e.entity_type='wallet' AND (e.canonical_key=? OR e.canonical_key LIKE ?) LIMIT 1").bind(address, `%:${address}`).first<Row>() : null;
      if (entity) {
        const w = await proposeWork({ kind: "analyze_wallet", targetType: "wallet", targetKey: String(entity.id), source: "discovery", reason, campaignId,
          factors: { info_gain: 0.5 + 0.4 * value, evidence_strength: 0.7, campaign_relevance: campaignId ? 1 : 0.6, novelty: 0.5, cost: 0.3, freshness: 1 } });
        outcome = "work_proposed"; workItemId = w.id; detail.work = w.outcome;
      } else outcome = "wallet_not_in_main_yet";
    }
    if (prior && prior.outcome === outcome && (prior.work_item_id ?? null) === workItemId) { out.unchanged++; continue; }
    if (outcome === "work_proposed") out.work++; else if (outcome === "candidate_created") out.candidates++; else out.not_actionable++;
    await db.prepare("INSERT INTO hunter_proposals (id,operation_id,proposal_key,kind,target_type,target_key,reason,value,outcome,work_item_id,detail) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id,proposal_key) DO UPDATE SET reason=excluded.reason,value=excluded.value,outcome=excluded.outcome,work_item_id=COALESCE(excluded.work_item_id,hunter_proposals.work_item_id),detail=excluded.detail,updated_at=CURRENT_TIMESTAMP")
      .bind(crypto.randomUUID(), opId, key, kind, str(raw.target_type, 40), str(raw.target_key, 400), reason, value, outcome, workItemId, json(detail)).run();
  }
  return out;
}

/** A member site Main has never seen goes to the candidate inbox (a person, or the scheduler, decides). */
async function createCandidate(domain: string, ext: string, code: string, raw: Row, investigationId: string | null) {
  const db = getD1();
  let entity = await db.prepare("SELECT id FROM entities WHERE entity_type IN ('site','related_site') AND canonical_key=? ORDER BY CASE entity_type WHEN 'site' THEN 0 ELSE 1 END LIMIT 1").bind(domain).first<Row>();
  const evidence = entity && investigationId ? await db.prepare("SELECT ev.id FROM evidence ev WHERE ev.investigation_id=? AND ev.source_module=? ORDER BY ev.created_at DESC LIMIT 1").bind(investigationId, HUNTER_MODULE).first<Row>() : null;
  const id = crypto.randomUUID();
  const score = r3(clamp(Number(raw.probability ?? raw.value ?? 0.6)) * 0.9);
  const siteInvestigation=await siteInvestigationFor(domain,entity?.id?String(entity.id):null);
  if(!entity)entity=await db.prepare("SELECT id FROM entities WHERE entity_type='site' AND canonical_key=?").bind(domain).first<Row>();
  const r = await db.prepare("INSERT OR IGNORE INTO inbox_candidates (id,canonical_domain,url,status,score,headline,category,cluster_key,source_module,source_record_id,investigation_id,entity_id,evidence_id,details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, domain, `https://${domain}/`, "ready", score, `Proposed association with ${code}: ${str(raw.reason, 220)}`, "operation_member", `hunter:${ext}`, HUNTER_MODULE, str(raw.key, 240), siteInvestigation, entity?.id ?? null, evidence?.id ?? null,
      json({ source: "operation_hunter", operation: ext, why: str(raw.reason, 400), probability: raw.probability ?? null, disclaimer: DISCLAIMER })).run();
  return (r.meta?.changes ?? 0) === 1 ? id : null;
}

/** Correlation never combines site investigations. Hunter's evidence holding context
 * remains intact; a new deployment receives its own investigation/report boundary. */
async function siteInvestigationFor(domain:string,entityId:string|null) {
 const db=getD1();
 const known=entityId?await db.prepare("SELECT ie.investigation_id FROM investigation_entities ie WHERE ie.entity_id=? AND ie.source_module IN ('site_finder','site_investigator','crypto_wallet_logger') ORDER BY ie.first_seen_at LIMIT 1").bind(entityId).first<Row>():null;
 if(known)return String(known.investigation_id);
 const ext=`operation-site:${domain}`;
 await db.prepare("INSERT OR IGNORE INTO investigations(id,external_id,title,description) VALUES (?,?,?,?)").bind(crypto.randomUUID(),ext,`Investigate ${domain}`,'A proposed operation association needs its own authoritative site investigation.').run();
 const inv=String((await db.prepare('SELECT id FROM investigations WHERE external_id=?').bind(ext).first<Row>())!.id);
 const {enroll}=await import('../director/resources');await enroll(inv);
 let entity=entityId;
 if(!entity){await db.prepare("INSERT OR IGNORE INTO entities(id,entity_type,canonical_key,display_name,investigation_id) VALUES (?,'site',?,?,?)").bind(crypto.randomUUID(),domain,domain,inv).run();entity=String((await db.prepare("SELECT id FROM entities WHERE entity_type='site' AND canonical_key=?").bind(domain).first<Row>())!.id);}
 await db.prepare("INSERT OR IGNORE INTO investigation_entities(id,investigation_id,entity_id,role,source_module,source_record_id,schema_version) VALUES (?,?,?,'candidate','platform',?,'3.0')").bind(crypto.randomUUID(),inv,entity,ext).run();
 return inv;
}

/** What Hunter observed changing on sites goes through Main's temporal layer (first / unchanged / changed / disagreement). */
async function applyChanges(opId: string, ext: string, changes: Row[]) {
  const { observeFacet } = await import("./temporal");
  const out = { observed: 0, changed: 0, disagreements: 0, ignored: 0 };
  const members = new Set((await getD1().prepare("SELECT canonical_key FROM hunter_operation_members WHERE operation_id=? AND entity_type='site'").bind(opId).all<Row>()).results.map(r => String(r.canonical_key)));
  for (const c of changes.slice(0, 200)) {
    const domain = domainOf(c.domain ?? c.subject_key);
    const facet = str(c.facet, 30);
    if (!domain || !members.has(domain) || !["status", "ip", "nameservers"].includes(facet)) { out.ignored++; continue; }
    const value = facet === "status" ? (["live", "dead", "gone", "suspended"].includes(String(c.value)) ? String(c.value) : null) : (Array.isArray(c.value) ? (c.value as unknown[]).map(String).sort() : null);
    if (value == null) { out.ignored++; continue; }
    const r = await observeFacet({ subjectType: "domain", subjectKey: domain, facet: facet as "status" | "ip" | "nameservers", value, sourceTable: "hunter_operations", sourceRef: `${ext}:${str(c.id || c.at, 120)}`, observedAt: c.at ? str(c.at, 40) : undefined });
    out.observed++;
    if (r.outcome === "changed") out.changed++;
    if (r.outcome === "disagreement") out.disagreements++;
  }
  return out;
}

/** Hunter's significant contradictions become Main contradictions (a human task), deduplicated by fingerprint. */
async function applyContradictions(opId: string, ext: string, list: Row[]) {
  const { recordContradiction } = await import("./contradictions");
  let n = 0;
  for (const c of list.filter(x => Number(x.severity ?? 0) >= 0.6 && String(x.status ?? "open") === "open").slice(0, 5)) {
    const r = await recordContradiction({ kind: `hunter_${str(c.kind, 40)}`, subjectType: "operation", subjectKey: ext, aRef: `hunter_operations:${opId}`, bRef: `hunter:${str(c.fingerprint, 200)}`, detail: str(c.summary, 380), importance: clamp(Number(c.severity ?? 0.6)) });
    if (r.created) n++;
  }
  return n;
}

/** A single request from Hunter about one operation (e.g. the analyst sent a site to Main). */
export async function proposalsForOperation(ext: string, proposals: Row[]) {
  const r = await getD1().prepare("SELECT id,code,campaign_id,investigation_id FROM hunter_operations WHERE external_id=?").bind(ext).first<Row>();
  if (!r) return null;
  return applyProposals(String(r.id), ext, String(r.code || ext), r.campaign_id ? String(r.campaign_id) : null, r.investigation_id ? String(r.investigation_id) : null, proposals);
}

// ---------------------------------------------------------------------------------------------
// Main -> Hunter: which operations are worth reconstructing (work kind `reconstruct_operation`).

export async function hunterAvailable() {
  const r = await getD1().prepare("SELECT last_heartbeat_at,runtime_status FROM module_registry WHERE module_name=?").bind(HUNTER_MODULE).first<Row>();
  return Boolean(r && r.runtime_status !== "error" && hoursSince(r.last_heartbeat_at) < 24);
}

/**
 * Generator (called by the scheduler): campaigns with enough sites that no Hunter operation
 * reconstructs yet, and investigated sites where a module actually observed a wallet.
 */
export async function proposeReconstructions() {
  if (!(await getBool("auto_reconstruct", true)) || !(await hunterAvailable())) return 0;
  const db = getD1();
  const minSites = await getNum("reconstruct_min_sites", 2);
  let n = 0;
  const campaigns = (await db.prepare(`SELECT c.id,c.title,COUNT(m.id) sites FROM campaigns c JOIN campaign_members m ON m.campaign_id=c.id
    WHERE c.status IN ('RUNNING','COMPLETE','BUDGET_EXHAUSTED') AND NOT EXISTS (SELECT 1 FROM hunter_operations h WHERE h.campaign_id=c.id)
    GROUP BY c.id HAVING COUNT(m.id)>=? ORDER BY sites DESC LIMIT 5`).bind(minSites).all<Row>()).results;
  for (const c of campaigns) {
    const r = await proposeWork({ kind: "reconstruct_operation", targetType: "campaign", targetKey: String(c.id), campaignId: String(c.id), source: "campaign",
      reason: `Campaign "${str(c.title, 80)}" has ${Number(c.sites)} sites; reconstruct the operation behind it (members, money, history, likely next moves).`,
      factors: { info_gain: 0.75, campaign_relevance: 1, evidence_strength: 0.6, novelty: 0.6, cost: 0.4, freshness: 1 } });
    if (r.outcome === "created") n++;
  }
  const sites = (await db.prepare(`SELECT DISTINCT s.canonical_key domain, ie.investigation_id FROM investigation_entities ie JOIN entities w ON w.id=ie.entity_id AND w.entity_type='wallet'
    JOIN investigation_entities se ON se.investigation_id=ie.investigation_id JOIN entities s ON s.id=se.entity_id AND s.entity_type='site'
    WHERE ie.source_module IN ('site_investigator','crypto_wallet_logger')
      AND NOT EXISTS (SELECT 1 FROM hunter_operation_members hm WHERE hm.entity_type='site' AND hm.canonical_key=s.canonical_key)
      AND NOT EXISTS (SELECT 1 FROM campaign_members cm JOIN hunter_operations h ON h.campaign_id=cm.campaign_id WHERE cm.domain=s.canonical_key)
    LIMIT 5`).all<Row>()).results;
  for (const s of sites) {
    const r = await proposeWork({ kind: "reconstruct_operation", targetType: "domain", targetKey: String(s.domain), investigationId: String(s.investigation_id), source: "discovery",
      reason: `A module observed a wallet on ${String(s.domain)}; reconstruct the operation behind it.`,
      factors: { info_gain: 0.65, evidence_strength: 0.8, novelty: 0.6, cost: 0.4, freshness: 1 } });
    if (r.outcome === "created") n++;
  }
  return n;
}

/** The HUNT_OPERATION payload for a reconstruct_operation work item. */
export async function reconstructPayload(w: Row): Promise<{ investigationId: string | null; payload: Row } | { error: string }> {
  const db = getD1();
  if (String(w.target_type) === "campaign") {
    const c = await db.prepare("SELECT id,title FROM campaigns WHERE id=?").bind(w.target_key).first<Row>();
    if (!c) return { error: "campaign not found" };
    const members = (await db.prepare("SELECT domain,investigation_id FROM campaign_members WHERE campaign_id=? ORDER BY created_at LIMIT 12").bind(c.id).all<Row>()).results;
    if (!members.length) return { error: "campaign has no sites" };
    const wallets = (await db.prepare("SELECT DISTINCT dst_key FROM campaign_edges WHERE campaign_id=? AND dst_type='wallet' LIMIT 6").bind(c.id).all<Row>()).results.map(r => String(r.dst_key));
    const seeds = [...members.map(m => ({ type: "domain", value: String(m.domain) })), ...wallets.map(v => ({ type: "wallet", value: v.includes(":") ? v.split(":").pop()! : v }))];
    return { investigationId: members.find(m => m.investigation_id)?.investigation_id ? String(members.find(m => m.investigation_id)!.investigation_id) : null,
      payload: { seed: seeds[0], seeds, campaign_id: String(c.id), title: `Campaign: ${str(c.title, 70)}`, reason: str(w.reason, 200), budget: 80 } };
  }
  const value = String(w.target_key);
  // v7: Main may ask a structured question derived from a typed gap. Hunter answers with its own evidence-bound semantics.
  const asked = parse<Row>(w.result, {});
  const question = typeof asked.question === "string" ? { question: str(asked.question, 400), operation_id: asked.operation_id ? str(asked.operation_id, 200) : undefined } : {};
  return { investigationId: w.investigation_id ? String(w.investigation_id) : null, payload: { seed: { type: String(w.target_type) === "wallet" ? "wallet" : "domain", value }, seeds: [], title: `Operation behind ${value}`, reason: str(w.reason, 200), budget: 80, ...question } };
}

/** How useful a finished HUNT_OPERATION was: judged by what the reconstruction found (observed, not claimed). */
export async function reconcileReconstruction(job: Row) {
  const res = parse<Row>(job.result, {});
  const ext = str(res.operation_id, 200);
  const op = ext ? await getD1().prepare("SELECT id,counts,model_status FROM hunter_operations WHERE external_id=?").bind(ext).first<Row>() : null;
  const counts = parse<Row>(op?.counts, {});
  const members = Number(counts.members ?? 0);
  return { useful: members >= 3 ? 1 : members >= 2 ? 0.6 : 0.2, actual: members, result: { operation: ext, operation_code: res.operation_code ?? null, members, status: op?.model_status ?? "pending" } };
}

// ---------------------------------------------------------------------------------------------
// Read models.

function view(r: Row) {
  return { id: String(r.id), external_id: String(r.external_id), code: String(r.code), name: String(r.name), status: String(r.status), model_status: String(r.model_status), status_reason: String(r.status_reason),
    headline: String(r.headline), confidence: Number(r.confidence), depth_score: Number(r.depth_score), counts: parse<Row>(r.counts, {}), forecast: parse<Row>(r.forecast, {}),
    explanations: parse<Row[]>(r.explanations, []), discoveries: parse<Row[]>(r.discoveries, []), leads: parse<Row[]>(r.leads, []), unknowns: parse<string[]>(r.unknowns, []),
    contradictions: parse<Row[]>(r.contradictions, []), pursuit: parse<Row>(r.pursuit, {}), model_version: r.model_version ?? null, last_change: String(r.last_change), campaign_id: r.campaign_id ?? null,
    investigation_id: r.investigation_id ?? null, ui_url: r.ui_url ?? null, seed: String(r.seed), is_demo: Boolean(r.is_demo), synced_at: r.synced_at, disclaimer: DISCLAIMER };
}

export async function hunterOperations(limit = 30) {
  const db = getD1();
  const rows = (await db.prepare("SELECT * FROM hunter_operations ORDER BY is_demo ASC, updated_at DESC LIMIT ?").bind(Math.max(1, Math.min(100, limit))).all<Row>()).results;
  const reg = await db.prepare("SELECT last_heartbeat_at,module_version FROM module_registry WHERE module_name=?").bind(HUNTER_MODULE).first<Row>();
  return { connected: Boolean(reg && hoursSince(reg.last_heartbeat_at) < 0.05), module_version: reg?.module_version ?? null, operations: rows.map(view), disclaimer: DISCLAIMER };
}

export async function hunterOperation(idOrExternal: string) {
  const db = getD1();
  const r = await db.prepare("SELECT * FROM hunter_operations WHERE id=? OR external_id=?").bind(idOrExternal, idOrExternal).first<Row>();
  if (!r) return null;
  const members = (await db.prepare("SELECT entity_type,canonical_key,role,probability,state,why FROM hunter_operation_members WHERE operation_id=? ORDER BY entity_type, probability DESC").bind(r.id).all<Row>()).results;
  const proposals = (await db.prepare("SELECT p.*,w.status work_status FROM hunter_proposals p LEFT JOIN work_items w ON w.id=p.work_item_id WHERE p.operation_id=? ORDER BY p.updated_at DESC LIMIT 60").bind(r.id).all<Row>()).results;
  const work = (await db.prepare("SELECT id,kind,status,target_key,reason,updated_at FROM work_items WHERE kind='reconstruct_operation' AND (target_key=? OR target_key=?) ORDER BY updated_at DESC LIMIT 5").bind(r.campaign_id ?? "", r.seed).all<Row>()).results;
  return { ...view(r), members, proposals: proposals.map(p => ({ ...p, detail: parse(p.detail, {}) })), reconstruct_work: work };
}

export async function hunterForCampaign(campaignId: string) {
  const r = await getD1().prepare("SELECT * FROM hunter_operations WHERE campaign_id=? ORDER BY updated_at DESC LIMIT 1").bind(campaignId).first<Row>();
  return r ? hunterOperation(String(r.id)) : null;
}

/** Which Hunter operations include this site (for investigation and candidate views). */
export async function operationsForSite(domain: string) {
  return (await getD1().prepare("SELECT h.external_id,h.code,h.name,h.model_status,m.role,m.probability,m.why FROM hunter_operation_members m JOIN hunter_operations h ON h.id=m.operation_id WHERE m.entity_type='site' AND m.canonical_key=?").bind(domainOf(domain)).all<Row>()).results;
}

/** Operator request: ask Hunter to (re)hunt an operation now, or reconstruct one for a campaign. */
export async function requestReconstruction(input: { campaignId?: string; domain?: string; operationId?: string }) {
  if (input.campaignId) return proposeWork({ kind: "reconstruct_operation", targetType: "campaign", targetKey: input.campaignId, campaignId: input.campaignId, source: "command", reason: "You asked for the operation behind this campaign to be reconstructed.", reopen: true, factors: { info_gain: 0.8, campaign_relevance: 1, evidence_strength: 0.6, cost: 0.3, freshness: 1 } });
  if (input.operationId) {
    const op = await hunterOperation(input.operationId);
    if (!op) throw new Error("OPERATION_NOT_FOUND");
    return proposeWork({ kind: "reconstruct_operation", targetType: "domain", targetKey: op.seed || op.external_id, fingerprint: `reconstruct_operation:operation:${op.external_id}`, source: "command", reason: `You asked Hunter to continue operation ${op.code}.`, reopen: true, factors: { info_gain: 0.8, evidence_strength: 0.6, cost: 0.3, freshness: 1 } });
  }
  const d = domainOf(input.domain);
  if (!d) throw new Error("TARGET_REQUIRED");
  return proposeWork({ kind: "reconstruct_operation", targetType: "domain", targetKey: d, source: "command", reason: `You asked for the operation behind ${d} to be reconstructed.`, reopen: true, factors: { info_gain: 0.8, evidence_strength: 0.6, cost: 0.3, freshness: 1 } });
}

export { DISCLAIMER as HUNTER_DISCLAIMER };
