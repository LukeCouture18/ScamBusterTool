/**
 * The capability registry: the only things the AI investigator can do.
 *
 * Each capability has a strict argument schema, a deterministic precondition
 * check, a fingerprint for duplicate/loop prevention and an executor. Module
 * work goes through the platform's existing typed job path (enqueueJob:
 * dedupe, investigation budgets, module capability routing, audit links), so a
 * plan becomes exactly the same kind of job the v2 planner creates. Read-only
 * capabilities return deterministic analysis over stored data.
 *
 * There is deliberately no capability that writes evidence, sends anything to
 * a scam site, handles credentials, solves CAPTCHAs, moves funds or runs code.
 */
import { z } from "zod";
import { getD1, json, type SourceModule } from "../platform";
import { enqueueJob } from "../jobs";
import { ensurePipeline } from "../orchestrator";
import { ensureBudget } from "../planner";
import { selectModuleForCapability } from "../events";
import { createReportCandidate } from "../reporting";
import { CHECKPOINT_TEXT, type BarrierKind } from "./barriers";
import { knowledgeClass } from "./knowledge";
import { searchMemory } from "./memory";
import type { Digest } from "./state";

type Row = Record<string, unknown>;
export const AUTOMATION_POLICY = { credentials: "none", prohibited: ["credential-guessing", "brute-force", "credential-stuffing", "captcha-bypass", "mfa-bypass", "email-verification-bypass", "exploitation", "financial-transactions"], financial_actions_allowed: false, origin: "ai_investigator_v3" };

export type RunStatus = "RUNNING" | "WAITING_FOR_MODULE" | "WAITING_FOR_HUMAN" | "PAUSED" | "COMPLETE" | "INSUFFICIENT_EVIDENCE" | "BUDGET_EXHAUSTED" | "STOPPED" | "FAILED";
export type RunRow = Record<string, unknown> & { id: string; investigation_id: string; status: RunStatus };
export type Ctx = { run: RunRow; stepId: string; stepNo: number; digest: Digest; rationale: string; triggeringEvidence: string[] };
export type ExecResult = {
  outcome: "queued" | "duplicate" | "completed" | "no_change" | "waiting" | "concluded" | "blocked" | "deferred";
  headline: string; jobId?: string; checkpointId?: string; result?: unknown; status?: RunStatus;
  moduleCall?: boolean; discovery?: boolean; informative?: boolean; releaseFingerprint?: boolean;
};
export type Capability = {
  name: string; summary: string; kind: "module" | "read" | "human" | "terminal";
  profileCapability?: string; args: z.ZodTypeAny;
  check(args: Row, ctx: Omit<Ctx, "stepId" | "stepNo" | "rationale">): string[];
  fingerprint(args: Row, ctx: Omit<Ctx, "stepId" | "stepNo" | "rationale">): string;
  execute(args: Row, ctx: Ctx): Promise<ExecResult>;
};

const uuid = z.string().uuid();
const entityOf = (d: Digest, id: unknown) => d.entities.find(e => e.id === id);
const evidenceIds = (d: Digest) => new Set(d.evidence.all_ids);

async function queueModuleJob(ctx: Ctx, input: { jobType: string; capability: string; entityId: string; stage: string; budget: "wallet" | "job" | "related_site"; payload?: Row; waitFor: boolean; headline: string }): Promise<ExecResult> {
  const db = getD1(); const inv = ctx.run.investigation_id;
  const existing = await db.prepare("SELECT id,status FROM jobs WHERE json_extract(payload,'$.agent_step_id')=? LIMIT 1").bind(ctx.stepId).first<{ id: string; status: string }>();
  if (existing) return { outcome: "queued", jobId: existing.id, headline: input.headline, moduleCall: true, status: input.waitFor ? "WAITING_FOR_MODULE" : undefined };
  const fresh = await db.prepare("SELECT fresh_until FROM entity_analysis_state WHERE entity_id=? AND analysis_type=? AND fresh_until>CURRENT_TIMESTAMP LIMIT 1").bind(input.entityId, input.jobType).first();
  if (fresh) return { outcome: "no_change", headline: `${input.jobType.replace(/_/g, " ").toLowerCase()} is still fresh; nothing re-run`, informative: false };
  const targetModule = await selectModuleForCapability(input.capability, "platform");
  if (!targetModule) return { outcome: "deferred", headline: `No connected module can ${input.capability} right now; will retry`, releaseFingerprint: true, status: "WAITING_FOR_MODULE" };
  await ensureBudget(inv);
  const pipeline = await ensurePipeline(inv);
  try {
    const q = await enqueueJob({ job_type: input.jobType, investigation_id: inv, target_entity_id: input.entityId, target_module: targetModule as SourceModule, created_by_module: "platform", priority: 70,
      pipeline_id: String(pipeline.id), stage_key: input.stage, budget_dimension: input.budget, correlation_id: `agent:${ctx.run.id}`,
      trigger_reason: `AI investigator step ${ctx.stepNo}: ${ctx.rationale.slice(0, 160) || input.headline}`,
      payload: { ...(input.payload ?? {}), agent_run_id: ctx.run.id, agent_step_id: ctx.stepId, evidence_refs: ctx.triggeringEvidence, automation_policy: AUTOMATION_POLICY } });
    const jobId = String((q.job as Row).id);
    return { outcome: q.created ? "queued" : "duplicate", jobId, moduleCall: q.created, headline: q.created ? input.headline : `${input.headline} (already in progress)`, status: input.waitFor ? "WAITING_FOR_MODULE" : undefined };
  } catch (error) {
    if (error instanceof Error && error.message === "BUDGET_EXHAUSTED") return { outcome: "blocked", headline: "The investigation's job budget is used up", status: "BUDGET_EXHAUSTED" };
    throw error;
  }
}

export const CAPABILITIES: Capability[] = [
  {
    name: "site.investigate", kind: "module", profileCapability: "site:investigate",
    summary: "Ask Site Investigator to examine the public website (pages, wallets shown publicly, TLS/DNS). Public pages only; no login.",
    args: z.object({ entity_id: uuid }).strict(),
    check(a, { digest }) { const e = entityOf(digest, a.entity_id); return !e ? ["entity is not part of this investigation"] : e.type !== "site" ? ["entity is not a site"] : []; },
    fingerprint: a => `site.investigate:${a.entity_id}`,
    execute: (a, ctx) => queueModuleJob(ctx, { jobType: "INVESTIGATE_SITE", capability: "site:investigate", entityId: String(a.entity_id), stage: "site-analysis", budget: "job", waitFor: true, headline: `Asked Site Investigator to check ${entityOf(ctx.digest, a.entity_id)?.key ?? "the site"}` }),
  },
  {
    name: "wallet.analyze", kind: "module", profileCapability: "wallet:analyze",
    summary: "Ask Wallet Investigator to analyse a wallet that a module observed on the site (read-only blockchain analysis).",
    args: z.object({ entity_id: uuid }).strict(),
    check(a, { digest }) { const w = digest.wallets.find(x => x.entity_id === a.entity_id); return !w ? ["wallet was not observed by a module in this investigation"] : w.analyzed ? ["wallet already analysed"] : []; },
    fingerprint: a => `wallet.analyze:${a.entity_id}`,
    execute: (a, ctx) => queueModuleJob(ctx, { jobType: "ANALYZE_WALLET", capability: "wallet:analyze", entityId: String(a.entity_id), stage: "wallet-analysis", budget: "wallet", waitFor: true, headline: `Asked Wallet Investigator to analyse ${String(ctx.digest.wallets.find(w => w.entity_id === a.entity_id)?.key ?? "a wallet").slice(0, 24)}…` }),
  },
  {
    name: "discovery.find_related", kind: "module", profileCapability: "site:relate",
    summary: "Ask Site Finder to look passively (CT logs, DNS, public pages) for sites related to this one. Adds candidates to your inbox; does not wait.",
    args: z.object({ entity_id: uuid, max_candidates: z.number().int().min(1).max(10).default(5) }).strict(),
    check(a, { digest }) { const e = entityOf(digest, a.entity_id); return !e || e.type !== "site" ? ["entity is not a site in this investigation"] : []; },
    fingerprint: a => `discovery.find_related:${a.entity_id}`,
    async execute(a, ctx) {
      const r = await queueModuleJob(ctx, { jobType: "FIND_RELATED_SITES", capability: "site:relate", entityId: String(a.entity_id), stage: "discovery", budget: "related_site", waitFor: false,
        payload: { canonical_key: entityOf(ctx.digest, a.entity_id)?.key, requested: a.max_candidates ?? 5, reason: "ai_investigator_related_sites" }, headline: "Asked Site Finder for related sites" });
      return { ...r, discovery: r.outcome === "queued", status: r.status === "WAITING_FOR_MODULE" && r.outcome !== "deferred" ? undefined : r.status };
    },
  },
  {
    name: "discovery.request", kind: "module", profileCapability: "site:relate",
    summary: "Ask Site Finder for more passive discovery (new candidates for your inbox). Does not wait.",
    args: z.object({ requested: z.number().int().min(1).max(10).default(5), reason: z.string().min(3).max(200) }).strict(),
    check: () => [],
    fingerprint: () => "discovery.request",
    async execute(a, ctx) {
      const pending = await getD1().prepare("SELECT id FROM jobs WHERE job_type='DISCOVER_SITES' AND status IN ('pending','running','retrying') LIMIT 1").first<{ id: string }>();
      if (pending) return { outcome: "duplicate", jobId: pending.id, headline: "Discovery already queued" };
      const q = await enqueueJob({ job_type: "DISCOVER_SITES", investigation_id: null, target_entity_id: null, target_module: "site_finder", created_by_module: "platform", priority: 40,
        correlation_id: `agent:${ctx.run.id}`, trigger_reason: `AI investigator: ${String(a.reason)}`,
        payload: { requested: a.requested ?? 5, reason: "ai_investigator", agent_run_id: ctx.run.id, agent_step_id: ctx.stepId, automation_policy: AUTOMATION_POLICY } });
      return { outcome: q.created ? "queued" : "duplicate", jobId: String((q.job as Row).id), discovery: q.created, moduleCall: q.created, headline: "Asked Site Finder for more candidates" };
    },
  },
  {
    name: "infrastructure.analyze", kind: "read",
    summary: "Deterministic analysis of the site's infrastructure (IP, nameservers, TLS/CT, favicon, chat service, wallets) and which other known sites share it.",
    args: z.object({ entity_id: uuid }).strict(),
    check(a, { digest }) { const e = entityOf(digest, a.entity_id); return !e || e.type !== "site" ? ["entity is not a site in this investigation"] : []; },
    fingerprint: (a, { digest }) => `infrastructure.analyze:${a.entity_id}:${digest.evidence.total}`,
    async execute(a, ctx) {
      const out = await analyzeInfrastructure(ctx.digest, String(a.entity_id));
      return { outcome: "completed", result: out, informative: out.shared.length > 0 || out.metadata.length > 0, headline: out.shared.length ? `Infrastructure shared with ${out.shared.length} known site(s)` : "No shared infrastructure with known sites" };
    },
  },
  {
    name: "sites.compare", kind: "read",
    summary: "Deterministic comparison of this site with related known sites: shared wallets, shared infrastructure keys, same kit cluster, and your past decisions on them.",
    args: z.object({ domains: z.array(z.string().min(3).max(253)).min(1).max(5) }).strict(),
    check(a, { digest }) {
      const known = new Set([...digest.related.map(r => r.domain), ...(digest.inbox?.related_domains ?? [])]);
      const bad = (a.domains as string[]).filter(d => !known.has(d));
      return bad.length ? [`not a related site of this investigation: ${bad.join(", ")}`] : [];
    },
    fingerprint: a => `sites.compare:${[...(a.domains as string[])].sort().join(",")}`,
    async execute(a, ctx) {
      const out = await compareSites(ctx.digest, a.domains as string[]);
      return { outcome: "completed", result: out, informative: out.some(o => o.shared_wallets.length || o.decision || o.outcomes.length), headline: `Compared with ${out.length} related site(s)` };
    },
  },
  {
    name: "evidence.inspect", kind: "read",
    summary: "Read stored evidence items of this investigation (type, knowledge class, scope, provenance, excerpt).",
    args: z.object({ evidence_ids: z.array(z.string().min(1).max(240)).min(1).max(10) }).strict(),
    check(a, { digest }) { const known = evidenceIds(digest); const bad = (a.evidence_ids as string[]).filter(id => !known.has(id)); return bad.length ? [`unknown evidence id(s): ${bad.join(", ")}`] : []; },
    fingerprint: a => `evidence.inspect:${[...(a.evidence_ids as string[])].sort().join(",")}`,
    async execute(a) {
      const ids = a.evidence_ids as string[];
      const rows = await getD1().prepare(`SELECT id,evidence_type,evidence_class,observation_scope,source_module,title,uri,sha256,provenance,context_text,captured_at FROM evidence WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<Row>();
      return { outcome: "completed", informative: true, headline: `Read ${rows.results.length} evidence item(s)`,
        result: rows.results.map(r => ({ id: r.id, type: r.evidence_type, class: knowledgeClass(r), scope: r.observation_scope, module: r.source_module, title: r.title, uri: r.uri, sha256: r.sha256, captured_at: r.captured_at, excerpt: String(r.context_text ?? "").slice(0, 1200) })) };
    },
  },
  {
    name: "memory.search", kind: "read",
    summary: "Search previous investigations and operational memory for this site, a wallet, its kit cluster or its infrastructure.",
    args: z.object({ subject: z.enum(["site", "wallet", "cluster"]), value: z.string().min(3).max(300) }).strict(),
    check(a, { digest }) {
      const allowed = a.subject === "site" ? [digest.site?.domain, ...(digest.inbox?.related_domains ?? []), ...digest.related.map(r => r.domain)] : a.subject === "wallet" ? digest.wallets.map(w => w.key) : [digest.inbox?.cluster_key];
      return allowed.includes(String(a.value)) ? [] : ["value is not a site, wallet or cluster of this investigation"];
    },
    fingerprint: (a, { digest }) => `memory.search:${a.subject}:${a.value}:${digest.memory_hint.prior_investigations_sharing_entities}`,
    async execute(a, ctx) {
      const out = await searchMemory(String(a.subject) as "site" | "wallet" | "cluster", String(a.value), ctx.run.investigation_id);
      return { outcome: "completed", result: out, informative: out.investigations.length + out.facts.length > 0, headline: out.investigations.length ? `Found ${out.investigations.length} earlier investigation(s) with the same ${a.subject}` : `Nothing earlier on this ${a.subject}` };
    },
  },
  {
    name: "report.request_draft", kind: "module", profileCapability: "report-preparation",
    summary: "Freeze the current evidence into a report draft that waits for your approval. Nothing is submitted without approval.",
    args: z.object({}).strict(),
    check(_a, { digest }) { return digest.report && ["needs_review", "ready", "completed"].includes(digest.report.status) ? ["a report draft already exists"] : digest.evidence.meaningful < 2 ? ["fewer than two meaningful evidence items"] : []; },
    fingerprint: () => "report.request_draft",
    async execute(_a, ctx) {
      const created = await createReportCandidate(ctx.run.investigation_id);
      if (!created.ok) return { outcome: "blocked", headline: created.message };
      return { outcome: "completed", result: { candidate_id: created.candidate_id, evidence_sha256: created.evidence_sha256 }, informative: true, headline: "Report draft ready for your review" };
    },
  },
  {
    name: "human.request", kind: "human",
    summary: "Pause and ask a person for a human-only step (login, CAPTCHA, MFA, email verification) or a review. Barrier kinds need observed evidence of the barrier.",
    args: z.object({ kind: z.enum(["login", "captcha", "mfa", "email_verification", "analyst_review"]) }).strict(),
    check(a, { digest }) {
      if (a.kind === "analyst_review") return [];
      return digest.barriers.some(b => b.kind === a.kind) ? [] : [`no observed evidence of a ${a.kind} barrier`];
    },
    fingerprint: (a, { digest }) => `human.request:${a.kind}:${digest.checkpoints.filter(c => c.kind === a.kind).length}`,
    async execute(a, ctx) {
      const barrier = ctx.digest.barriers.find(b => b.kind === a.kind);
      const id = await openCheckpoint(ctx.run, String(a.kind) as BarrierKind | "analyst_review", "model_proposal", barrier?.evidence_ids ?? ctx.triggeringEvidence, ctx.digest);
      return { outcome: "waiting", checkpointId: id, status: "WAITING_FOR_HUMAN", headline: CHECKPOINT_TEXT[String(a.kind) as BarrierKind].title };
    },
  },
  {
    name: "investigation.conclude", kind: "terminal",
    summary: "Stop: COMPLETE when the site was investigated and observed wallets analysed; INSUFFICIENT_EVIDENCE when further work has low expected value.",
    args: z.object({ status: z.enum(["COMPLETE", "INSUFFICIENT_EVIDENCE"]), summary: z.string().min(3).max(400) }).strict(),
    check(a, { digest }) { const allowed = completionOptions(digest); return allowed.includes(String(a.status)) ? [] : [`${a.status} is not allowed yet: ${blockers(digest).join("; ") || "criteria not met"}`]; },
    fingerprint: a => `investigation.conclude:${a.status}`,
    async execute(a) { return { outcome: "concluded", status: a.status as RunStatus, headline: a.status === "COMPLETE" ? "Investigation complete" : "Not enough evidence to continue", result: { summary: a.summary } }; },
  },
];
export const CAPABILITY_BY_NAME = new Map(CAPABILITIES.map(c => [c.name, c]));

/** Deterministic completion gate. The model may propose a conclusion; this decides. */
export function blockers(d: Digest) {
  const out: string[] = [];
  if (d.in_flight.length) out.push("module work in progress");
  if (d.checkpoints.some(c => c.status === "open")) out.push("a human step is outstanding");
  return out;
}
export function completionOptions(d: Digest): string[] {
  if (blockers(d).length) return [];
  const investigated = d.progress.site_investigated;
  const pendingWallets = d.wallets.filter(w => !w.analyzed && !["failed", "needs-review"].includes(w.analysis)).length;
  const options: string[] = [];
  if (investigated && d.evidence.meaningful >= 1 && d.wallets.length > 0 && pendingWallets === 0) options.push("COMPLETE");
  if (d.dead.dead || investigated || d.progress.site_investigation_failed) options.push("INSUFFICIENT_EVIDENCE");
  return options;
}

export async function openCheckpoint(run: RunRow, kind: BarrierKind | "analyst_review", detectedBy: "deterministic" | "model_proposal", evidence: string[], digest: Digest) {
  const db = getD1(); const text = CHECKPOINT_TEXT[kind];
  const existing = await db.prepare("SELECT id FROM human_checkpoints WHERE investigation_id=? AND kind=? AND status='open'").bind(run.investigation_id, kind).first<{ id: string }>();
  if (existing) return existing.id;
  const marks = await db.prepare("SELECT (SELECT COALESCE(MAX(rowid),0) FROM evidence WHERE investigation_id=?) ev,(SELECT COALESCE(MAX(rowid),0) FROM investigation_entities WHERE investigation_id=?) ie").bind(run.investigation_id, run.investigation_id).first<{ ev: number; ie: number }>();
  const id = crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO human_checkpoints (id,investigation_id,run_id,kind,title,instructions,url,detected_by,trigger_evidence,evidence_watermark,observation_watermark) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, run.investigation_id, run.id, kind, text.title, text.instructions, digest.site?.url ?? null, detectedBy, json(evidence.slice(0, 5)), Number(marks?.ev ?? 0), Number(marks?.ie ?? 0)).run();
  const row = await db.prepare("SELECT id FROM human_checkpoints WHERE investigation_id=? AND kind=? AND status='open'").bind(run.investigation_id, kind).first<{ id: string }>();
  return row?.id ?? id;
}

// ------------------------------------------------------------ read-only analysis

type Keys = Array<[string, string]>;
function candidateKeys(details: Row): Keys { return (Array.isArray(details.keys) ? details.keys as unknown[] : []).filter((k): k is [string, string] => Array.isArray(k) && k.length === 2).map(k => [String(k[0]), String(k[1])]); }
function parse<T>(value: unknown, fallback: T): T { try { return typeof value === "string" ? JSON.parse(value) as T : (value as T) ?? fallback; } catch { return fallback; } }

export async function analyzeInfrastructure(d: Digest, entityId: string) {
  const db = getD1();
  const mine = await db.prepare("SELECT id,canonical_domain,details,cluster_key FROM inbox_candidates WHERE entity_id=? OR canonical_domain=? LIMIT 1").bind(entityId, d.site?.domain ?? "").first<Row>();
  const myKeys = candidateKeys(parse<Row>(mine?.details, {})).filter(([t]) => ["ip", "ns", "favicon", "san", "service", "wallet", "favtmpl"].includes(t));
  const others = mine ? await db.prepare("SELECT canonical_domain,details,decision,cluster_key FROM inbox_candidates WHERE id<>? ORDER BY created_at DESC LIMIT 1000").bind(mine.id).all<Row>() : { results: [] as Row[] };
  const shared: Array<{ domain: string; keys: string[]; decision: string | null }> = [];
  for (const o of others.results) {
    const k = new Set(candidateKeys(parse<Row>(o.details, {})).map(([t, v]) => `${t}:${v}`));
    const common = myKeys.map(([t, v]) => `${t}:${v}`).filter(x => k.has(x));
    if (common.length) shared.push({ domain: String(o.canonical_domain), keys: common.slice(0, 6), decision: o.decision ? String(o.decision) : null });
  }
  const metadata = d.evidence.recent.filter(e => e.class === "external_metadata").map(e => ({ id: e.id, type: e.type, excerpt: e.snippet }));
  return { basis: "deterministic", own_keys: myKeys.map(([t, v]) => `${t}:${v}`), shared: shared.slice(0, 20), metadata, note: "Shared infrastructure is a reason to look, not proof of common ownership." };
}

export async function compareSites(d: Digest, domains: string[]) {
  const db = getD1(); const mine = new Set(d.wallets.map(w => w.key));
  const out = [];
  for (const domain of domains) {
    const c = await db.prepare("SELECT canonical_domain,wallets,decision,decision_reason,cluster_key,investigation_id FROM inbox_candidates WHERE canonical_domain=?").bind(domain).first<Row>();
    const wallets = await db.prepare("SELECT e.canonical_key FROM entities e JOIN investigation_entities ie ON ie.entity_id=e.id JOIN investigation_entities s ON s.investigation_id=ie.investigation_id JOIN entities se ON se.id=s.entity_id WHERE e.entity_type='wallet' AND se.entity_type='site' AND se.canonical_key=?").bind(domain).all<{ canonical_key: string }>();
    const theirWallets = new Set([...wallets.results.map(w => w.canonical_key), ...parse<string[]>(c?.wallets, [])]);
    const outcomes = await db.prepare("SELECT outcome FROM finder_outcomes WHERE canonical_domain=?").bind(domain).all<{ outcome: string }>();
    out.push({ domain, same_cluster: Boolean(c?.cluster_key && c.cluster_key === d.inbox?.cluster_key), shared_wallets: [...theirWallets].filter(w => mine.has(w)), decision: c?.decision ? String(c.decision) : null,
      decision_reason: c?.decision_reason ? String(c.decision_reason) : null, outcomes: outcomes.results.map(o => o.outcome), basis: "deterministic" });
  }
  return out;
}
