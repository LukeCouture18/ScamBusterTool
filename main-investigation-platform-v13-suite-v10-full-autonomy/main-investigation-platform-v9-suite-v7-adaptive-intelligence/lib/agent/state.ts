/**
 * The investigation digest: everything the planner may know, built by
 * deterministic queries over the platform's own tables. The model sees this
 * digest and nothing else. Evidence IDs in it are the only IDs a plan may cite.
 */
import { getD1 } from "../platform";
import { detectBarriers, isDeadSite, type Barrier, type EvidenceLite } from "./barriers";
import { isMeaningful, isWalletEvidence, knowledgeClass, type KnowledgeClass } from "./knowledge";

type Row = Record<string, unknown>;
export const WAIT_JOB_TYPES = ["INVESTIGATE_SITE", "ANALYZE_WALLET", "RECHECK_SITE"];
const ACTIVE_JOB = ["pending", "running", "retrying"];

export type Digest = {
  investigation: { id: string; external_id: string; title: string };
  site: { entity_id: string; domain: string; url: string } | null;
  entities: Array<{ id: string; type: string; key: string; sources: string[] }>;
  evidence: {
    total: number; all_ids: string[]; meaningful: number; wallet: number; authenticated: number; max_rowid: number;
    by_class: Record<KnowledgeClass, number>; by_module: Record<string, number>;
    recent: Array<{ id: string; type: string; class: KnowledgeClass; scope: string; module: string; title: string; snippet: string }>;
  };
  wallets: Array<{ entity_id: string; key: string; sources: string[]; analyzed: boolean; analysis: string }>;
  jobs: Array<{ id: string; type: string; status: string; module: string; target_entity_id: string | null; error: string; agent_step_id: string | null }>;
  in_flight: Array<{ id: string; type: string; status: string }>;
  barriers: Barrier[];
  dead: { dead: boolean; reason: string; evidence_ids: string[] };
  checkpoints: Array<{ id: string; kind: string; status: string; resolution: string | null; created_at: string; resolved_at: string | null }>;
  related: Array<{ entity_id: string; domain: string; via: string }>;
  inbox: { candidate_id: string; domain: string; cluster_key: string; related_domains: string[]; decision: string | null; strategies: string[] } | null;
  report: { status: string; id: string } | null;
  progress: { site_investigated: boolean; site_investigation_failed: boolean; public_wallet_found: boolean; wallets_found: number; wallets_analyzed: number; related_requested: boolean; report_requested: boolean };
  memory_hint: { prior_investigations_sharing_entities: number; cluster_outcomes: Record<string, number> };
};

function parse<T>(value: unknown, fallback: T): T { try { return typeof value === "string" ? JSON.parse(value) as T : (value as T) ?? fallback; } catch { return fallback; } }
function snippet(text: unknown) { return String(text ?? "").replace(/\s+/g, " ").slice(0, 200); }

export async function evidenceRows(investigationId: string) {
  const rows = await getD1().prepare("SELECT rowid AS rid,id,evidence_type,evidence_class,observation_scope,source_module,context_text,title,created_at FROM evidence WHERE investigation_id=? ORDER BY rowid").bind(investigationId).all<Row>();
  return rows.results.map(r => ({ rid: Number(r.rid), id: String(r.id), evidence_type: String(r.evidence_type ?? ""), evidence_class: String(r.evidence_class ?? ""), observation_scope: String(r.observation_scope ?? "public"),
    source_module: String(r.source_module ?? ""), context_text: String(r.context_text ?? ""), title: String(r.title ?? ""), created_at: String(r.created_at ?? "") }));
}

export async function buildDigest(investigationId: string): Promise<Digest | null> {
  const db = getD1();
  const inv = await db.prepare("SELECT id,external_id,title FROM investigations WHERE id=?").bind(investigationId).first<Row>();
  if (!inv) return null;
  const [entityRows, jobRows, checkpointRows, inboxRow, reportRow, relRows] = await Promise.all([
    db.prepare("SELECT e.id,e.entity_type,e.canonical_key,group_concat(DISTINCT ie.source_module) sources FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? GROUP BY e.id ORDER BY MIN(ie.rowid) LIMIT 60").bind(investigationId).all<Row>(),
    db.prepare("SELECT id,job_type,status,target_module,target_entity_id,last_error,payload FROM jobs WHERE investigation_id=? ORDER BY created_at, rowid").bind(investigationId).all<Row>(),
    db.prepare("SELECT id,kind,status,resolution,created_at,resolved_at FROM human_checkpoints WHERE investigation_id=? ORDER BY created_at, rowid").bind(investigationId).all<Row>(),
    db.prepare("SELECT id,canonical_domain,url,cluster_key,related_domains,decision,details,entity_id FROM inbox_candidates WHERE investigation_id=? ORDER BY decided_at DESC LIMIT 1").bind(investigationId).first<Row>(),
    db.prepare("SELECT id,status FROM report_candidates WHERE investigation_id=? ORDER BY created_at DESC LIMIT 1").bind(investigationId).first<Row>(),
    db.prepare("SELECT r.target_entity_id,e.canonical_key,r.relationship_type FROM relationships r JOIN entities e ON e.id=r.target_entity_id WHERE r.investigation_id=? AND e.entity_type='site' LIMIT 20").bind(investigationId).all<Row>(),
  ]);
  const evidence = await evidenceRows(investigationId);
  const entities = entityRows.results.map(r => ({ id: String(r.id), type: String(r.entity_type), key: String(r.canonical_key), sources: String(r.sources ?? "").split(",").filter(Boolean) }));
  const siteEntity = inboxRow?.entity_id ? entities.find(e => e.id === inboxRow.entity_id) : entities.find(e => e.type === "site");
  const site = siteEntity ? { entity_id: siteEntity.id, domain: siteEntity.key, url: String(inboxRow?.url ?? `https://${siteEntity.key}/`) } : null;
  const jobs = jobRows.results.map(r => ({ id: String(r.id), type: String(r.job_type), status: String(r.status), module: String(r.target_module), target_entity_id: r.target_entity_id ? String(r.target_entity_id) : null,
    error: String(r.last_error ?? ""), agent_step_id: parse<Row>(r.payload, {}).agent_step_id ? String(parse<Row>(r.payload, {}).agent_step_id) : null }));
  const siteJobs = jobs.filter(j => j.type === "INVESTIGATE_SITE" && (!site || j.target_entity_id === site.entity_id));
  const siEvidence = evidence.filter(e => e.source_module === "site_investigator");
  const siteInvestigated = siteJobs.some(j => j.status === "completed") || siEvidence.some(e => isMeaningful(e));
  const failed = siteJobs.filter(j => j.status === "failed").slice(-1)[0];
  const walletEntities = entities.filter(e => e.type === "wallet" && e.sources.some(s => ["site_investigator", "crypto_wallet_logger", "wallet_investigator"].includes(s)));
  const analyzed = new Set(jobs.filter(j => j.type === "ANALYZE_WALLET" && j.status === "completed").map(j => j.target_entity_id));
  // A wallet shared with another investigation may already have a fresh analysis there. The
  // executor treats that as "no change" (no re-run), so the digest must count it as analysed
  // too, or the planner would propose the same analysis forever (seen with v4 campaigns).
  for (const w of walletEntities.filter(w => !analyzed.has(w.id))) {
    if (await db.prepare("SELECT 1 FROM entity_analysis_state WHERE entity_id=? AND analysis_type='ANALYZE_WALLET' AND fresh_until>CURRENT_TIMESTAMP LIMIT 1").bind(w.id).first()) analyzed.add(w.id);
  }
  const analysisStatus = (id: string) => jobs.filter(j => j.type === "ANALYZE_WALLET" && j.target_entity_id === id).map(j => j.status).slice(-1)[0] ?? "";
  const publicWallet = evidence.some(e => e.source_module === "site_investigator" && isWalletEvidence(e)) || walletEntities.some(w => w.sources.includes("site_investigator"));
  const lite: EvidenceLite[] = evidence;
  const byClass = { observed: 0, deterministic: 0, external_metadata: 0, ai_inference: 0, human: 0 } as Record<KnowledgeClass, number>;
  const byModule: Record<string, number> = {};
  for (const e of evidence) { byClass[knowledgeClass(e)]++; byModule[e.source_module] = (byModule[e.source_module] ?? 0) + 1; }
  const inferences = await db.prepare("SELECT COUNT(*) n FROM agent_inferences WHERE investigation_id=?").bind(investigationId).first<{ n: number }>();
  byClass.ai_inference = Number(inferences?.n ?? 0);
  const conclusions = await db.prepare("SELECT COUNT(*) n FROM analyst_conclusions WHERE investigation_id=?").bind(investigationId).first<{ n: number }>();
  byClass.human += Number(conclusions?.n ?? 0) + (inboxRow?.decision ? 1 : 0);
  const shared = await db.prepare("SELECT COUNT(DISTINCT other.investigation_id) n FROM investigation_entities mine JOIN investigation_entities other ON other.entity_id=mine.entity_id AND other.investigation_id<>mine.investigation_id WHERE mine.investigation_id=?").bind(investigationId).first<{ n: number }>();
  const clusterOutcomes: Record<string, number> = {};
  if (inboxRow?.cluster_key) {
    const rows = await db.prepare("SELECT f.outcome,COUNT(*) n FROM finder_outcomes f JOIN inbox_candidates c ON c.canonical_domain=f.canonical_domain WHERE c.cluster_key=? AND c.id<>? GROUP BY f.outcome").bind(inboxRow.cluster_key, inboxRow.id).all<{ outcome: string; n: number }>();
    for (const r of rows.results) clusterOutcomes[r.outcome] = Number(r.n);
  }
  const details = parse<Row>(inboxRow?.details, {});
  return {
    investigation: { id: String(inv.id), external_id: String(inv.external_id), title: String(inv.title ?? "") },
    site,
    entities,
    evidence: {
      total: evidence.length, all_ids: evidence.map(e => e.id), meaningful: evidence.filter(isMeaningful).length, wallet: evidence.filter(isWalletEvidence).length,
      authenticated: evidence.filter(e => e.observation_scope === "authenticated").length, max_rowid: evidence.length ? evidence[evidence.length - 1].rid : 0,
      by_class: byClass, by_module: byModule,
      recent: evidence.slice(-25).map(e => ({ id: e.id, type: e.evidence_type, class: knowledgeClass(e), scope: e.observation_scope, module: e.source_module, title: e.title.slice(0, 120), snippet: snippet(e.context_text) })),
    },
    wallets: walletEntities.map(w => ({ entity_id: w.id, key: w.key, sources: w.sources, analyzed: analyzed.has(w.id), analysis: analysisStatus(w.id) })),
    jobs,
    in_flight: jobs.filter(j => WAIT_JOB_TYPES.includes(j.type) && ACTIVE_JOB.includes(j.status)).map(j => ({ id: j.id, type: j.type, status: j.status })),
    barriers: detectBarriers(lite, { publicWalletFound: publicWallet, siteInvestigated }),
    dead: isDeadSite(lite, failed ? { error: failed.error } : null),
    checkpoints: checkpointRows.results.map(r => ({ id: String(r.id), kind: String(r.kind), status: String(r.status), resolution: r.resolution ? String(r.resolution) : null, created_at: String(r.created_at), resolved_at: r.resolved_at ? String(r.resolved_at) : null })),
    related: relRows.results.map(r => ({ entity_id: String(r.target_entity_id), domain: String(r.canonical_key), via: String(r.relationship_type) })),
    inbox: inboxRow ? { candidate_id: String(inboxRow.id), domain: String(inboxRow.canonical_domain), cluster_key: String(inboxRow.cluster_key ?? ""), related_domains: parse<string[]>(inboxRow.related_domains, []),
      decision: inboxRow.decision ? String(inboxRow.decision) : null, strategies: parse<string[]>(details.strategies, []) } : null,
    report: reportRow ? { id: String(reportRow.id), status: String(reportRow.status) } : null,
    progress: { site_investigated: siteInvestigated, site_investigation_failed: Boolean(failed) && !siteInvestigated, public_wallet_found: publicWallet, wallets_found: walletEntities.length,
      wallets_analyzed: walletEntities.filter(w => analyzed.has(w.id)).length, related_requested: jobs.some(j => j.type === "FIND_RELATED_SITES"), report_requested: Boolean(reportRow) },
    memory_hint: { prior_investigations_sharing_entities: Number(shared?.n ?? 0), cluster_outcomes: clusterOutcomes },
  };
}

/** What still has value, in software terms. Used by the completion gate and the rules planner. */
export function openQuestions(d: Digest) {
  const q: string[] = [];
  if (!d.site) q.push("no site entity");
  if (d.site && !d.progress.site_investigated && !d.dead.dead) q.push("site not yet investigated");
  const unanalyzed = d.wallets.filter(w => !w.analyzed && !["pending", "running", "retrying", "failed", "needs-review", "awaiting-approval"].includes(w.analysis));
  if (unanalyzed.length) q.push(`${unanalyzed.length} observed wallet(s) not analysed`);
  if (d.checkpoints.some(c => c.status === "open")) q.push("human step outstanding");
  if (d.in_flight.length) q.push(`${d.in_flight.length} module job(s) in progress`);
  return q;
}
