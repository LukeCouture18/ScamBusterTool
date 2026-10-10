/**
 * The unified suite: read models for the five tools (Site Finder, Wallet Investigator,
 * Wallet Logger, Form Submitter, Operation Hunter) and the few actions a person takes from
 * them. Main stays the coordinator: every action becomes Main's own work item, inbox
 * decision, reconstruction request or report candidate, under the same scheduler, budgets,
 * approvals and deduplication as before. Nothing here talks to a module directly.
 *
 * Wording rules for everything returned to the screen:
 *   - what a module OBSERVED (a page, an on-chain record) is labelled as seen/recorded;
 *   - what software DERIVED (scores, clusters, memberships) is labelled as analysis;
 *   - what a PERSON concluded is labelled as such;
 *   - shared hosting, templates, kits or transactions are never presented as proof of
 *     common ownership.
 */
import { getD1 } from "./platform";
import {finderAssessment} from './finder-confidence';

type Row = Record<string, unknown>;

export const TOOL_OF_MODULE: Record<string, string> = {
  site_finder: "Site Finder", site_investigator: "Site Finder", crypto_wallet_logger: "Wallet Logger",
  wallet_investigator: "Wallet Investigator", form_submitter: "Form Submitter", operation_hunter: "Operation Hunter", platform: "Main",
};
export const SOURCE_LABEL: Record<string, string> = {
  site_finder: "Site Finder · discovery", site_investigator: "Site Finder · investigation", crypto_wallet_logger: "Wallet Logger",
  wallet_investigator: "Wallet Investigator", form_submitter: "Form Submitter", operation_hunter: "Operation Hunter", platform: "Main",
};
export const CLASS_LABEL: Record<string, { label: string; basis: "observed" | "analysis" | "person" }> = {
  observed_website: { label: "Seen on the site", basis: "observed" },
  blockchain_fact: { label: "On-chain record", basis: "observed" },
  derived_observation: { label: "Software analysis", basis: "analysis" },
  analyst_note: { label: "Analyst note", basis: "person" },
};
export const SHARED_INFRA_NOTE = "Shared hosting, page templates, kits or transactions show a similarity; on their own they do not prove the same people run these sites.";

const parse = <T = Row>(v: unknown, d: T): T => { if (v == null || v === "") return d; if (typeof v !== "string") return v as T; try { return JSON.parse(v) as T; } catch { return d; } };
const str = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
export const domainOf = (v: unknown) => {
  const s = String(v ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0].replace(/^www\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : "";
};
/** Main stores wallet keys lower-cased; show the address as the module reported it (TRON and other base58 addresses are case-sensitive). */
const addressOf = (key: string, display?: unknown) => {
  const bare = key.includes(":") ? key.split(":").pop()! : key;
  const d = String(display ?? "").trim();
  const shown = d.includes(":") ? d.split(":").pop()! : d;
  return shown && shown.toLowerCase() === bare ? shown : bare;
};
const PLAIN_TYPE: Record<string, string> = {
  wallet_display: "Wallet address shown on the page", deposit_instructions: "Deposit instructions on the page", public_triage: "Public check of the site",
  page_capture: "Page captured", screenshot: "Screenshot of the page",
};
/** Evidence titles and text in plain words: module names and raw JSON stay behind Details. */
function plainEvidence(title: unknown, type: unknown, text: unknown) {
  let t = str(title, 200).replace(/^(Site Investigator|Site Finder|Wallet Logger|Wallet Investigator|Form Submitter)\s*:\s*/i, "");
  const ty = str(type, 60);
  if (!t || t === ty || /^[a-z0-9_]+$/.test(t)) t = PLAIN_TYPE[ty] ?? (ty ? ty.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : "Evidence");
  let body = str(text, 400).trim();
  if (/^[{[]/.test(body)) {
    const j = parse<Row | null>(body, null);
    if (j && typeof j === "object") {
      const w = j.wallet ?? j.address;
      body = w ? `Address ${str(w, 120)}${j.network ? ` (${str(j.network, 30)})` : ""}.` : Object.entries(j).filter(([, v]) => typeof v !== "object").slice(0, 4).map(([k, v]) => `${k.replace(/_/g, " ")}: ${str(v, 80)}`).join(" · ");
    }
  }
  return { title: t, text: body };
}
const BASIS_ORDER: Record<string, number> = { observed_website: 0, analyst_note: 1, blockchain_fact: 2, derived_observation: 3 };
async function all(sql: string, ...args: unknown[]) { return (await getD1().prepare(sql).bind(...args).all<Row>()).results; }
async function one(sql: string, ...args: unknown[]) { return await getD1().prepare(sql).bind(...args).first<Row>(); }
async function n(sql: string, ...args: unknown[]) { return Number((await one(sql, ...args))?.n ?? 0); }
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> { try { return await fn(); } catch { return fallback; } }

// ------------------------------------------------------------------------------ modules

const FRESH_SECONDS = 180;
export async function moduleHealth() {
  const rows = await all("SELECT module_name,connection_status,runtime_status,module_version,last_heartbeat_at,last_successful_sync_at,last_error FROM module_registry");
  const now = Date.now();
  const by = new Map(rows.map(r => [String(r.module_name), r]));
  const state = (m: string) => {
    const r = by.get(m);
    if (!r) return { module: m, state: "not_connected", seen: null as string | null, version: null as string | null };
    const t = r.last_heartbeat_at ? Date.parse(String(r.last_heartbeat_at).replace(" ", "T") + (String(r.last_heartbeat_at).includes("Z") ? "" : "Z")) : NaN;
    const fresh = Number.isFinite(t) && now - t < FRESH_SECONDS * 1000;
    return { module: m, state: fresh ? "online" : "offline", seen: r.last_heartbeat_at ? String(r.last_heartbeat_at) : null, version: r.module_version ? String(r.module_version) : null };
  };
  return {
    site_finder: [state("site_finder"), state("site_investigator")],
    wallet_investigator: [state("wallet_investigator")],
    wallet_logger: [state("crypto_wallet_logger")],
    form_submitter: [state("form_submitter")],
    operation_hunter: [state("operation_hunter")],
  };
}

// ------------------------------------------------------------------------------ home

export async function home() {
  const since = new Date(Date.now() - 86400000).toISOString().replace("T", " ").slice(0, 19);
  const [health, tasks] = await Promise.all([moduleHealth(), safe(async () => (await import("./ops/view")).humanTasks(), { tasks: [], counts: {} } as unknown as Awaited<ReturnType<typeof import("./ops/view").humanTasks>>)]);
  const finder = {
    to_review: await n("SELECT COUNT(*) n FROM inbox_candidates WHERE status IN ('ready','presented')"),
    found_24h: await n("SELECT COUNT(*) n FROM inbox_candidates WHERE created_at>=?", since),
    useful_total: await n("SELECT COUNT(*) n FROM inbox_candidates WHERE decision='useful'"),
    investigating: await n("SELECT COUNT(*) n FROM jobs WHERE job_type IN ('INVESTIGATE_SITE','RECHECK_SITE') AND status IN ('pending','running','retrying')"),
  };
  const wallets = {
    known: await n("SELECT COUNT(*) n FROM entities WHERE entity_type='wallet'"),
    analysed: await n("SELECT COUNT(DISTINCT target_entity_id) n FROM jobs WHERE job_type='ANALYZE_WALLET' AND status='completed'"),
    analysing: await n("SELECT COUNT(*) n FROM jobs WHERE job_type='ANALYZE_WALLET' AND status IN ('pending','running','retrying')"),
  };
  const logger = {
    captures_24h: await n("SELECT COUNT(*) n FROM observations WHERE source_module='crypto_wallet_logger' AND observed_at>=?", since),
    captures_total: await n("SELECT COUNT(*) n FROM observations WHERE source_module='crypto_wallet_logger'"),
    last_capture: (await one("SELECT MAX(observed_at) at FROM observations WHERE source_module='crypto_wallet_logger'"))?.at ?? null,
  };
  const reports = {
    needs_review: await n("SELECT COUNT(*) n FROM report_candidates WHERE status='needs_review'"),
    ready: await n("SELECT COUNT(*) n FROM report_candidates WHERE status IN ('ready','prefilling','submitting','verifying')"),
    submitted: await n("SELECT COUNT(*) n FROM report_candidates WHERE status='completed'"),
    failed: await n("SELECT COUNT(*) n FROM report_candidates WHERE status IN ('failed','blocked')"),
  };
  const hunter = await safe(async () => ({
    operations: await n("SELECT COUNT(*) n FROM hunter_operations WHERE is_demo=0"),
    rotating: await n("SELECT COUNT(*) n FROM hunter_operations WHERE is_demo=0 AND model_status IN ('rotating','active')"),
    open_proposals: await n("SELECT COUNT(*) n FROM hunter_proposals WHERE outcome IN ('work_proposed','candidate_created')"),
  }), { operations: 0, rotating: 0, open_proposals: 0 });
  const happened = await safe(() => all(`SELECT t.event_type,t.title,t.detail,t.source_module,t.created_at,t.investigation_id FROM investigation_timeline t
    WHERE t.severity IN ('info','warning','important','success') ORDER BY t.created_at DESC LIMIT 12`), [] as Row[]);
  const counts = (tasks as { counts?: Record<string, number> }).counts ?? {};
  return {
    tools: {
      finder: { ...finder, modules: health.site_finder },
      wallets: { ...wallets, modules: health.wallet_investigator },
      logger: { ...logger, modules: health.wallet_logger },
      reports: { ...reports, modules: health.form_submitter },
      hunter: { ...hunter, modules: health.operation_hunter },
    },
    needs_you: Object.values(counts).reduce((s, x) => s + Number(x), 0),
    needs_you_counts: counts,
    happened: happened.map(h => ({ title: str(h.title, 200), detail: str(h.detail, 300), tool: TOOL_OF_MODULE[String(h.source_module)] ?? "Main", at: h.created_at, investigation_id: h.investigation_id ?? null })),
  };
}

// ------------------------------------------------------------------------------ Site Finder

/** Site Finder's "Found this because ..." path, as sent in the candidate's novelty block. */
function explainOf(v: unknown) {
  if (!v || typeof v !== "object") return null;
  const e = v as Row;
  const steps = (Array.isArray(e.steps) ? e.steps as unknown[] : []).map(x => str(x, 300)).filter(Boolean).slice(0, 6);
  if (!e.because && !steps.length) return null;
  return { because: str(e.because, 300), steps, hops: Number(e.hops ?? steps.length), hunt: str(e.hunt, 200), uncertainty: str(e.uncertainty, 300), caveat: str(e.caveat, 400) };
}

function candidateCard(r: Row) {
  const d = parse<Row>(r.details, {});
  const novelty = parse<Row>(d.novelty, {});
  const signals = (Array.isArray(d.signals) ? d.signals as Row[] : []).filter(s => Number(s.strength ?? 0) >= 0.4).slice(0, 4).map(s => str(s.phrase, 120)).filter(Boolean);
  const hunter = String(r.source_module) === "operation_hunter";
  return {
    id: String(r.id), domain: String(r.canonical_domain), url: String(r.url ?? `https://${r.canonical_domain}/`), status: String(r.status),
    discovery_quality:parse<Row>(d.discovery_quality,{}), headline: str(r.headline, 300), category: str(r.category, 60), worth_checking: Number(r.score ?? 0),
    found_by: hunter ? "Operation Hunter" : "Site Finder", decision: r.decision ?? null, progress: r.progress_state ?? null,
    investigation_id: r.investigation_id ?? null, wallets: parse<string[]>(r.wallets, []).slice(0, 6),
    why: [...(Array.isArray(novelty.facts) ? (novelty.facts as unknown[]).map(f => str(f, 240)) : []), ...signals].slice(0, 5),
    route: novelty.route ? { route: str(novelty.route, 40).replace(/^pu:/, ""), depth: Number(novelty.depth ?? 0), from: novelty.parent ? str(novelty.parent, 120) : null } : null,
    because: explainOf(novelty.explain), value: novelty.expected_value == null ? null : Number(novelty.expected_value),
    new_family: Boolean(novelty.new_family), returned_from: novelty.returned_from ? str(novelty.returned_from, 120) : null,
    related: parse<string[]>(r.related_domains, []).slice(0, 6), created_at: r.created_at,
    note: hunter ? "Proposed by Operation Hunter from its reconstruction. A reason to look, not a conclusion." : "Observed public facts and software-derived scores: a reason to look, not a conclusion.",
  };
}

export async function finder() {
  const queue = await all("SELECT * FROM inbox_candidates WHERE status IN ('ready','presented') ORDER BY score DESC, created_at DESC LIMIT 20");
  const working = await all("SELECT * FROM inbox_candidates WHERE decision='useful' ORDER BY decided_at DESC LIMIT 20");
  const recentSkips = await n("SELECT COUNT(*) n FROM inbox_candidates WHERE decision='skip' AND decided_at>=datetime('now','-7 day')");
  const discovery = await one("SELECT status,updated_at,result FROM jobs WHERE target_module='site_finder' ORDER BY updated_at DESC LIMIT 1");
  const jobsOpen = await n("SELECT COUNT(*) n FROM jobs WHERE target_module='site_finder' AND status IN ('pending','running','retrying')");
  const routes = new Map<string, number>();
  for (const r of await all("SELECT details FROM inbox_candidates WHERE created_at>=datetime('now','-7 day') LIMIT 400")) {
    const d = parse<Row>(r.details, {});
    const nv = parse<Row>(d.novelty, {});
    const key = nv.route ? `pivot:${String(nv.route).split("+")[0].replace(/^pu:/, "")}` : String((Array.isArray(d.strategies) ? d.strategies[0] : "") || "other");
    routes.set(key, (routes.get(key) ?? 0) + 1);
  }
  const health = (await moduleHealth()).site_finder;
  const hunts = await safe(() => all(`SELECT id,kind,title,state,operation,found,useful,searches,open_pivots,followed_pivots,stop_reason,reported_at FROM finder_hunts
      ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'parked' THEN 1 ELSE 2 END, found DESC, reported_at DESC LIMIT 80`), [] as Row[]);
  return {
    hunts: hunts.map(h => ({ id: String(h.id), kind: String(h.kind), title: str(h.title, 200), state: String(h.state), operation: h.operation ? String(h.operation) : null,
      found: Number(h.found ?? 0), useful: Number(h.useful ?? 0), searches: Number(h.searches ?? 0), open_pivots: Number(h.open_pivots ?? 0),
      followed_pivots: Number(h.followed_pivots ?? 0), stop_reason: str(h.stop_reason, 300), reported_at: h.reported_at })),
    queue: await Promise.all(queue.map(async r=>({...candidateCard(r),assessment:await finderAssessment(r)}))), working: await Promise.all(working.map(async r => ({ ...candidateCard(r),assessment:await finderAssessment(r), stage: await siteStage(r) }))),
    skipped_7d: recentSkips,
    discovery: { open_requests: jobsOpen, last: discovery ? { status: String(discovery.status), at: discovery.updated_at } : null,
      routes: [...routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([route, count]) => ({ route, count })) },
    modules: health,
  };
}

async function siteStage(r: Row) {
  const inv = r.investigation_id ? String(r.investigation_id) : null;
  if (!inv) return "Waiting for its investigation to be created";
  const j = await one("SELECT job_type,status FROM jobs WHERE investigation_id=? AND job_type IN ('INVESTIGATE_SITE','RECHECK_SITE') ORDER BY created_at DESC LIMIT 1", inv);
  const wallets = await n("SELECT COUNT(*) n FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='wallet'", inv);
  const analysed = await n("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='ANALYZE_WALLET' AND status='completed'", inv);
  if (analysed) return `${analysed} wallet analysis${analysed > 1 ? "es" : ""} done`;
  if (wallets) return `${wallets} wallet${wallets > 1 ? "s" : ""} collected`;
  if (j?.status === "completed") return "Site investigated · waiting for wallet evidence";
  if (j) return j.status === "running" ? "Investigating the site now" : "Site investigation queued";
  return "Useful · waiting for investigation";
}

/** Everything Main knows about one site, across all five tools. */
export async function site(domainRaw: string) {
  const domain = domainOf(domainRaw);
  if (!domain) return null;
  const cand = await one("SELECT * FROM inbox_candidates WHERE canonical_domain=?", domain);
  const entity = await one("SELECT * FROM entities WHERE entity_type IN ('site','related_site') AND canonical_key=? ORDER BY CASE entity_type WHEN 'site' THEN 0 ELSE 1 END LIMIT 1", domain);
  const invIds = new Set<string>();
  if (cand?.investigation_id) invIds.add(String(cand.investigation_id));
  if (entity) for (const r of await all("SELECT DISTINCT investigation_id FROM investigation_entities WHERE entity_id=? AND investigation_id IS NOT NULL LIMIT 10", entity.id)) invIds.add(String(r.investigation_id));
  const ids = [...invIds];
  const ph = ids.map(() => "?").join(",") || "''";
  const investigations = ids.length ? await all(`SELECT id,external_id,title,status,updated_at FROM investigations WHERE id IN (${ph})`, ...ids) : [];
  const evidence = ids.length ? await all(`SELECT id,investigation_id,source_module,evidence_type,evidence_class,observation_scope,title,uri,context_text,captured_at,metadata FROM evidence WHERE investigation_id IN (${ph}) ORDER BY captured_at DESC LIMIT 60`, ...ids) : [];
  const wallets = ids.length ? await all(`SELECT DISTINCT e.id,e.canonical_key,e.display_name,e.classification,ie.source_module FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id IN (${ph}) AND e.entity_type='wallet' LIMIT 40`, ...ids) : [];
  const jobs = ids.length ? await all(`SELECT id,job_type,status,target_module,created_at,updated_at,progress_message FROM jobs WHERE investigation_id IN (${ph}) ORDER BY created_at DESC LIMIT 30`, ...ids) : [];
  const related = entity ? await all(`SELECT r.relationship_type,r.assertion_kind,r.source_module,e2.entity_type,e2.canonical_key FROM relationships r JOIN entities e2 ON e2.id=CASE WHEN r.source_entity_id=? THEN r.target_entity_id ELSE r.source_entity_id END
      WHERE (r.source_entity_id=? OR r.target_entity_id=?) LIMIT 40`, entity.id, entity.id, entity.id) : [];
  const reports = ids.length ? await all(`SELECT id,investigation_id,status,verification_status,created_at,updated_at FROM report_candidates WHERE investigation_id IN (${ph}) ORDER BY created_at DESC LIMIT 5`, ...ids) : [];
  const operations = await safe(async () => (await import("./ops/hunter")).operationsForSite(domain), [] as unknown[]);
  const campaigns = await safe(() => all("SELECT c.id,c.title,c.status FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE m.domain=? LIMIT 5", domain), [] as Row[]);
  const byWallet = new Map<string, Row>();
  for (const w of wallets) {
    const key = String(w.canonical_key);
    const cur = byWallet.get(key) ?? { key, id: w.id, address: addressOf(key, w.display_name), network: key.includes(":") ? key.split(":")[0] : "unknown", seen_by: [] as string[], classification: w.classification };
    (cur.seen_by as string[]).push(SOURCE_LABEL[String(w.source_module)] ?? String(w.source_module));
    byWallet.set(key, cur);
  }
  const summary: string[] = [];
  const observed = evidence.filter(e => CLASS_LABEL[String(e.evidence_class)]?.basis === "observed").length;
  if (cand?.headline) summary.push(`Why it was found: ${str(cand.headline, 200)}`);
  if (observed) summary.push(`${observed} piece${observed > 1 ? "s" : ""} of evidence seen directly on the site or on-chain.`);
  if (byWallet.size) summary.push(`${byWallet.size} wallet${byWallet.size > 1 ? "s" : ""} shown on or linked to this site.`);
  if ((operations as unknown[]).length) summary.push(`Operation Hunter counts it as part of ${(operations as unknown[]).length} reconstructed operation${(operations as unknown[]).length > 1 ? "s" : ""} (analysis, not proof of who runs it).`);
  if (!summary.length) summary.push("Main has no evidence about this site yet.");
  const next: string[] = [];
  if (!cand?.decision && cand) next.push("Review it: mark it Useful to start the site investigation, or Skip.");
  else if (!jobs.some(j => j.job_type === "INVESTIGATE_SITE")) next.push("Investigate the site to collect page evidence and wallets.");
  if (byWallet.size && !jobs.some(j => j.job_type === "ANALYZE_WALLET")) next.push("Analyse its wallets in Wallet Investigator.");
  if (!(operations as unknown[]).length && (cand?.decision === "useful" || byWallet.size)) next.push("Ask Operation Hunter to reconstruct the operation behind it.");
  if (evidence.length >= 2 && !reports.length) next.push("Prepare a report candidate for Form Submitter (you approve it before anything is sent).");
  return {
    domain, url: String(cand?.url ?? `https://${domain}/`),
    candidate: cand ? candidateCard(cand) : null,
    summary, next,
    investigations: investigations.map(i => ({ id: String(i.id), title: str(i.title, 200), status: String(i.status), updated_at: i.updated_at })),
    // What was seen on the site first, then people's notes, then on-chain records and analysis.
    evidence: [...evidence].sort((a, b) => (BASIS_ORDER[String(a.evidence_class)] ?? 4) - (BASIS_ORDER[String(b.evidence_class)] ?? 4)).map(e => ({ id: String(e.id), ...plainEvidence(e.title, e.evidence_type, e.context_text), type: str(e.evidence_type, 60), source: SOURCE_LABEL[String(e.source_module)] ?? String(e.source_module),
      basis: CLASS_LABEL[String(e.evidence_class)] ?? { label: String(e.evidence_class), basis: "analysis" }, scope: String(e.observation_scope ?? "public"),
      uri: e.uri ?? null, at: e.captured_at })),
    wallets: [...byWallet.values()],
    related: related.map(r => ({ type: str(r.relationship_type, 60), kind: String(r.assertion_kind) === "derived" ? "analysis" : "observed", source: SOURCE_LABEL[String(r.source_module)] ?? String(r.source_module), entity_type: String(r.entity_type), key: str(r.canonical_key, 200) })),
    jobs: jobs.map(j => ({ id: String(j.id), type: String(j.job_type), status: String(j.status), tool: TOOL_OF_MODULE[String(j.target_module)] ?? String(j.target_module), message: str(j.progress_message, 200), at: j.updated_at })),
    reports: reports.map(r => ({ id: String(r.id), investigation_id: String(r.investigation_id), status: String(r.status), verification: String(r.verification_status) })),
    operations, campaigns, note: SHARED_INFRA_NOTE,
  };
}

// ------------------------------------------------------------------------------ Wallet Investigator

export async function wallets(limit = 80) {
  const rows = await all(`SELECT e.id,e.canonical_key,e.display_name,e.classification,e.updated_at,
      (SELECT COUNT(DISTINCT ie.investigation_id) FROM investigation_entities ie WHERE ie.entity_id=e.id) investigations,
      (SELECT status FROM jobs j WHERE j.target_entity_id=e.id AND j.job_type='ANALYZE_WALLET' ORDER BY j.created_at DESC LIMIT 1) analysis,
      (SELECT GROUP_CONCAT(DISTINCT ie.source_module) FROM investigation_entities ie WHERE ie.entity_id=e.id) sources
    FROM entities e WHERE e.entity_type='wallet' ORDER BY e.updated_at DESC LIMIT ?`, Math.max(1, Math.min(200, limit)));
  return {
    wallets: rows.map(r => {
      const key = String(r.canonical_key);
      return { id: String(r.id), key, address: addressOf(key, r.display_name), network: key.includes(":") ? key.split(":")[0] : "unknown",
        investigations: Number(r.investigations ?? 0), analysis: r.analysis ? String(r.analysis) : "not_started",
        seen_by: String(r.sources ?? "").split(",").filter(Boolean).map(s => SOURCE_LABEL[s] ?? s), updated_at: r.updated_at };
    }),
    modules: (await moduleHealth()).wallet_investigator,
  };
}

export async function wallet(idOrKey: string) {
  const w = await one("SELECT * FROM entities WHERE entity_type='wallet' AND (id=? OR canonical_key=? OR canonical_key LIKE ?) LIMIT 1", idOrKey, idOrKey.toLowerCase(), `%:${idOrKey.toLowerCase()}`);
  if (!w) return null;
  const key = String(w.canonical_key);
  const address = key.includes(":") ? key.split(":").pop()! : key;
  const shown = addressOf(key, w.display_name);
  const sites = await all(`SELECT DISTINCT s.canonical_key domain,r.source_module,r.assertion_kind FROM relationships r JOIN entities s ON s.id=r.source_entity_id AND s.entity_type IN ('site','related_site','page')
      WHERE r.target_entity_id=? AND r.relationship_type='displays_wallet' LIMIT 40`, w.id);
  const viaInvestigations = await all(`SELECT DISTINCT e.canonical_key domain,ie2.source_module FROM investigation_entities ie JOIN investigation_entities ie2 ON ie2.investigation_id=ie.investigation_id
      JOIN entities e ON e.id=ie2.entity_id AND e.entity_type='site' WHERE ie.entity_id=? LIMIT 40`, w.id);
  // Wallet Investigator's records carry the job that produced them (provenance.origin_job_id); the job targets this wallet.
  const jobIds = (await all("SELECT id FROM jobs WHERE target_entity_id=? AND job_type IN ('ANALYZE_WALLET','REFRESH_WALLET') ORDER BY created_at DESC LIMIT 5", w.id)).map(r => String(r.id));
  const jph = jobIds.map(() => "?").join(",") || "''";
  const tx = jobIds.length ? await all(`SELECT o.data FROM observations o WHERE o.source_module='wallet_investigator' AND o.record_type='transaction' AND json_extract(o.data,'$.provenance.origin_job_id') IN (${jph}) LIMIT 400`, ...jobIds) : [];
  const cpObs = jobIds.length ? await all(`SELECT o.data FROM observations o WHERE o.source_module='wallet_investigator' AND o.record_type='counterparty' AND json_extract(o.data,'$.provenance.origin_job_id') IN (${jph}) LIMIT 100`, ...jobIds) : [];
  const cpRel = await all(`SELECT e2.canonical_key,r.relationship_type,r.confidence FROM relationships r JOIN entities e2 ON e2.id=CASE WHEN r.source_entity_id=? THEN r.target_entity_id ELSE r.source_entity_id END
      WHERE (r.source_entity_id=? OR r.target_entity_id=?) AND r.source_module='wallet_investigator' LIMIT 60`, w.id, w.id, w.id);
  const counterparties = [
    ...cpRel.map(c => ({ canonical_key: c.canonical_key, relationship_type: c.relationship_type, confidence: c.confidence })),
    ...cpObs.map(o => { const d = parse<Row>(o.data, {}); return { canonical_key: `${str(d.network, 30)}:${str(d.address, 120)}`, relationship_type: `${Number(d.tx_count ?? 0)} transaction${Number(d.tx_count ?? 0) === 1 ? "" : "s"}`, confidence: 1 }; }),
  ].filter((c, i, arr) => arr.findIndex(x => x.canonical_key === c.canonical_key) === i);
  const evidence = await all("SELECT id,title,evidence_type,evidence_class,source_module,context_text,captured_at FROM evidence WHERE entity_id=? ORDER BY captured_at DESC LIMIT 40", w.id);
  const findings = await all("SELECT finding_type,title,body,confidence,source_module FROM findings WHERE entity_id=? ORDER BY observed_at DESC LIMIT 20", w.id);
  const analysis = await one("SELECT id,status,updated_at,result FROM jobs WHERE target_entity_id=? AND job_type='ANALYZE_WALLET' ORDER BY created_at DESC LIMIT 1", w.id);
  const roles = await safe(() => all("SELECT m.role,m.why,h.name,h.external_id FROM hunter_operation_members m JOIN hunter_operations h ON h.id=m.operation_id WHERE m.entity_type='wallet' AND (m.canonical_key=? OR m.canonical_key=?) LIMIT 5", key, address.toLowerCase()), [] as Row[]);
  // Money flow in plain words, from the transactions Wallet Investigator recorded.
  const flows = { in: 0, out: 0, assets: new Map<string, { in: number; out: number }>(), largest: 0 };
  for (const t of tx) {
    const d = parse<Row>(t.data, {});
    const dir = String(d.direction ?? "").toLowerCase();
    const amt = Number(d.amount ?? 0);
    const asset = str(d.asset ?? d.token ?? "?", 20);
    const a = flows.assets.get(asset) ?? { in: 0, out: 0 };
    if (dir.startsWith("in")) { flows.in++; a.in += Number.isFinite(amt) ? amt : 0; } else if (dir.startsWith("out")) { flows.out++; a.out += Number.isFinite(amt) ? amt : 0; }
    if (Number.isFinite(amt)) flows.largest = Math.max(flows.largest, amt);
    flows.assets.set(asset, a);
  }
  const explain: string[] = [];
  if (!analysis) explain.push("This wallet has not been analysed yet. Analysing it reads public blockchain records only; nothing is sent to the wallet.");
  else if (analysis.status !== "completed") explain.push(`Analysis is ${String(analysis.status)}.`);
  if (tx.length) {
    explain.push(`Wallet Investigator recorded ${tx.length} transaction${tx.length > 1 ? "s" : ""}: ${flows.in} incoming and ${flows.out} outgoing.`);
    for (const [asset, a] of [...flows.assets.entries()].slice(0, 3)) if (a.in || a.out) explain.push(`${asset}: about ${fmtAmt(a.in)} received and ${fmtAmt(a.out)} sent in the recorded window.`);
    if (flows.in && flows.out && flows.out >= flows.in * 0.8) explain.push("Most of what arrives is moved on again, which is typical of a collection or pass-through wallet. That is a pattern, not proof of intent.");
  }
  if (counterparties.length) explain.push(`${counterparties.length} counterpart${counterparties.length > 1 ? "ies" : "y"} found in its transactions (on-chain links, not identities).`);
  for (const r of roles) explain.push(`Operation Hunter places it in the money flow of ${str(r.name, 80)} as ${String(r.role).toLowerCase()} (analysis).`);
  const siteList = [...new Map([...sites, ...viaInvestigations].map(s => [String(s.domain), { domain: String(s.domain), source: SOURCE_LABEL[String(s.source_module)] ?? String(s.source_module), observed: String(s.assertion_kind ?? "observed") !== "derived" }])).values()];
  if (siteList.length) explain.unshift(`Shown on ${siteList.length} site${siteList.length > 1 ? "s" : ""}${siteList.length > 1 ? ". The same deposit address on several sites is a strong link between those pages, though not by itself proof of the same operator" : ""}.`);
  return {
    id: String(w.id), key, address: shown, network: key.includes(":") ? key.split(":")[0] : "unknown", classification: w.classification ?? null,
    explain, sites: siteList, counterparties: counterparties.map(c => ({ key: str(c.canonical_key, 200), type: str(c.relationship_type, 60), confidence: Number(c.confidence ?? 0) })),
    transactions: tx.slice(0, 50).map(t => { const d = parse<Row>(t.data, {}); return { hash: str(d.tx_hash, 100), direction: str(d.direction, 10), amount: str(d.amount, 40), asset: str(d.asset ?? d.token, 20), at: d.timestamp ?? d.observed_at ?? null }; }),
    evidence: evidence.map(e => ({ id: String(e.id), ...plainEvidence(e.title, e.evidence_type, e.context_text), basis: CLASS_LABEL[String(e.evidence_class)] ?? { label: String(e.evidence_class), basis: "analysis" }, source: SOURCE_LABEL[String(e.source_module)] ?? String(e.source_module), at: e.captured_at })),
    findings: findings.map(f => ({ type: str(f.finding_type, 60), title: str(f.title, 200), body: str(f.body, 400), source: SOURCE_LABEL[String(f.source_module)] ?? String(f.source_module) })),
    analysis: analysis ? { status: String(analysis.status), at: analysis.updated_at } : null, operations: roles, note: SHARED_INFRA_NOTE,
  };
}
function fmtAmt(x: number) { return x >= 1000 ? `${Math.round(x).toLocaleString("en-US")}` : x.toFixed(x < 1 ? 4 : 2).replace(/\.?0+$/, ""); }

// ------------------------------------------------------------------------------ Wallet Logger

export async function logger(limit = 60) {
  const rows = await all(`SELECT o.id,o.observed_at,o.data,e.canonical_key,e.entity_type FROM observations o JOIN entities e ON e.id=o.entity_id
      WHERE o.source_module='crypto_wallet_logger' ORDER BY o.observed_at DESC LIMIT ?`, Math.max(1, Math.min(200, limit)));
  const captures = rows.filter(r => r.entity_type === "wallet").map(r => {
    const d = parse<Row>(r.data, {});
    const key = String(r.canonical_key);
    const url = str(d.source_url ?? parse<Row>(d.provenance, {}).source_url, 400);
    return { id: String(r.id), wallet: addressOf(key, d.address ?? d.display_name), network: key.includes(":") ? key.split(":")[0] : str(d.network, 30),
      site: domainOf(url) || str(d.domain, 200), page: url, confidence: Number(d.confidence ?? 0), at: r.observed_at };
  });
  const sites = new Map<string, { domain: string; wallets: Set<string>; last: unknown }>();
  for (const c of captures) { if (!c.site) continue; const s = sites.get(c.site) ?? { domain: c.site, wallets: new Set<string>(), last: c.at }; s.wallets.add(String(c.wallet)); sites.set(c.site, s); }
  const reg = await one("SELECT last_heartbeat_at,last_successful_sync_at,records_received FROM module_registry WHERE module_name='crypto_wallet_logger'");
  return {
    captures, sites: [...sites.values()].map(s => ({ domain: s.domain, wallets: s.wallets.size, last: s.last })),
    sync: { last_capture: captures[0]?.at ?? null, last_sync: reg?.last_successful_sync_at ?? null, records: Number(reg?.records_received ?? 0) },
    note: "Wallet Logger is a passive browser extension: it records wallet addresses shown on pages you visit yourself. It never navigates, clicks or submits anything.",
  };
}

// ------------------------------------------------------------------------------ Form Submitter

export async function reports() {
  const rows = await all(`SELECT r.*,i.title inv_title,a.status approval,a.decided_by,a.decision_reason,j.status job_status,j.updated_at job_at,c.kind,c.ready v4_ready,c.summary v4_summary,c.warnings v4_warnings
      FROM report_candidates r LEFT JOIN investigations i ON i.id=r.investigation_id LEFT JOIN approval_gates a ON a.id=r.approval_id LEFT JOIN jobs j ON j.id=r.submission_job_id LEFT JOIN report_contents c ON c.candidate_id=r.id
      WHERE r.status<>'superseded' ORDER BY r.updated_at DESC LIMIT 60`);
  const items = [];
  for (const r of rows) {
    const inv = String(r.investigation_id);
    const ev = await one("SELECT COUNT(*) n,COUNT(DISTINCT source_module) sources,SUM(CASE WHEN evidence_class IN ('observed_website','blockchain_fact') THEN 1 ELSE 0 END) observed FROM evidence WHERE investigation_id=?", inv);
    const walletsN = await n("SELECT COUNT(*) n FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='wallet'", inv);
    const siteRow = await one("SELECT e.canonical_key FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='site' LIMIT 1", inv);
    const checks = [
      { label: "At least two captured evidence items", ok: Number(ev?.n ?? 0) >= 2 },
      { label: "Evidence seen directly on the site or on-chain", ok: Number(ev?.observed ?? 0) >= 1 },
      { label: "A wallet address to report", ok: walletsN > 0 },
      { label: "Evidence from more than one tool", ok: Number(ev?.sources ?? 0) >= 2 },
      { label: "Approved by you", ok: String(r.approval ?? "") === "approved" },
    ];
    const v4 = r.kind === "wallet-report-v4";
    const v4Summary = v4 ? JSON.parse(String(r.v4_summary ?? "{}")) as { wallets?: Array<Record<string, unknown>>; destination?: Record<string, unknown> | null; site?: Record<string, unknown> | null } : null;
    const v4Warnings = v4 ? JSON.parse(String(r.v4_warnings ?? "[]")) as string[] : [];
    if (v4) checks.splice(0, checks.length,
      { label: "Confirmed deposit wallets (validated by Wallet Investigator)", ok: (v4Summary?.wallets?.length ?? 0) > 0 },
      { label: "Every wallet has deposit evidence with its source page and time", ok: Boolean(r.v4_ready) || !v4Warnings.some(w => w.includes("provenance")) },
      { label: "Submission destination configured", ok: Boolean(v4Summary?.destination) },
      { label: "Approved by you", ok: String(r.approval ?? "") === "approved" });
    const stage = ({ needs_review: v4 && !r.v4_ready ? "Report building" : v4 ? "Ready to report" : "Waiting for your approval", stale: "Approval withdrawn: the report changed", ready: "Approved · Form Submitter will prepare it", blocked: "Rejected", prefilling: "Filling in the form", submitting: "Submitting",
      verifying: "Checking the confirmation", completed: String(r.verification_status) === "verified" ? "Submitted and confirmed" : "Submitted (confirmation not verified)", failed: "Submission failed", unknown: "Status unknown" } as Record<string, string>)[String(r.status)] ?? String(r.status);
    items.push({ id: String(r.id), investigation_id: inv, title: str(r.inv_title ?? inv, 200), site: siteRow ? String(siteRow.canonical_key) : null, status: String(r.status), stage,
      verification: String(r.verification_status), approval: r.approval ?? null, decided_by: r.decided_by ?? null, reason: r.decision_reason ?? null, evidence: Number(ev?.n ?? 0), wallets: walletsN,
      checks, ready_to_approve: String(r.status) === "needs_review" && (v4 ? Boolean(r.v4_ready) : checks.slice(0, 3).every(c => c.ok)), updated_at: r.updated_at,
      kind: v4 ? "wallet-report-v4" : "evidence", content_sha256: String(r.evidence_sha256), summary: v4Summary, warnings: v4Warnings });
  }
  const eligible = await all(`SELECT i.id,i.title,(SELECT COUNT(*) FROM evidence ev WHERE ev.investigation_id=i.id) evidence FROM investigations i
      WHERE NOT EXISTS (SELECT 1 FROM report_candidates r WHERE r.investigation_id=i.id) AND (SELECT COUNT(*) FROM evidence ev WHERE ev.investigation_id=i.id)>=2
      ORDER BY i.updated_at DESC LIMIT 20`);
  return { reports: items, could_prepare: eligible.map(e => ({ investigation_id: String(e.id), title: str(e.title, 200), evidence: Number(e.evidence ?? 0) })),
    modules: (await moduleHealth()).form_submitter,
    note: "Nothing is filed until you approve the frozen evidence snapshot. Form Submitter then fills the form and records the confirmation it receives." };
}

// ------------------------------------------------------------------------------ Operation Hunter

export async function hunter(opId?: string | null) {
  const { hunterOperations, hunterOperation } = await import("./ops/hunter");
  const list = await safe(() => hunterOperations(40), { connected: false, operations: [] as Row[], disclaimer: "" } as { connected: boolean; operations: Row[]; disclaimer: string });
  const ops = (list.operations as Row[]).filter(o => !o.is_demo || (list.operations as Row[]).every(x => x.is_demo));
  const focus = opId ? await safe(() => hunterOperation(opId), null) : ops[0] ? await safe(() => hunterOperation(String(ops[0].external_id)), null) : null;
  return { connected: list.connected, disclaimer: list.disclaimer, operations: ops, focus, modules: (await moduleHealth()).operation_hunter };
}

// ------------------------------------------------------------------------------ actions

export type SuiteAction =
  | { action: "review"; domain: string; decision: "useful" | "skip"; reason?: string }
  | { action: "investigate_site"; domain: string }
  | { action: "find_related"; domain: string; reason?: string }
  | { action: "reconstruct_operation"; domain: string }
  | { action: "analyze_wallet"; wallet: string }
  | { action: "prepare_report"; investigation_id: string };

export async function act(a: SuiteAction) {
  const { proposeWork } = await import("./ops/workitems");
  const db = getD1();
  if (a.action === "review") {
    const cand = await one("SELECT id FROM inbox_candidates WHERE canonical_domain=?", domainOf(a.domain));
    if (!cand) return { ok: false, code: "NOT_IN_INBOX", message: "This site is not in the review queue." };
    const { decide } = await import("./inbox");
    const r = await decide(String(cand.id), a.decision, a.reason ?? null);
    return { ok: true, message: a.decision === "useful" ? "Marked useful: Main will investigate the site and collect its wallets." : "Skipped: Site Finder learns from this.", result: r };
  }
  if (a.action === "investigate_site") {
    const {investigateSite}=await import('./autonomy');
    const result=await investigateSite(a.domain);
    return {ok:true,...result,message:'Investigation started. Browse normally; Main coordinates the evidence and report.'};
  }

  if (a.action === "find_related") {
    const domain = domainOf(a.domain);
    if (!domain) return { ok: false, code: "INVALID_SITE", message: "Give a site name." };
    const w = await proposeWork({ kind: "find_related_sites", targetType: "domain", targetKey: domain, fingerprint: `find_related:ui:${domain}`, source: "command", reason: a.reason ?? `Find sites related to ${domain}`,
      factors: { info_gain: 0.7, evidence_strength: 0.6, novelty: 0.7, open_gaps: 0.6, cost: 0.3, freshness: 1 } });
    await db.prepare("UPDATE work_items SET result=? WHERE id=? AND status IN ('queued','deferred')").bind(JSON.stringify({ seeds: [domain], reason: "analyst_request", source: "main" }), w.id).run();
    return { ok: true, work_item: w.id, outcome: w.outcome, message: "Site Finder will pivot from this site (build files, certificates, hosting, page scans) and bring back anything new." };
  }
  if (a.action === "reconstruct_operation") {
    const { requestReconstruction } = await import("./ops/hunter");
    const r = await requestReconstruction({ domain: domainOf(a.domain) });
    return { ok: true, result: r, message: "Operation Hunter will reconstruct the operation behind this site when Main schedules it." };
  }
  if (a.action === "analyze_wallet") {
    const w0 = await one("SELECT id FROM entities WHERE entity_type='wallet' AND (id=? OR canonical_key=? OR canonical_key LIKE ?) LIMIT 1", a.wallet, a.wallet.toLowerCase(), `%:${a.wallet.toLowerCase()}`);
    if (!w0) return { ok: false, code: "UNKNOWN_WALLET", message: "Main has no record of this wallet." };
    const w = await proposeWork({ kind: "analyze_wallet", targetType: "wallet", targetKey: String(w0.id), source: "command", reason: "Requested from Wallet Investigator",
      factors: { info_gain: 0.8, evidence_strength: 0.7, novelty: 0.6, cost: 0.3, freshness: 1 } });
    return { ok: true, work_item: w.id, outcome: w.outcome, message: "Queued: Wallet Investigator will read the public chain data for this wallet." };
  }
  if (a.action === "prepare_report") {
    const { createReportCandidate } = await import("./reporting");
    const r = await createReportCandidate(a.investigation_id);
    return r.ok ? { ok: true, result: r, message: "A frozen evidence snapshot is ready for your approval." } : { ok: false, code: r.code, message: r.message };
  }
  return { ok: false, code: "UNKNOWN_ACTION", message: "Unknown action." };
}


// ------------------------------------------------------------------------------ v4 wallet pipeline

/** The active investigation's wallet pipeline (?investigation_id= or ?domain=). */
export async function walletPipeline(investigationId: string | null, domain: string | null) {
  const { walletPipelineView } = await import("./wallet-pipeline");
  let id = investigationId;
  if (!id && domain) {
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    const row = await one("SELECT i.id FROM investigations i JOIN investigation_entities ie ON ie.investigation_id=i.id JOIN entities e ON e.id=ie.entity_id WHERE e.entity_type='site' AND e.canonical_key=? ORDER BY i.created_at LIMIT 1", d);
    id = row ? String(row.id) : null;
  } else if (id) {
    const row = await one("SELECT id FROM investigations WHERE id=? OR external_id=?", id, id);
    id = row ? String(row.id) : null;
  }
  return id ? walletPipelineView(id) : null;
}
