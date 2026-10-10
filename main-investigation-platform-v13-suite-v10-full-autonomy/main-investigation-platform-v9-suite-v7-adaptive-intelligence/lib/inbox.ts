/**
 * Main Platform v2 — the investigation inbox.
 *
 * NEXT SITE -> OPEN SITE -> SKIP / USEFUL -> next candidate.
 *
 * Site Finder v2 delivers only candidates that cleared its precision bar. The
 * platform adds a second line of defence (deduplication against everything it
 * already knows, cluster suppression, a score floor), presents one candidate at
 * a time, and turns each decision into work:
 *
 *   USEFUL  -> a platform-originated `site.triaged` (promoted, request_downstream)
 *              so the planner routes INVESTIGATE_SITE through its normal budget,
 *              capability and freshness checks; FIND_RELATED_SITES for Site
 *              Finder, seeded with the confirmed site; the investigation then
 *              waits for WalletLogger evidence and continues automatically.
 *   SKIP    -> a non-routing `site.triaged` (dismissed), pending jobs for the
 *              site cancelled, not-yet-shown siblings in the same cluster
 *              suppressed.
 *
 * Every decision is appended to `inbox_decisions`, which Site Finder reads
 * through GET /api/v1/inbox/decisions to steer its discovery budget.
 *
 * When fewer than `target_depth` candidates are waiting, the platform queues a
 * DISCOVER_SITES job for Site Finder (bounded by a daily cap).
 *
 * Nothing here treats a candidate as proven malicious. Scores and shared
 * infrastructure are reasons to look, recorded as derived observations.
 */
import { getD1, json, now } from "./platform";
import { publishEvent } from "./events";
import { enqueueJob } from "./jobs";
import { timeline } from "./orchestrator";

type Row = Record<string, unknown>;
export type InboxSettings = {
  target_depth: number; min_score: number; investigate_on_useful: boolean; find_related_on_useful: boolean;
  discovery_http_budget: number; max_discovery_jobs_per_day: number; lease_minutes: number;
};
export const DEFAULT_SETTINGS: InboxSettings = {
  target_depth: 10, min_score: 0.6, investigate_on_useful: true, find_related_on_useful: true,
  discovery_http_budget: 200, max_discovery_jobs_per_day: 48, lease_minutes: 15,
};
const POLICY = { credentials: "none", prohibited: ["credential-guessing", "brute-force", "captcha-bypass", "mfa-bypass", "financial-transactions"], financial_actions_allowed: false };
export const SKIP_REASONS = ["dead_or_parked", "not_a_scam", "duplicate", "not_crypto", "not_useful"] as const;

function parse<T>(value: unknown, fallback: T): T { try { return typeof value === "string" ? JSON.parse(value) as T : (value as T) ?? fallback; } catch { return fallback; } }
function clamp(n: unknown) { const x = Number(n); return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0; }
function domainOf(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  try { return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, ""); } catch { return raw.replace(/^www\./, ""); }
}

export async function getSettings(): Promise<InboxSettings> {
  const out: InboxSettings = { ...DEFAULT_SETTINGS };
  try {
    const rows = await getD1().prepare("SELECT key,value FROM inbox_settings").all<{ key: string; value: string }>();
    for (const r of rows.results) {
      if (!(r.key in out)) continue;
      const cur = (out as Record<string, unknown>)[r.key];
      (out as Record<string, unknown>)[r.key] = typeof cur === "boolean" ? r.value === "true" : Number(r.value);
    }
  } catch { /* table missing before migration 0008: defaults */ }
  return out;
}

export async function updateSettings(partial: Partial<InboxSettings>) {
  const db = getD1();
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
    await db.prepare("INSERT INTO inbox_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(key, String(value)).run();
  }
  return getSettings();
}

/** Called from ingestion for each Site Finder site record that carries a v2 `inbox` block. */
export async function upsertFromFinder(input: { site: Row; investigationId: string | null; entityId: string | null; evidenceId: string | null; sourceRecordId: string }) {
  const block = input.site.inbox as Row | undefined;
  const triage = input.site.triage as Row | undefined;
  if (!block || String(block.version) !== "2" || triage?.outcome !== "promoted") return null;
  const db = getD1();
  const domain = domainOf(block.candidate_id ?? input.site.canonical_key ?? input.site.url);
  if (!domain) return null;
  const score = clamp(block.worth_checking ?? triage.confidence ?? input.site.confidence);
  const wallets = Array.isArray(block.wallets) ? (block.wallets as unknown[]).map(String).slice(0, 50) : [];
  const related = Array.isArray(block.related_domains) ? (block.related_domains as unknown[]).map(domainOf).filter(Boolean).slice(0, 50) : [];
  const cluster = block.cluster_key ? String(block.cluster_key).slice(0, 300) : `c:${domain}`;
  // Only ever hand the browser an http(s) URL on the candidate's own domain.
  let url = `https://${domain}/`;
  try { const u = new URL(String(input.site.url ?? "")); if ((u.protocol === "https:" || u.protocol === "http:") && domainOf(u.hostname) === domain) url = u.toString().slice(0, 2048); } catch { /* keep the default */ }
  const headline = String(block.headline ?? "").slice(0, 300);
  const category = String(block.category ?? "").slice(0, 120);
  const existing = await db.prepare("SELECT * FROM inbox_candidates WHERE canonical_domain=?").bind(domain).first<Row>();
  if (existing) {
    await db.prepare("UPDATE inbox_candidates SET score=?,headline=?,category=?,details=?,related_domains=?,wallets=?,cluster_key=?,url=?,investigation_id=COALESCE(investigation_id,?),entity_id=COALESCE(entity_id,?),evidence_id=COALESCE(?,evidence_id),updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(score, headline, category, json(block), json(related), json(wallets), cluster, url, input.investigationId, input.entityId, input.evidenceId, existing.id).run();
    await observeForOperations(String(existing.id));
    return { id: String(existing.id), status: String(existing.status), updated: true };
  }
  const settings = await getSettings();
  let status = "ready", reason: string | null = null;
  if (score < settings.min_score) { status = "suppressed"; reason = `Score ${score.toFixed(2)} is below the inbox floor ${settings.min_score.toFixed(2)}.`; }
  if (status === "ready" && input.entityId) {
    const other = await db.prepare("SELECT source_module FROM observations WHERE entity_id=? AND source_module NOT IN ('site_finder','platform') LIMIT 1").bind(input.entityId).first<{ source_module: string }>();
    if (other) { status = "suppressed"; reason = `Already has evidence from ${other.source_module}.`; }
  }
  if (status === "ready") {
    const placeholders = related.map(() => "?").join(",");
    const siblings = await db.prepare(`SELECT * FROM inbox_candidates WHERE cluster_key=?${related.length ? ` OR canonical_domain IN (${placeholders})` : ""}`).bind(cluster, ...related).all<Row>();
    const shown = siblings.results.filter(s => s.status !== "suppressed");
    const skipped = shown.filter(s => s.decision === "skip"), kept = shown.filter(s => s.decision === "useful");
    if (skipped.length && !kept.length) { status = "suppressed"; reason = `Related to ${skipped[0].canonical_domain}, which you skipped.`; }
    else if (shown.length) {
      const known = new Set(shown.flatMap(s => parse<string[]>(s.wallets, [])));
      if (!wallets.some(w => !known.has(w))) {
        status = "suppressed"; reason = `Mirror of ${shown[0].canonical_domain} (same kit, no new wallet).`;
        const rel = new Set(parse<string[]>(shown[0].related_domains, [])); rel.add(domain);
        await db.prepare("UPDATE inbox_candidates SET related_domains=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(json([...rel].slice(0, 50)), shown[0].id).run();
      }
    }
  }
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO inbox_candidates (id,canonical_domain,url,status,score,headline,category,cluster_key,related_domains,wallets,source_module,source_record_id,finder_candidate_id,investigation_id,entity_id,evidence_id,details,suppressed_reason) VALUES (?,?,?,?,?,?,?,?,?,?,'site_finder',?,?,?,?,?,?,?)")
    .bind(id, domain, url, status, score, headline, category, cluster, json(related), json(wallets), input.sourceRecordId, String(block.candidate_id ?? domain), input.investigationId, input.entityId, input.evidenceId, json(block), reason).run();
  await observeForOperations(id);
  return { id, status, reason };
}

/**
 * v5 temporal intelligence: record what Site Finder publicly observed about the
 * domain (hosting, name servers, certificate, template, shown wallets). An
 * unchanged observation only refreshes last-seen; a change creates a change
 * record and, where useful, a revisit opportunity. Ingestion must not fail
 * because of it, so errors are logged, not thrown.
 */
async function observeForOperations(candidateId: string) {
  try {
    const row = await getD1().prepare("SELECT * FROM inbox_candidates WHERE id=?").bind(candidateId).first<Row>();
    if (!row) return;
    const { observeCandidate } = await import("./ops/temporal");
    await observeCandidate(row);
  } catch (error) { console.error("v5 temporal observation failed", candidateId, error instanceof Error ? error.message : error); }
}

function card(row: Row) {
  const related = parse<string[]>(row.related_domains, []);
  return { id: String(row.id), domain: String(row.canonical_domain), url: String(row.url), headline: String(row.headline ?? ""),
    category: String(row.category ?? ""), related_count: related.length, score: Number(row.score) };
}

export async function waitingCount() {
  const row = await getD1().prepare("SELECT COUNT(*) n FROM inbox_candidates WHERE status IN ('ready','presented')").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function nextCandidate() {
  const db = getD1(); const settings = await getSettings();
  const row = await db.prepare("SELECT * FROM inbox_candidates WHERE status='ready' OR (status='presented' AND (lease_until IS NULL OR lease_until<?)) ORDER BY score DESC, created_at ASC, rowid ASC LIMIT 1").bind(now()).first<Row>();
  try { await maintainSupply(); } catch (error) { console.warn("inbox supply skipped", error instanceof Error ? error.message : error); }
  if (!row) return { item: null, waiting: 0 };
  const lease = new Date(Date.now() + settings.lease_minutes * 60000).toISOString();
  await db.prepare("UPDATE inbox_candidates SET status='presented',presented_at=COALESCE(presented_at,?),lease_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(now(), lease, row.id).run();
  return { item: card(row), waiting: await waitingCount() };
}

export async function markOpened(id: string) {
  const r = await getD1().prepare("UPDATE inbox_candidates SET opened_at=COALESCE(opened_at,?),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(now(), id).run();
  return (r.meta?.changes ?? 0) === 1;
}

export async function decide(id: string, decision: "useful" | "skip", reason?: string | null) {
  const db = getD1();
  const row = await db.prepare("SELECT * FROM inbox_candidates WHERE id=?").bind(id).first<Row>();
  if (!row) throw new Error("INBOX_CANDIDATE_NOT_FOUND");
  if (row.decision) return { ok: true, already: String(row.decision), waiting: await waitingCount() };
  const useful = decision === "useful";
  const settings = await getSettings();
  const cleanReason = reason ? String(reason).slice(0, 200) : null;
  await db.batch([
    db.prepare("UPDATE inbox_candidates SET status=?,decision=?,decision_reason=?,decided_at=?,lease_until=NULL,progress_state=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND decision IS NULL")
      .bind(useful ? "useful" : "skipped", useful ? "useful" : "skip", cleanReason, now(), useful ? "awaiting_evidence" : null, id),
    db.prepare("INSERT INTO inbox_decisions (id,candidate_id,canonical_domain,finder_candidate_id,decision,reason) VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), id, row.canonical_domain, row.finder_candidate_id ?? row.canonical_domain, useful ? "useful" : "skip", cleanReason),
  ]);
  const investigationId = row.investigation_id ? String(row.investigation_id) : null;
  const entityId = row.entity_id ? String(row.entity_id) : null;
  const evidenceId = row.evidence_id ? String(row.evidence_id) : null;
  const actions: string[] = [];
  await timeline({ investigationId, entityId, sourceModule: "platform", eventType: useful ? "inbox.useful" : "inbox.skipped",
    title: useful ? `Marked ${row.canonical_domain} useful` : `Skipped ${row.canonical_domain}`, reason: cleanReason ?? "", data: { candidate_id: id } });
  if (useful) {
    if (settings.investigate_on_useful && investigationId && entityId && evidenceId) {
      try {
        await publishEvent("platform", { event_id: `inbox:${id}:useful`, event_type: "site.triaged", schema_version: "3.0", investigation_id: investigationId, entity_id: entityId,
          correlation_id: `inbox:${id}`, provenance: { method: "analyst_inbox_decision", candidate_id: id },
          payload: { outcome: "promoted", confidence: Math.max(0.9, Number(row.score) || 0), request_downstream: true, indicator_categories: ["analyst_confirmed", "site_finder_v2"],
            evidence_refs: [evidenceId], priority: "high", summary: `Analyst marked ${row.canonical_domain} useful` }, hop_count: 0 });
        actions.push("site investigation requested");
      } catch (error) { actions.push(`site investigation not requested: ${error instanceof Error ? error.message : "error"}`); }
    }
    if (settings.find_related_on_useful) {
      try {
        const q = await enqueueJob({ job_type: "FIND_RELATED_SITES", investigation_id: investigationId, target_entity_id: entityId, target_module: "site_finder", created_by_module: "platform",
          priority: 60, trigger_reason: "You marked this candidate useful; look for related sites.",
          payload: { canonical_key: row.canonical_domain, requested: 10, reason: "analyst_marked_useful", automation_policy: POLICY } });
        if (q.created) actions.push("related-site discovery queued");
      } catch (error) { actions.push(`related-site discovery not queued: ${error instanceof Error ? error.message : "error"}`); }
    }
  } else {
    if (investigationId && entityId && evidenceId) {
      try {
        await publishEvent("platform", { event_id: `inbox:${id}:skip`, event_type: "site.triaged", schema_version: "3.0", investigation_id: investigationId, entity_id: entityId,
          correlation_id: `inbox:${id}`, provenance: { method: "analyst_inbox_decision", candidate_id: id, reason: cleanReason },
          payload: { outcome: "dismissed", confidence: clamp(row.score), request_downstream: false, indicator_categories: ["analyst_skipped"], evidence_refs: [evidenceId] }, hop_count: 0 });
      } catch { /* the decision itself is already durable */ }
    }
    if (entityId) {
      const c = await db.prepare("UPDATE jobs SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE target_entity_id=? AND status IN ('pending','awaiting-approval') AND job_type IN ('INVESTIGATE_SITE','FIND_RELATED_SITES','RECHECK_SITE')").bind(entityId).run();
      if (c.meta?.changes) actions.push(`${c.meta.changes} pending job(s) cancelled`);
    }
    if (row.cluster_key) {
      const s = await db.prepare("UPDATE inbox_candidates SET status='suppressed',suppressed_reason=?,updated_at=CURRENT_TIMESTAMP WHERE cluster_key=? AND status='ready' AND id<>?")
        .bind(`Related to ${row.canonical_domain}, which you skipped.`, row.cluster_key, id).run();
      if (s.meta?.changes) actions.push(`${s.meta.changes} related candidate(s) hidden`);
    }
  }
  try { const { onInboxDecision } = await import("./agent/hooks"); await onInboxDecision(investigationId, String(row.canonical_domain), row.finder_candidate_id ? String(row.finder_candidate_id) : null, useful ? "useful" : "skip", cleanReason); } catch { /* AI layer is best-effort */ }
  try { await maintainSupply(); } catch (error) { console.warn("inbox supply skipped", error instanceof Error ? error.message : error); }
  return { ok: true, decision: useful ? "useful" : "skip", actions, waiting: await waitingCount() };
}

/** Keeps the inbox supplied: queues DISCOVER_SITES for Site Finder when fewer than target_depth are waiting. */
export async function maintainSupply(options: { searchId?: string } = {}) {
  const db=getD1(),owner=crypto.randomUUID(),at=now();
  const claim=await db.prepare("UPDATE inbox_supply_lock SET owner=?,until_at=? WHERE id=1 AND (until_at IS NULL OR until_at<?)").bind(owner,new Date(Date.now()+30000).toISOString(),at).run();
  if(claim.meta?.changes!==1)return {queued:false,reason:"Discovery supply is being reconciled",job_id:undefined};
  try {return await supplyLocked(owner,options.searchId);} finally {await db.prepare("UPDATE inbox_supply_lock SET owner=NULL,until_at=NULL WHERE id=1 AND owner=?").bind(owner).run();}
}
async function supplyLocked(owner:string,searchId?:string) {
  const db = getD1(); const settings = await getSettings();
  const waiting = await waitingCount();
  // A bounded search has already assessed the inbox and found no selectable candidate.
  // Claimed or unsupported rows may fill the ordinary inbox without satisfying that search.
  if (searchId) {
    const search = await db.prepare("SELECT id FROM autonomy_searches WHERE id=? AND state='Finding site' AND active_slot=1 AND generation<4 AND deadline_at>?").bind(searchId,now()).first();
    if (!search) return {queued:false,waiting,reason:"Search allowance is no longer active"};
  } else if (waiting >= settings.target_depth) return { queued: false, waiting, reason: "inbox full enough" };
  const finder = await db.prepare("SELECT module_name FROM module_registry WHERE module_name='site_finder'").first();
  if (!finder) return { queued: false, waiting, reason: "Site Finder has not registered" };
  const pending = await db.prepare("SELECT id FROM jobs WHERE job_type='DISCOVER_SITES' AND target_module='site_finder' AND status IN ('pending','running','retrying') LIMIT 1").first<{ id: string }>();
  if (pending) return { queued: false, waiting, reason: "discovery already queued", job_id: pending.id };
  const today = await db.prepare("SELECT COUNT(*) n FROM jobs WHERE job_type='DISCOVER_SITES' AND target_module='site_finder' AND created_at>=datetime('now','-1 day')").first<{ n: number }>();
  if (Number(today?.n ?? 0) >= settings.max_discovery_jobs_per_day) return { queued: false, waiting, reason: "daily discovery cap reached" };
  const id = crypto.randomUUID(), requested = Math.max(1,settings.target_depth - waiting);
  const payload = { requested, budget: { http: settings.discovery_http_budget }, reason: searchId ? "bounded_search_needs_supported_candidate" : "inbox_below_target", ...(searchId ? {search_id:searchId} : {}), automation_policy: POLICY };
  const committed=await db.batch([
    db.prepare(`INSERT INTO jobs (id,job_type,status,priority,target_module,created_by_module,dedupe_key,payload,trigger_reason)
      SELECT ?,'DISCOVER_SITES','pending',40,'site_finder','platform',?,?,? FROM inbox_supply_lock
      WHERE id=1 AND owner=? AND until_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND NOT EXISTS(SELECT 1 FROM jobs WHERE job_type='DISCOVER_SITES' AND target_module='site_finder' AND status IN ('pending','running','retrying'))
      AND (SELECT COUNT(*) FROM jobs WHERE job_type='DISCOVER_SITES' AND target_module='site_finder' AND created_at>=datetime('now','-1 day'))<?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM autonomy_searches WHERE id=? AND state='Finding site' AND active_slot=1 AND generation<4 AND deadline_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))`)
      .bind(id, `DISCOVER_SITES:supply:${id}`, json(payload), `Inbox has ${waiting} waiting; target is ${settings.target_depth}.`,owner,settings.max_discovery_jobs_per_day,searchId??null,searchId??null),
    db.prepare("INSERT INTO job_events (id,job_id,source_module,event_type,message) SELECT ?,?,'platform','created','Inbox supply' WHERE EXISTS(SELECT 1 FROM jobs WHERE id=?)").bind(crypto.randomUUID(), id,id),
    // Count a fresh search generation in the same transaction as its discovery job.
    // A worker may complete that job before Main recovers from a lost acknowledgement.
    db.prepare("UPDATE autonomy_searches SET job_id=?,generation=generation+1,reason='Bounded Finder discovery queued',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='Finding site' AND generation<4 AND EXISTS(SELECT 1 FROM jobs WHERE id=?)").bind(id,searchId??null,id),
  ]);
  if(committed[0].meta?.changes!==1)return {queued:false,waiting,reason:'Discovery ownership changed before commit',job_id:undefined};
  return { queued: true, waiting, requested, job_id: id };
}

/** Decisions for Site Finder's learning loop, oldest first, after a cursor. */
export async function decisionsSince(after: string, limit = 100) {
  const seq = Number.parseInt(after || "0", 10) || 0;
  const rows = await getD1().prepare("SELECT seq,id,candidate_id,canonical_domain,finder_candidate_id,decision,reason,created_at FROM inbox_decisions WHERE seq>? ORDER BY seq LIMIT ?").bind(seq, Math.max(1, Math.min(500, limit))).all<Row>();
  const decisions = rows.results.map(r => ({ id: String(r.id), candidate_id: String(r.finder_candidate_id ?? r.canonical_domain), domain: String(r.canonical_domain),
    decision: String(r.decision), reason: r.reason ?? null, decided_at: String(r.created_at) }));
  const last = rows.results.length ? String(rows.results[rows.results.length - 1].seq) : String(seq);
  return { decisions, next_cursor: last };
}

/** USEFUL candidates and how far the automatic workflow has taken them. */
export async function working(limit = 30) {
  const db = getD1();
  const rows = await db.prepare("SELECT * FROM inbox_candidates WHERE decision='useful' ORDER BY decided_at DESC LIMIT ?").bind(limit).all<Row>();
  const out = [];
  for (const row of rows.results) {
    let wallets = 0, analysed = 0, siteChecked = "";
    if (row.investigation_id) {
      wallets = Number((await db.prepare("SELECT COUNT(*) n FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND ie.source_module='crypto_wallet_logger' AND e.entity_type='wallet'").bind(row.investigation_id).first<{ n: number }>())?.n ?? 0);
      analysed = Number((await db.prepare("SELECT COUNT(*) n FROM jobs WHERE investigation_id=? AND job_type='ANALYZE_WALLET' AND status='completed'").bind(row.investigation_id).first<{ n: number }>())?.n ?? 0);
      siteChecked = String((await db.prepare("SELECT status FROM jobs WHERE investigation_id=? AND job_type='INVESTIGATE_SITE' ORDER BY created_at DESC LIMIT 1").bind(row.investigation_id).first<{ status: string }>())?.status ?? "");
    }
    const state = analysed ? "Wallets analysed" : wallets ? `${wallets} wallet${wallets > 1 ? "s" : ""} collected` : siteChecked === "completed" ? "Site checked · waiting for WalletLogger" : "Waiting for WalletLogger";
    out.push({ ...card(row), investigation_id: row.investigation_id, state, decided_at: row.decided_at });
  }
  return out;
}

export async function details(id: string) {
  const db = getD1();
  const row = await db.prepare("SELECT * FROM inbox_candidates WHERE id=?").bind(id).first<Row>();
  if (!row) return null;
  const inv = row.investigation_id ? String(row.investigation_id) : null;
  const [jobs, events, evidence] = inv ? await Promise.all([
    db.prepare("SELECT id,job_type,status,target_module,trigger_reason,created_at FROM jobs WHERE investigation_id=? ORDER BY created_at DESC LIMIT 20").bind(inv).all<Row>(),
    db.prepare("SELECT event_type,title,detail,reason,created_at FROM investigation_timeline WHERE investigation_id=? ORDER BY created_at DESC LIMIT 25").bind(inv).all<Row>(),
    db.prepare("SELECT id,evidence_type,evidence_class,title,source_module,created_at FROM evidence WHERE investigation_id=? ORDER BY created_at DESC LIMIT 20").bind(inv).all<Row>(),
  ]) : [{ results: [] }, { results: [] }, { results: [] }];
  return { ...row, details: parse<Row>(row.details, {}), related_domains: parse<string[]>(row.related_domains, []), wallets: parse<string[]>(row.wallets, []),
    jobs: jobs.results, timeline: events.results, evidence: evidence.results,
    note: "Scores, signals and shared infrastructure are software-derived observations that justify a manual look. They are not proof of fraud or of common ownership." };
}

export async function stats() {
  const db = getD1();
  const counts = await db.prepare("SELECT status,COUNT(*) n FROM inbox_candidates GROUP BY status").all<{ status: string; n: number }>();
  const recent = await db.prepare("SELECT decision,details FROM inbox_candidates WHERE decision IS NOT NULL ORDER BY decided_at DESC LIMIT 500").all<Row>();
  const decided = recent.results.length, useful = recent.results.filter(r => r.decision === "useful").length;
  const last50 = recent.results.slice(0, 50), useful50 = last50.filter(r => r.decision === "useful").length;
  const byStrategy: Record<string, { useful: number; skipped: number }> = {};
  for (const r of recent.results) for (const s of parse<string[]>(parse<Row>(r.details, {}).strategies, [])) {
    byStrategy[s] ??= { useful: 0, skipped: 0 }; byStrategy[s][r.decision === "useful" ? "useful" : "skipped"]++;
  }
  return { counts: Object.fromEntries(counts.results.map(c => [c.status, Number(c.n)])), decided, useful,
    precision: decided ? useful / decided : null, precision_last_50: last50.length ? useful50 / last50.length : null, by_strategy: byStrategy };
}
