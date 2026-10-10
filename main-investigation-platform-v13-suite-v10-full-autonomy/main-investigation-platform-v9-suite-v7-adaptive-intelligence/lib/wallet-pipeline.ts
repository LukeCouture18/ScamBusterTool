/**
 * v4 wallet pipeline: Logger observation -> one wallet candidate -> Wallet Investigator validation (and
 * bounded analysis for deposit wallets) -> an automatically built report whose exact contents, evidence
 * and destination are bound to the hash the analyst approves.
 *
 * Detection is not validation: a candidate only becomes a "confirmed wallet" when Wallet Investigator
 * says `valid` AND the browser evidence shows it presented as a place to send funds (deposit context).
 * A wallet seen on several sites is a correlation signal, never proof of common ownership.
 */
import { getD1, json, now, sha256 } from "./platform";
import { enqueueJob } from "./jobs";
import { ensureBudget } from "./planner";

export const CONTEXT_CLASSES = ["deposit", "withdrawal", "example", "transaction_history", "contract", "unrelated", "unknown"] as const;
export type ContextClass = (typeof CONTEXT_CLASSES)[number];
export const FAMILY_NETWORKS: Record<string, string[]> = {
  evm: ["ethereum", "bsc", "polygon", "arbitrum", "optimism", "base", "avalanche"],
  tron: ["tron"], bitcoin: ["bitcoin"], litecoin: ["litecoin"], dogecoin: ["dogecoin"], solana: ["solana"], xrp: ["xrp"],
};
const NETWORKS = new Set(Object.values(FAMILY_NETWORKS).flat());
const HINT_RANK: Record<string, number> = { "selected-option": 5, uri: 4, "qr-uri": 4, label: 3, "nearby-text": 1 };

/** Maps a label such as "USDT (TRC20)", "BEP20" or "Ethereum (ETH)" to a canonical network name. */
export function canonicalNetwork(label: unknown): string | null {
  const raw = String(label ?? "").toLowerCase().trim();
  if (!raw) return null;
  if (NETWORKS.has(raw)) return raw;
  const rules: Array<[RegExp, string]> = [
    [/trc-?20|\btron\b|\btrx\b/, "tron"], [/bep-?20|\bbsc\b|bnb smart chain|binance smart chain|\bbnb chain\b/, "bsc"],
    [/polygon|\bmatic\b/, "polygon"], [/arbitrum/, "arbitrum"], [/optimism|\bop mainnet\b/, "optimism"], [/\bbase\b/, "base"],
    [/avax|avalanche/, "avalanche"], [/erc-?20|ethereum|\beth\b/, "ethereum"], [/\bspl\b|solana|\bsol\b/, "solana"],
    [/bitcoin|\bbtc\b/, "bitcoin"], [/litecoin|\bltc\b/, "litecoin"], [/dogecoin|\bdoge\b/, "dogecoin"], [/\bxrp\b|ripple/, "xrp"],
  ];
  for (const [re, net] of rules) if (re.test(raw)) return net;
  return null;
}

export function familyOf(address: string, declared?: unknown): string {
  const d = String(declared ?? "").toLowerCase();
  if (FAMILY_NETWORKS[d]) return d;
  if (/^0x[0-9a-f]{40}$/i.test(address)) return "evm";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return "tron";
  if (/^(bc1|[13])/i.test(address)) return "bitcoin";
  if (/^(ltc1|[LM])/i.test(address)) return "litecoin";
  if (/^D[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) return "dogecoin";
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) return "xrp";
  return "solana";
}

/** Identity rule of the contract: EVM and bech32 lowercase, base58 case preserved. */
export function normalizeAddress(family: string, address: string) {
  const a = address.trim();
  if (family === "evm") return a.toLowerCase();
  if ((family === "bitcoin" && /^bc1/i.test(a)) || (family === "litecoin" && /^ltc1/i.test(a))) return a.toLowerCase();
  return a;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const parse = <T,>(v: unknown, fallback: T): T => { try { return v == null ? fallback : JSON.parse(String(v)) as T; } catch { return fallback; } };
const pathPattern = (url: string) => { try { const u = new URL(url); return "path:" + (u.pathname.toLowerCase().replace(/\/[0-9a-f-]{6,}(?=\/|$)/g, "/*").replace(/\/\d+(?=\/|$)/g, "/*").replace(/\/+$/, "") || "/"); } catch { return "path:?"; } };

export type ObservationInput = {
  observationId: string; address: string; family?: string; candidateNetworks?: string[];
  networkHint?: { network?: string; token?: string; source?: string } | null; formatCheck?: string;
  context: { class: string; confidence?: number; cues?: string[]; negativeCues?: string[]; section?: string; snippet?: string };
  detection?: { method?: string; methods?: string[]; afterInteraction?: boolean };
  page: { domain: string; url?: string; frameUrl?: string; title?: string };
  evidence?: Record<string, unknown>; firstSeen?: string; lastSeen?: string; seenCount?: number;
};

/** Content hash of one observation (what the browser showed and how it was understood). */
export async function observationHash(o: ObservationInput) {
  return sha256(json({ address: o.address, family: o.family, hint: o.networkHint ?? null, context: { class: o.context.class, cues: o.context.cues ?? [], negative: o.context.negativeCues ?? [], section: o.context.section ?? "", snippet: o.context.snippet ?? "" }, detection: o.detection ?? {}, page: o.page, evidence: o.evidence ?? {} }));
}

/**
 * Stores one observation under its wallet candidate and moves the candidate along the pipeline.
 * Repeating an observation (same id, same content) only refreshes when/how often it was seen.
 */
export async function recordObservation(investigationId: string, o: ObservationInput, evidenceId: string | null, sourceEventId: string, contentHash: string) {
  const { enroll } = await import("./director/resources");
  await enroll(investigationId);
  const db = getD1();
  const family = familyOf(o.address, o.family);
  const normalized = normalizeAddress(family, o.address);
  const identity = `${family}:${normalized}`;
  const cls: ContextClass = (CONTEXT_CLASSES as readonly string[]).includes(o.context.class) ? o.context.class as ContextClass : "unknown";
  const conf = Math.max(0, Math.min(1, Number(o.context.confidence ?? 0)));
  const hintNet = canonicalNetwork(o.networkHint?.network);
  const hint = hintNet ? { network: hintNet, token: o.networkHint?.token ?? null, source: o.networkHint?.source ?? "nearby-text" } : null;
  const candidates = (o.candidateNetworks ?? []).map(canonicalNetwork).filter((x): x is string => !!x && (FAMILY_NETWORKS[family] ?? []).includes(x));
  const seenAt = o.lastSeen ?? now();
  await db.prepare(`INSERT INTO wallet_candidates (id,investigation_id,identity,family,address,address_normalized,candidate_networks,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(investigation_id,identity) DO NOTHING`)
    .bind(crypto.randomUUID(), investigationId, identity, family, o.address.trim(), normalized, json(candidates.length ? candidates : FAMILY_NETWORKS[family] ?? []), o.firstSeen ?? seenAt, seenAt).run();
  const cand = (await db.prepare("SELECT * FROM wallet_candidates WHERE investigation_id=? AND identity=?").bind(investigationId, identity).first<Record<string, unknown>>())!;
  const existing = await db.prepare("SELECT content_sha256 FROM wallet_observations WHERE id=?").bind(o.observationId).first<{ content_sha256: string }>();
  if (existing && existing.content_sha256 === contentHash) {
    await db.prepare("UPDATE wallet_observations SET seen_count=MAX(seen_count,?),last_seen=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(Number(o.seenCount ?? 1), seenAt, o.observationId).run();
  } else {
    const values = [o.observationId, cand.id, investigationId, o.address.trim(), cls, conf, json(o.context.cues ?? []), json(o.context.negativeCues ?? []), String(o.context.section ?? "").slice(0, 300), String(o.context.snippet ?? "").slice(0, 600), String(o.detection?.method ?? "text"), json(o.detection?.methods ?? []), o.detection?.afterInteraction ? 1 : 0, hint ? json(hint) : null, o.formatCheck ?? null, o.page.domain, o.page.url ?? null, o.page.frameUrl ?? null, String(o.page.title ?? "").slice(0, 300), json(o.evidence ?? {}), o.firstSeen ?? seenAt, seenAt, Number(o.seenCount ?? 1), evidenceId, contentHash, sourceEventId];
    await db.prepare(`INSERT INTO wallet_observations (id,candidate_id,investigation_id,address,context_class,context_confidence,cues,negative_cues,section,snippet,method,methods,after_interaction,network_hint,format_check,domain,page_url,frame_url,page_title,details,first_seen,last_seen,seen_count,evidence_id,content_sha256,source_event_id)
      VALUES (${values.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET context_class=excluded.context_class,context_confidence=excluded.context_confidence,cues=excluded.cues,negative_cues=excluded.negative_cues,section=excluded.section,snippet=excluded.snippet,method=excluded.method,methods=excluded.methods,after_interaction=excluded.after_interaction,network_hint=excluded.network_hint,format_check=excluded.format_check,page_title=excluded.page_title,details=excluded.details,last_seen=excluded.last_seen,seen_count=MAX(wallet_observations.seen_count,excluded.seen_count),evidence_id=COALESCE(excluded.evidence_id,wallet_observations.evidence_id),content_sha256=excluded.content_sha256,source_event_id=excluded.source_event_id,updated_at=CURRENT_TIMESTAMP`).bind(...values).run();
    if (!existing) for (const pattern of [pathPattern(o.page.url ?? ""), `method:${o.detection?.method ?? "text"}`]) await bumpStat(pattern, "observations");
  }
  await refreshCandidate(String(cand.id));
  const refreshed=await db.prepare("SELECT network_hint FROM wallet_candidates WHERE id=?").bind(cand.id).first<{network_hint:string|null}>();
  const oldHint=parse<{network?:string;conflicting?:string[]} | null>(cand.network_hint,null),newHint=parse<{network?:string;conflicting?:string[]} | null>(refreshed?.network_hint,null);
  if (["valid","network_ambiguous"].includes(String(cand.validation_status)) && newHint?.network && (newHint.network!==oldHint?.network || json(newHint.conflicting??[])!==json(oldHint?.conflicting??[]))) {
    await db.prepare("UPDATE wallet_candidates SET validation_status='pending',analysis_status='none',validation_job_id=NULL,analysis_job_id=NULL WHERE id=?").bind(cand.id).run();
    await db.prepare("UPDATE director_retries SET status='resolved' WHERE candidate_id=?").bind(cand.id).run();
  }
  return advanceCandidate(String(cand.id));
}

async function bumpStat(pattern: string, field: "observations" | "confirmed") {
  const kind = pattern.split(":")[0];
  await getD1().prepare(`INSERT INTO wallet_discovery_stats (pattern,kind,${field}) VALUES (?,?,1) ON CONFLICT(pattern) DO UPDATE SET ${field}=${field}+1,updated_at=CURRENT_TIMESTAMP`).bind(pattern, kind).run();
}

/** Recomputes a candidate's best context and strongest network hint from all of its observations. */
async function refreshCandidate(candidateId: string) {
  const db = getD1();
  const rows = (await db.prepare("SELECT context_class,context_confidence,network_hint,last_seen,first_seen FROM wallet_observations WHERE candidate_id=?").bind(candidateId).all<{ context_class: string; context_confidence: number; network_hint: string | null; last_seen: string; first_seen: string }>()).results;
  // A credible deposit presentation wins; otherwise the most confident specific reading, then unknown.
  const deposits = rows.filter(r => r.context_class === "deposit");
  const strongestDeposit = deposits.reduce((m, r) => Math.max(m, Number(r.context_confidence)), 0);
  let best: { cls: string; conf: number } = { cls: "unknown", conf: 0 };
  if (deposits.length && strongestDeposit >= 0.5) best = { cls: "deposit", conf: strongestDeposit };
  else for (const r of rows) if (r.context_class !== "unknown" && Number(r.context_confidence) > best.conf) best = { cls: r.context_class, conf: Number(r.context_confidence) };
  // Hints from deposit observations first, then by how direct the hint is.
  const hints = rows.map(r => ({ hint: parse<{ network: string; token?: string; source?: string } | null>(r.network_hint, null), deposit: r.context_class === "deposit" })).filter(h => h.hint);
  hints.sort((a, b) => Number(b.deposit) - Number(a.deposit) || (HINT_RANK[b.hint!.source ?? ""] ?? 0) - (HINT_RANK[a.hint!.source ?? ""] ?? 0));
  const distinct = new Set(hints.filter(h => h.deposit || !hints.some(x => x.deposit)).map(h => h.hint!.network));
  const hint = hints[0]?.hint ? { ...hints[0].hint, conflicting: distinct.size > 1 ? [...distinct] : undefined } : null;
  await db.prepare("UPDATE wallet_candidates SET best_context=?,best_context_confidence=?,observations=?,deposit_observations=?,network_hint=?,first_seen_at=?,last_seen_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(best.cls, best.conf, rows.length, deposits.length, hint ? json(hint) : null, rows.map(r => r.first_seen).sort()[0] ?? null, rows.map(r => r.last_seen).sort().pop() ?? null, candidateId).run();
}

async function siteOf(investigationId: string) {
  return getD1().prepare("SELECT e.id,e.canonical_key FROM entities e JOIN investigation_entities ie ON ie.entity_id=e.id WHERE ie.investigation_id=? AND e.entity_type='site' ORDER BY e.created_at LIMIT 1").bind(investigationId).first<{ id: string; canonical_key: string }>();
}

/**
 * Next step for a candidate. Every candidate is validated by Wallet Investigator (validation is local to
 * it and spends no budget); deposit candidates first. Only a valid wallet shown in a deposit context gets
 * the bounded blockchain analysis (wallet budget). Nothing here talks to a blockchain or a website.
 */
export async function advanceCandidate(candidateId: string) {
  const db = getD1();
  const c = await db.prepare("SELECT * FROM wallet_candidates WHERE id=?").bind(candidateId).first<Record<string, unknown>>();
  if (!c) return null;
  const inv = String(c.investigation_id);
  const deposit = c.best_context === "deposit";
  const enqueue = async (analyze: boolean) => {
    await ensureBudget(inv);
    const site = await siteOf(inv);
    const hint = parse<Record<string, unknown> | null>(c.network_hint, null);
    try {
      const queued = await enqueueJob({
        job_type: "ANALYZE_WALLET", investigation_id: inv, target_entity_id: site?.id ?? null, target_module: "wallet_investigator", created_by_module: "platform",
        priority: analyze ? 80 : deposit ? 70 : c.best_context === "unknown" ? 40 : 15, stage_key: "wallet-analysis",
        trigger_reason: analyze ? `Wallet seen in a deposit context on ${site?.canonical_key ?? "the site"}: validate and analyse` : `Validate a wallet observed by the Logger (${c.best_context} context)`,
        dedupe_scope: `wallet-v4:${candidateId}:${analyze ? "analyze" : "validate"}:${(await sha256(json(hint))).slice(0,16)}`, budget_dimension: analyze ? "wallet" : undefined,
        payload: { pipeline: "wallet-v4", wallet_candidate_id: candidateId, address: c.address, family: c.family, candidate_networks: parse<string[]>(c.candidate_networks, []), network_hint: hint, analyze },
      });
      const id = String((queued.job as { id: string }).id);
      if (analyze) await db.prepare("UPDATE wallet_candidates SET analysis_status='queued',analysis_job_id=?,validation_status=CASE WHEN validation_status='pending' THEN 'queued' ELSE validation_status END,validation_job_id=COALESCE(validation_job_id,?),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id, id, candidateId).run();
      else await db.prepare("UPDATE wallet_candidates SET validation_status='queued',validation_job_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id, candidateId).run();
    } catch (error) {
      if (error instanceof Error && error.message === "BUDGET_EXHAUSTED") await db.prepare("UPDATE wallet_candidates SET analysis_status='budget_exhausted',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(candidateId).run();
      else throw error;
      if (error instanceof Error && error.message === "BUDGET_EXHAUSTED" && (!analyze || c.validation_status==='pending')) await db.prepare("UPDATE wallet_candidates SET validation_status='unable_to_validate',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(candidateId).run();
    }
  };
  if (c.validation_status === "pending") await enqueue(deposit);
  else if (c.validation_status === "valid" && deposit && ["none", "skipped"].includes(String(c.analysis_status))) await enqueue(true);
  // A validation that was queued for "validate only" and is still waiting gets upgraded when deposit evidence arrives.
  else if (c.validation_status === "queued" && deposit && c.analysis_status === "none") await enqueue(true);
  if (c.validation_status === "valid" || deposit) await rebuildWalletReport(inv);
  return c;
}

/** Wallet Investigator's ingest batch for a v4 job: record the validation and, if any, the analysis. */
export async function onWalletInvestigatorBatch(payload: { records?: Record<string, unknown[]>; origin_job_id?: string }) {
  const db = getD1();
  const touched = new Set<string>();
  for (const raw of (payload.records?.wallets ?? []) as Array<Record<string, unknown>>) {
    const data = (raw.data ?? {}) as Record<string, unknown>;
    const candidateId = String(data.wallet_candidate_id ?? (raw.provenance as Record<string, unknown> | undefined)?.wallet_candidate_id ?? "");
    const v = data.validation as Record<string, unknown> | undefined;
    if (!candidateId || !v) continue;
    const c = await db.prepare("SELECT * FROM wallet_candidates WHERE id=?").bind(candidateId).first<Record<string, unknown>>();
    if (!c) continue;
    if (payload.origin_job_id && payload.origin_job_id!==c.validation_job_id && payload.origin_job_id!==c.analysis_job_id) continue; // A late result from a superseded hint/job is not current validation.
    const status = ["valid", "invalid", "network_ambiguous", "unsupported", "unable_to_validate"].includes(String(v.status)) ? String(v.status) : "unable_to_validate";
    const obs = await db.prepare("SELECT entity_id FROM observations WHERE source_module='wallet_investigator' AND record_type='wallet' AND source_record_id=?").bind(String(raw.external_id ?? "")).first<{ entity_id: string }>();
    const analysis = String((data.analysis as Record<string, unknown> | undefined)?.status ?? "SKIPPED").toLowerCase();
    // The analysis status only changes for the candidate's analysis job; a validate-only job leaves it.
    await db.prepare("UPDATE wallet_candidates SET validation_status=?,validated_network=?,validation=?,entity_id=CASE WHEN ?='valid' THEN COALESCE(?,entity_id) ELSE entity_id END,analysis_status=CASE WHEN analysis_job_id=? THEN ? ELSE analysis_status END,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(status, status === "valid" ? String(v.network ?? "") || null : null, json(v), status, obs?.entity_id ?? null, payload.origin_job_id ?? "", analysis, candidateId).run();
    touched.add(candidateId);
    const { observeAnalysis } = await import("./director/director");
    await observeAnalysis(candidateId,payload.origin_job_id ?? "", (data.analysis ?? {}) as Record<string,unknown>);
    if(status==='valid' && analysis==='completed' && payload.origin_job_id===c.analysis_job_id && obs?.entity_id) {
      await db.prepare("INSERT INTO entity_analysis_state(entity_id,module_name,analysis_type,last_analyzed_at,fresh_until,result_summary) VALUES (?,'wallet_investigator','ANALYZE_WALLET',CURRENT_TIMESTAMP,datetime('now','+24 hours'),?) ON CONFLICT(entity_id,module_name,analysis_type) DO UPDATE SET last_analyzed_at=CURRENT_TIMESTAMP,fresh_until=excluded.fresh_until,result_summary=excluded.result_summary,updated_at=CURRENT_TIMESTAMP").bind(obs.entity_id,json({job_id:payload.origin_job_id,pipeline:'wallet-v4',authoritative:true})).run();
    }
    if (status === "valid") {
      await linkSiteToWallet(candidateId);
      if (c.best_context === "deposit" && c.validation_status !== "valid") {
        const pages = (await db.prepare("SELECT page_url,method FROM wallet_observations WHERE candidate_id=? AND context_class='deposit'").bind(candidateId).all<{ page_url: string; method: string }>()).results;
        for (const p of pages) { await bumpStat(pathPattern(p.page_url ?? ""), "confirmed"); await bumpStat(`method:${p.method}`, "confirmed"); }
      }
    }
  }
  const investigations = new Set<string>();
  for (const id of touched) { const c = await advanceCandidate(id); if (c) investigations.add(String(c.investigation_id)); }
  // Any result (valid, invalid, ambiguous) changes what the report says, so it is rebuilt.
  for (const inv of investigations) await rebuildWalletReport(inv);
  return touched.size;
}

/** site --displays_wallet--> wallet, backed by every deposit observation's evidence (the report's provenance). */
async function linkSiteToWallet(candidateId: string) {
  const db = getD1();
  const c = await db.prepare("SELECT * FROM wallet_candidates WHERE id=?").bind(candidateId).first<Record<string, unknown>>();
  if (!c?.entity_id || c.best_context !== "deposit") return;
  const site = await siteOf(String(c.investigation_id));
  if (!site) return;
  const recordId = `wallet-v4:${candidateId}`;
  const existing = await db.prepare("SELECT id FROM relationships WHERE source_module='platform' AND source_record_id=?").bind(recordId).first<{ id: string }>();
  const relId = existing?.id ?? crypto.randomUUID();
  if (!existing) await db.prepare("INSERT INTO relationships (id,investigation_id,source_entity_id,target_entity_id,relationship_type,assertion_kind,source_module,source_record_id,confidence,provenance,schema_version,observed_at) VALUES (?,?,?,?,'displays_wallet','observed','platform',?,?,?,'3.0',?)")
    .bind(relId, c.investigation_id, site.id, c.entity_id, recordId, Number(c.best_context_confidence ?? .7), json({ pipeline: "wallet-v4", wallet_candidate_id: candidateId, basis: "Logger saw this address presented as a deposit address; Wallet Investigator validated it" }), now()).run();
  const evidence = (await db.prepare("SELECT evidence_id FROM wallet_observations WHERE candidate_id=? AND context_class='deposit' AND evidence_id IS NOT NULL").bind(candidateId).all<{ evidence_id: string }>()).results;
  for (const e of evidence) await db.prepare("INSERT OR IGNORE INTO relationship_evidence (id,relationship_id,evidence_id,source_module) VALUES (?,?,?,'platform')").bind(crypto.randomUUID(), relId, e.evidence_id).run();
}

/** Marks validations whose job finally failed, so nothing waits forever. */
export async function reconcileWalletPipeline(investigationId?: string, opts: { startPending?: boolean } = {}) {
  const db = getD1();
  const rows = (await db.prepare(`SELECT c.id,c.validation_status,c.analysis_status,c.validation_job_id,c.analysis_job_id,vj.status vjs,aj.status ajs FROM wallet_candidates c LEFT JOIN jobs vj ON vj.id=c.validation_job_id LEFT JOIN jobs aj ON aj.id=c.analysis_job_id WHERE (c.validation_status='queued' OR c.analysis_status='queued')${investigationId ? " AND c.investigation_id=?" : ""} LIMIT 500`).bind(...(investigationId ? [investigationId] : [])).all<Record<string, string | null>>()).results;
  for (const r of rows) {
    if (r.validation_status === "queued" && ["failed", "dead", "cancelled"].includes(String(r.vjs))) await db.prepare("UPDATE wallet_candidates SET validation_status='unable_to_validate',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(r.id).run();
    if (r.analysis_status === "queued" && ["failed", "dead", "cancelled"].includes(String(r.ajs))) await db.prepare("UPDATE wallet_candidates SET analysis_status='failed',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(r.id).run();
    if (r.analysis_status === "queued" && r.ajs === "needs-review") await db.prepare("UPDATE wallet_candidates SET analysis_status='partial',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(r.id).run();
  }
  // Candidates that never got a job (e.g. created while budgets were missing) are picked up again.
  const pending = (await db.prepare(`SELECT id FROM wallet_candidates WHERE validation_status='pending'${investigationId ? " AND investigation_id=?" : ""} LIMIT 200`).bind(...(investigationId ? [investigationId] : [])).all<{ id: string }>()).results;
  if(opts.startPending!==false)for (const p of pending) await advanceCandidate(p.id);
}

// ------------------------------------------------------------------ report

export type Destination = { kind: string; form_id?: string; form_url?: string; version_hash?: string; title?: string };

export async function setModuleDestination(module: string, destination: Destination) {
  const db = getD1();
  const clean = { kind: String(destination.kind ?? "google_form"), form_id: String(destination.form_id ?? ""), form_url: String(destination.form_url ?? ""), version_hash: String(destination.version_hash ?? ""), title: String(destination.title ?? "") };
  const hash = await sha256(json(clean));
  const prev = await db.prepare("SELECT destination_sha256 FROM module_destinations WHERE module_name=?").bind(module).first<{ destination_sha256: string }>();
  if (prev?.destination_sha256 === hash) return { changed: false, destination_sha256: hash };
  await db.prepare("INSERT INTO module_destinations (module_name,destination,destination_sha256) VALUES (?,?,?) ON CONFLICT(module_name) DO UPDATE SET destination=excluded.destination,destination_sha256=excluded.destination_sha256,reported_at=CURRENT_TIMESTAMP").bind(module, json(clean), hash).run();
  // Every report not yet submitted is rebuilt: a new destination needs a new approval.
  const open = (await db.prepare("SELECT DISTINCT investigation_id FROM report_contents WHERE superseded_by IS NULL").all<{ investigation_id: string }>()).results;
  for (const r of open) await rebuildWalletReport(r.investigation_id);
  return { changed: true, destination_sha256: hash };
}

async function destination() {
  const row = await getD1().prepare("SELECT destination,destination_sha256 FROM module_destinations WHERE module_name='form_submitter'").first<{ destination: string; destination_sha256: string }>();
  return row ? { ...parse<Destination>(row.destination, { kind: "unknown" }), sha256: row.destination_sha256 } : null;
}

/** Builds the strongest report the validated evidence supports, deterministically. */
export async function buildWalletReportContent(investigationId: string) {
  const db = getD1();
  const site = await siteOf(investigationId);
  const cands = (await db.prepare("SELECT * FROM wallet_candidates WHERE investigation_id=? ORDER BY identity").bind(investigationId).all<Record<string, unknown>>()).results;
  const confirmed = cands.filter(c => c.validation_status === "valid" && c.best_context === "deposit");
  const warnings: string[] = [];
  const wallets: Array<Record<string, unknown>> = [];
  const evidence = new Map<string, { id: string; sha256: string | null; source_module: string; captured_at: string }>();
  for (const c of confirmed) {
    const obs = (await db.prepare("SELECT o.*,e.sha256 ev_sha,e.captured_at ev_at,e.source_module ev_module FROM wallet_observations o LEFT JOIN evidence e ON e.id=o.evidence_id WHERE o.candidate_id=? AND o.context_class='deposit' ORDER BY o.first_seen,o.id").bind(c.id).all<Record<string, unknown>>()).results;
    const depositEvidence = obs.filter(o => o.evidence_id && o.page_url && o.first_seen && o.method).map(o => ({ evidence_id: o.evidence_id, sha256: o.ev_sha ?? o.content_sha256, observation_id: o.id, page_url: o.page_url, frame_url: o.frame_url, observed_at: o.first_seen, method: o.method, section: o.section, cues: parse<string[]>(o.cues, []).slice(0, 6), snippet: String(o.snippet ?? "").slice(0, 300) }));
    for (const o of obs) if (o.evidence_id) evidence.set(String(o.evidence_id), { id: String(o.evidence_id), sha256: (o.ev_sha as string) ?? null, source_module: String(o.ev_module ?? "crypto_wallet_logger"), captured_at: String(o.ev_at ?? o.first_seen) });
    const chain = c.entity_id ? (await db.prepare("SELECT id,sha256,source_module,captured_at,title FROM evidence WHERE entity_id=? AND source_module='wallet_investigator' ORDER BY captured_at,id LIMIT 12").bind(c.entity_id).all<Record<string, unknown>>()).results : [];
    for (const e of chain) evidence.set(String(e.id), { id: String(e.id), sha256: (e.sha256 as string) ?? null, source_module: "wallet_investigator", captured_at: String(e.captured_at) });
    const elsewhere = (await db.prepare("SELECT DISTINCT o.domain FROM wallet_candidates w JOIN wallet_observations o ON o.candidate_id=w.id WHERE w.identity=? AND w.validated_network=? AND w.validation_status='valid' AND w.best_context='deposit' AND o.context_class='deposit' AND w.investigation_id<>? ORDER BY o.domain LIMIT 20").bind(c.identity, c.validated_network, investigationId).all<{ domain: string }>()).results.map(r => r.domain);
    const v = parse<Record<string, unknown>>(c.validation, {});
    const hint = parse<Record<string, unknown> | null>(c.network_hint, null);
    if (!depositEvidence.length) warnings.push(`${c.address}: no deposit observation with full provenance`);
    if (["partial", "failed", "budget_exhausted"].includes(String(c.analysis_status))) warnings.push(`${c.address}: blockchain analysis ${c.analysis_status === "partial" ? "is incomplete (provider coverage)" : c.analysis_status === "failed" ? "failed" : "skipped: wallet budget used up"}`);
    // Form Submitter stops for a person on what the reporting form cannot express unambiguously; say so before approval.
    const formTokenNet = c.validated_network === "ethereum" || c.validated_network === "tron" || (c.validated_network === "bsc" && String(hint?.token ?? "").toUpperCase() === "USDT");
    if (!formTokenNet && !["bitcoin", "solana", "xrp", "litecoin", "dogecoin", "ethereum", "tron"].includes(String(c.validated_network))) warnings.push(`${c.address}: the reporting form has no option for ${c.validated_network}${c.validated_network === "bsc" ? " without a USDT token" : ""}; Form Submitter will stop for you to file this wallet`);
    else if (["bitcoin", "litecoin"].includes(String(c.validated_network)) && String(c.address).startsWith("3")) warnings.push(`${c.address}: addresses starting with 3 are shared by Bitcoin and Litecoin; Form Submitter will ask you to confirm it`);
    // The report is not offered for approval while its blockchain evidence can still change (it would withdraw the approval).
    if (["queued", "running", "none", "skipped"].includes(String(c.analysis_status))) warnings.push(`${c.address}: blockchain analysis still running`);
    if (hint && Array.isArray(hint.conflicting)) warnings.push(`${c.address}: the site showed it under more than one network (${(hint.conflicting as string[]).join(", ")})`);
    wallets.push({ identity: c.identity, address: c.address, network: c.validated_network, token: hint?.token ?? null, validation_status: c.validation_status, checksum: v.checksum ?? null, deposit_evidence: depositEvidence, observations: Number(c.observations), analysis_status: c.analysis_status, blockchain_evidence: chain.map(e => ({ evidence_id: e.id, sha256: e.sha256, title: e.title })), also_seen_on: elsewhere });
  }
  for (const c of cands) {
    if (c.best_context === "deposit" && c.validation_status === "network_ambiguous") warnings.push(`${c.address}: shown as a deposit address but its network could not be determined, so it is not in the report`);
    if (c.best_context === "deposit" && ["invalid", "unsupported"].includes(String(c.validation_status))) warnings.push(`${c.address}: shown as a deposit address but Wallet Investigator found it ${c.validation_status === "invalid" ? "invalid" : "unsupported"}`);
    if (c.best_context === "deposit" && ["pending", "queued"].includes(String(c.validation_status))) warnings.push(`${c.address}: validation still running`);
  }
  const dest = await destination();
  if (!dest) warnings.push("No submission destination is configured in Form Submitter yet");
  if (!site) warnings.push("The investigation has no site record");
  const evidenceList = [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (evidenceList.length < 2) warnings.push("At least two evidence items are needed before a report can be submitted");
  const retry = await db.prepare("SELECT candidate_id FROM director_retries WHERE investigation_id=? AND status IN ('parked','running') LIMIT 1").bind(investigationId).first();
  if (retry) warnings.push("Provider recovery still running");
  const ready = Boolean(site && dest && wallets.length && wallets.every(w => (w.deposit_evidence as unknown[]).length) && evidenceList.length >= 2 && !warnings.some(w => w.endsWith("still running")));
  const content = {
    kind: "wallet-report-v4", investigation_id: investigationId,
    site: site ? { entity_id: site.id, domain: site.canonical_key, url: `https://${site.canonical_key}` } : null,
    wallets, evidence: evidenceList, entities: [site?.id, ...confirmed.map(c => c.entity_id)].filter(Boolean).sort(),
    destination: dest, warnings: [...warnings].sort(),
    note: "A wallet shown on several sites links those sites; it does not by itself show the same people run them.",
  };
  return { content, ready, warnings, confirmed: confirmed.length, destination_sha256: dest?.sha256 ?? null };
}

/**
 * Keeps one current draft per investigation. A different content hash supersedes an unapproved draft,
 * and revokes an approved one that has not been handed to Form Submitter (approval must be repeated).
 * A report already submitted is followed by a new draft only when there are new confirmed wallets.
 */
export async function rebuildWalletReport(investigationId: string) {
  const db = getD1();
  const built = await buildWalletReportContent(investigationId);
  const snapshot = json(built.content);
  const hash = await sha256(snapshot);
  const latest = await db.prepare("SELECT rc.id,rc.status,rc.evidence_sha256,rc.approval_id,rc.submission_job_id,j.status job_status,g.status gate_status,c.summary FROM report_contents c JOIN report_candidates rc ON rc.id=c.candidate_id LEFT JOIN approval_gates g ON g.id=rc.approval_id LEFT JOIN jobs j ON j.id=rc.submission_job_id WHERE c.investigation_id=? AND c.superseded_by IS NULL ORDER BY c.created_at DESC LIMIT 1").bind(investigationId).first<Record<string, string | null>>();
  // A previously reportable wallet can lose authoritative validation. Preserve
  // history, but supersede its current draft with the now-incomplete contents.
  if (!built.confirmed && !latest) return { state: "watching" as const };
  if (latest && latest.evidence_sha256 === hash) return { state: "unchanged" as const, candidate_id: latest.id, content_sha256: hash };
  if (latest) {
    const approved = latest.gate_status === "approved";
    const notYetClaimed = !latest.submission_job_id || ["pending", "retrying", "cancelled"].includes(String(latest.job_status ?? ""));
    if (approved && notYetClaimed && latest.status === "ready") {
      // Approved but Form Submitter has not started: the approval no longer matches, withdraw it.
      await db.batch([
        db.prepare("UPDATE report_candidates SET status='stale',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(latest.id),
        db.prepare("UPDATE approval_gates SET status='rejected',decision_reason=COALESCE(decision_reason,'')||' | approval withdrawn: report contents or destination changed before submission' WHERE id=?").bind(latest.approval_id),
        db.prepare("UPDATE jobs SET status='cancelled',dedupe_key=dedupe_key || ':cancelled:' || id,progress_message='Approval withdrawn: the report changed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','retrying')").bind(latest.submission_job_id ?? ""),
        db.prepare("INSERT INTO job_events (id,job_id,source_module,event_type,message) SELECT ?,id,'platform','cancelled','Approval withdrawn: report contents or destination changed before submission' FROM jobs WHERE id=?").bind(crypto.randomUUID(), latest.submission_job_id ?? ""),
      ]);
    } else if (approved) {
      // Already handed to Form Submitter (or finished): never resubmit the same wallets; follow up only with new ones.
      const before = new Set(parse<{ wallets?: Array<{ identity: string }> }>(latest.summary, {}).wallets?.map(w => w.identity) ?? []);
      if ((built.content.wallets as Array<{ identity: string }>).every(w => before.has(w.identity))) return { state: "submitted" as const, candidate_id: latest.id };
    } else if (latest.gate_status === "pending") {
      await db.prepare("UPDATE report_candidates SET status='superseded',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(latest.id).run();
      await db.prepare("UPDATE approval_gates SET status='rejected',decision_reason='superseded by an updated report' WHERE id=? AND status='pending'").bind(latest.approval_id).run();
    }
  }
  await db.prepare('INSERT OR IGNORE INTO autonomy_report_claims(investigation_id,content_hash,candidate_id,approval_id) VALUES (?,?,?,?)').bind(investigationId,hash,crypto.randomUUID(),crypto.randomUUID()).run();
  const claim=(await db.prepare('SELECT candidate_id,approval_id FROM autonomy_report_claims WHERE investigation_id=? AND content_hash=?').bind(investigationId,hash).first<{candidate_id:string;approval_id:string}>())!;
  const id=claim.candidate_id,gate=claim.approval_id;
  const summary = { site: built.content.site, wallets: built.content.wallets /* the frozen wallet entries themselves: what the person reviews is what is approved */, destination: built.content.destination, warnings: built.warnings };
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO approval_gates (id,investigation_id,action,scope,requested_reason) VALUES (?,?,'PREPARE_REPORT',?,?)").bind(gate, investigationId, json({ candidate_id: id, evidence_sha256: hash, destination_sha256: built.destination_sha256 }), "Approve this exact report (wallets, evidence and destination) for submission."),
    db.prepare("INSERT OR IGNORE INTO report_candidates (id,investigation_id,evidence_snapshot,evidence_sha256,approval_id) VALUES (?,?,?,?,?)").bind(id, investigationId, snapshot, hash, gate),
    ...(latest?[db.prepare("UPDATE report_contents SET superseded_by=?,stale_reason=?,updated_at=CURRENT_TIMESTAMP WHERE candidate_id=? AND candidate_id<>?").bind(id,"contents or destination changed",latest.id,id)]:[]),
    db.prepare("INSERT OR IGNORE INTO report_contents (candidate_id,investigation_id,summary,warnings,ready,destination_sha256) VALUES (?,?,?,?,?,?)").bind(id, investigationId, json(summary), json(built.warnings), built.ready ? 1 : 0, built.destination_sha256),
  ]);

  return { state: "drafted" as const, candidate_id: id, content_sha256: hash };
}

/**
 * Server-side approval check for a v4 report: the analyst must approve the exact hash they reviewed, it
 * must still be current (rebuilt now), complete, and point at the destination Form Submitter reports.
 */
export async function checkWalletReportApproval(investigationId: string, candidateId: string, contentSha256: string | undefined) {
  const db = getD1();
  const row = await db.prepare("SELECT c.ready,c.destination_sha256 FROM report_contents c WHERE c.candidate_id=?").bind(candidateId).first<{ ready: number; destination_sha256: string | null }>();
  if (!row) return { v4: false as const };
  await rebuildWalletReport(investigationId);
  const current = await db.prepare("SELECT rc.status,rc.evidence_sha256,c.ready,c.superseded_by FROM report_candidates rc JOIN report_contents c ON c.candidate_id=rc.id WHERE rc.id=?").bind(candidateId).first<{ status: string; evidence_sha256: string; ready: number; superseded_by: string | null }>();
  if (!current || current.superseded_by || current.status !== "needs_review") return { v4: true as const, ok: false, code: "REPORT_CHANGED", message: "The report changed after you opened it. Review the updated report and approve it again." };
  if (!contentSha256 || contentSha256 !== current.evidence_sha256) return { v4: true as const, ok: false, code: "REPORT_CHANGED", message: "The approval does not match the current report contents. Review the report again." };
  if (!current.ready) return { v4: true as const, ok: false, code: "REPORT_INCOMPLETE", message: "Required report fields or provenance are missing; see the warnings." };
  const dest = await destination();
  if (!dest || dest.sha256 !== row.destination_sha256) return { v4: true as const, ok: false, code: "REPORT_CHANGED", message: "The submission destination changed. Review the report again." };
  return { v4: true as const, ok: true };
}

// ------------------------------------------------------------------ read model for the UI

export async function walletPipelineView(investigationId: string) {
  const db = getD1();
  await reconcileWalletPipeline(investigationId);
  const site = await siteOf(investigationId);
  const cands = (await db.prepare("SELECT * FROM wallet_candidates WHERE investigation_id=? ORDER BY CASE best_context WHEN 'deposit' THEN 0 ELSE 1 END,last_seen_at DESC").bind(investigationId).all<Record<string, unknown>>()).results;
  const totalObs = sum(cands.map(c => Number(c.observations)));
  const report = await db.prepare("SELECT rc.id,rc.status,rc.evidence_sha256,rc.verification_status,rc.submission_job_id,c.summary,c.warnings,c.ready,j.status job_status,(SELECT message FROM job_events WHERE job_id=rc.submission_job_id ORDER BY created_at DESC LIMIT 1) job_message FROM report_contents c JOIN report_candidates rc ON rc.id=c.candidate_id LEFT JOIN jobs j ON j.id=rc.submission_job_id WHERE c.investigation_id=? AND c.superseded_by IS NULL ORDER BY c.created_at DESC LIMIT 1").bind(investigationId).first<Record<string, unknown>>();
  const inReport = new Set(parse<{ wallets?: Array<{ identity: string }> }>(report?.summary, {}).wallets?.map(w => w.identity) ?? []);
  const obsRows = (await db.prepare("SELECT candidate_id,id,context_class,context_confidence,cues,negative_cues,section,snippet,method,methods,page_url,page_title,first_seen,last_seen,seen_count,after_interaction FROM wallet_observations WHERE investigation_id=? ORDER BY first_seen").bind(investigationId).all<Record<string, unknown>>()).results;
  const wallets = cands.map(c => {
    const obs = obsRows.filter(o => o.candidate_id === c.id);
    const best = obs.filter(o => o.context_class === c.best_context).sort((a, b) => Number(b.context_confidence) - Number(a.context_confidence))[0];
    const v = parse<Record<string, unknown>>(c.validation, {});
    return {
      id: c.id, address: c.address, family: c.family, network: c.validated_network ?? parse<{ network?: string } | null>(c.network_hint, null)?.network ?? null,
      context: c.best_context, context_confidence: c.best_context_confidence,
      why: best ? { cues: parse<string[]>(best.cues, []).slice(0, 6), negative: parse<string[]>(best.negative_cues, []).slice(0, 4), section: best.section, snippet: best.snippet } : null,
      where: obs.map(o => ({ page_url: o.page_url, page_title: o.page_title, method: o.method, context: o.context_class, first_seen: o.first_seen, seen: o.seen_count, after_interaction: Boolean(o.after_interaction) })),
      validation: { status: c.validation_status, network: c.validated_network, checksum: v.checksum ?? null, reasons: (v.reasons as string[] | undefined) ?? [] },
      analysis: c.analysis_status, in_report: inReport.has(String(c.identity)), entity_id: c.entity_id,
    };
  });
  const validated = cands.filter(c => c.validation_status === "valid").length;
  const rejected = cands.filter(c => ["invalid", "unsupported"].includes(String(c.validation_status))).length;
  const confirmedDeposit = cands.filter(c => c.validation_status === "valid" && c.best_context === "deposit").length;
  const reportState = !report ? (confirmedDeposit ? "building" : "waiting") : String(report.status) === "needs_review" ? (report.ready ? "ready_to_report" : "building")
    : ["ready"].includes(String(report.status)) ? "approved" : String(report.status) === "completed" ? "submitted" : String(report.status);
  const logger = await db.prepare("SELECT last_heartbeat_at,last_successful_sync_at FROM module_registry WHERE module_name='crypto_wallet_logger'").first<{ last_heartbeat_at: string | null; last_successful_sync_at: string | null }>();
  return {
    investigation_id: investigationId, site: site?.canonical_key ?? null,
    watching: { logger_last_seen: logger?.last_successful_sync_at ?? logger?.last_heartbeat_at ?? null },
    counts: { observations: totalObs, wallets: cands.length, validated, rejected, ambiguous: cands.filter(c => c.validation_status === "network_ambiguous").length, pending: cands.filter(c => ["pending", "queued"].includes(String(c.validation_status))).length, confirmed_deposit: confirmedDeposit },
    wallets,
    likely_pages: await likelyWalletPages(investigationId, site?.canonical_key ?? null),
    report: report ? { candidate_id: report.id, status: report.status, state: reportState, ready: Boolean(report.ready), content_sha256: report.evidence_sha256, summary: parse(report.summary, {}), warnings: parse<string[]>(report.warnings, []), verification: report.verification_status, submission: report.submission_job_id ? { job_status: report.job_status, message: report.job_message } : null } : { state: reportState },
  };
}

/**
 * Pages the permitted public analysis (Site Finder investigation, Logger deposit interfaces) suggests carry
 * a deposit wallet but where no wallet was observed yet, ranked by how often similar pages have produced
 * confirmed deposit wallets. Opening one is the analyst's normal browsing; the Logger then observes it.
 */
export async function likelyWalletPages(investigationId: string, domain: string | null) {
  const db = getD1();
  const seen = new Set((await db.prepare("SELECT DISTINCT page_url FROM wallet_observations WHERE investigation_id=?").bind(investigationId).all<{ page_url: string }>()).results.map(r => r.page_url));
  const pages = (await db.prepare(`SELECT DISTINCT COALESCE(json_extract(o.data,'$.url'),json_extract(o.data,'$.source_url'),e.canonical_key) url, e.entity_type kind
     FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id LEFT JOIN observations o ON o.entity_id=e.id
     WHERE ie.investigation_id=? AND e.entity_type IN ('deposit_page','page','deposit_option') LIMIT 200`).bind(investigationId).all<{ url: string | null; kind: string }>()).results;
  const stats = new Map((await db.prepare("SELECT pattern,observations,confirmed FROM wallet_discovery_stats WHERE kind='path'").all<{ pattern: string; observations: number; confirmed: number }>()).results.map(s => [s.pattern, s]));
  const out = new Map<string, { url: string; score: number; why: string }>();
  for (const p of pages) {
    let url = String(p.url ?? "");
    if (!url) continue;
    if (!/^https?:\/\//.test(url)) url = `https://${url.replace(/^\/+/, "")}`;
    try { const u = new URL(url); if (domain && !u.hostname.endsWith(domain)) continue; } catch { continue; }
    if (seen.has(url)) continue;
    const s = stats.get(pathPattern(url));
    const learned = s && s.observations ? s.confirmed / s.observations : 0;
    const prior = /deposit|recharge|top-?up|fund|pay|wallet|assets/i.test(url) ? .4 : p.kind === "deposit_page" ? .5 : .1;
    const score = Math.min(1, (p.kind === "deposit_page" ? .3 : 0) + prior + learned * .6);
    out.set(url, { url, score: Math.round(score * 100) / 100, why: p.kind === "deposit_page" ? "Public analysis found a deposit page here" : learned > 0 ? "Similar pages have shown deposit wallets before" : "Looks like a payment page" });
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 5);
}
