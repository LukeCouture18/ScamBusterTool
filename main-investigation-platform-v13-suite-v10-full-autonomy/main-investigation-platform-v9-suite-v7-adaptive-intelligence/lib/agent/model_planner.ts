/**
 * The model planner: turns the digest into a prompt, calls the selected
 * provider, and returns parsed JSON for the policy to validate. It never acts;
 * it only proposes. It also picks the model class: `deep` after a rejection or
 * a low-value streak, `standard` otherwise. `fast` is available for classify/
 * extract helpers but the main plan uses standard/deep.
 *
 * The prompt states the safety boundary plainly and lists only the capabilities
 * the profile allows, but the boundary is enforced by policy.ts, not by the
 * prompt — a model that ignores it produces a plan that is rejected.
 */
import { getD1, json } from "../platform";
import { ModelError, parseModelJson, type ModelClass, type ModelProvider } from "../ai/models";
import { CAPABILITIES } from "./capabilities";
import type { Digest } from "./state";
import type { StepHistory } from "./policy";

const SYSTEM = [
  "You are the planning layer of a crypto-scam investigation platform. You choose ONE next action from a fixed capability list, or conclude.",
  "You never see and never touch credentials, logins, CAPTCHAs, MFA, email verification, funds, or module databases. When a human-only step blocks progress, choose human.request; do not try to get past it.",
  "Evidence comes only from modules. You never assert observed facts; if you infer something, put it under `inferences` with the evidence ids it rests on. Inferences are recorded as AI opinion, never as evidence.",
  "Cite only evidence ids and entity ids present in the state. Reply with ONE JSON object and nothing else.",
].join(" ");

const OUTPUT_SPEC = {
  rationale: "one or two sentences, no links or markup",
  action: { capability: "one capability name from the list", arguments: "object matching that capability" },
  triggering_evidence: ["evidence id from state that prompted this"],
  expected_value: "0..1 estimate of how much this advances the investigation",
  inferences: [{ claim: "optional AI opinion", entity_id: "optional entity id", cited_evidence: ["evidence id"] }],
};

function allowedCapabilities(profile: string) {
  const map: Record<string, string[]> = {
    "quick-triage": ["site:investigate", "wallet:analyze"],
    "standard-investigation": ["site:investigate", "site:relate", "wallet:analyze", "wallet:log", "report-preparation"],
    "deep-investigation": ["site:investigate", "site:relate", "wallet:analyze", "wallet:log", "report-preparation"],
    "continuous-monitoring": ["site:investigate", "wallet:analyze", "report-preparation"],
  };
  const allowed = new Set(map[profile] ?? map["standard-investigation"]);
  return CAPABILITIES.filter(c => !c.profileCapability || allowed.has(c.profileCapability))
    .map(c => ({ capability: c.name, kind: c.kind, does: c.summary, arguments: argHint(c.name) }));
}

function argHint(name: string): Record<string, unknown> {
  switch (name) {
    case "site.investigate": case "wallet.analyze": case "infrastructure.analyze": return { entity_id: "entity id (uuid)" };
    case "discovery.find_related": return { entity_id: "site entity id", max_candidates: "1..10" };
    case "discovery.request": return { requested: "1..10", reason: "short reason" };
    case "sites.compare": return { domains: ["related domain from state"] };
    case "evidence.inspect": return { evidence_ids: ["evidence id from state"] };
    case "memory.search": return { subject: "site|wallet|cluster", value: "value from state" };
    case "report.request_draft": return {};
    case "human.request": return { kind: "login|captcha|mfa|email_verification|analyst_review" };
    case "investigation.conclude": return { status: "COMPLETE|INSUFFICIENT_EVIDENCE", summary: "short summary" };
    default: return {};
  }
}

/** The compact, model-facing view of the digest. Only ids present here are citable. */
export function promptDigest(d: Digest) {
  return {
    investigation: d.investigation.title, site: d.site ? { entity_id: d.site.entity_id, domain: d.site.domain } : null,
    progress: d.progress,
    evidence_summary: { total: d.evidence.total, meaningful: d.evidence.meaningful, wallet: d.evidence.wallet, by_class: d.evidence.by_class, by_module: d.evidence.by_module },
    recent_evidence: d.evidence.recent.map(e => ({ id: e.id, type: e.type, knowledge_class: e.class, scope: e.scope, module: e.module, title: e.title, excerpt: e.snippet })),
    wallets: d.wallets.map(w => ({ entity_id: w.entity_id, address: w.key, analysed: w.analyzed, analysis_status: w.analysis, sources: w.sources })),
    detected_barriers: d.barriers.map(b => ({ kind: b.kind, why: b.reason, evidence: b.evidence_ids })),
    dead_site: d.dead.dead ? d.dead : undefined,
    open_human_steps: d.checkpoints.filter(c => c.status === "open").map(c => ({ kind: c.kind })),
    module_work_in_progress: d.in_flight,
    related_sites: [...new Set([...d.related.map(r => r.domain), ...(d.inbox?.related_domains ?? [])])].slice(0, 8),
    cluster: d.inbox?.cluster_key || undefined, cluster_prior_outcomes: d.memory_hint.cluster_outcomes,
    prior_investigations_sharing_entities: d.memory_hint.prior_investigations_sharing_entities,
    report: d.report,
  };
}

export function pickModelClass(history: StepHistory): ModelClass {
  const last = history[history.length - 1];
  if (last && last.validation === "rejected") return "deep";
  const tail = history.slice(-2);
  if (tail.length === 2 && tail.every(h => (h.realized_value ?? 1) <= 0)) return "deep";
  return "standard";
}

export type PlanAttempt = { raw: unknown; text: string; model: string; modelClass: ModelClass; promptTokens: number; completionTokens: number };

export async function modelPlan(provider: ModelProvider, d: Digest, profile: string, history: StepHistory, rejectionReasons: string[], maxTokens: number): Promise<PlanAttempt> {
  const modelClass = pickModelClass(history);
  const prompt = json({
    state: promptDigest(d),
    capabilities: allowedCapabilities(profile),
    recent_steps: history.slice(-6).map(h => ({ capability: h.capability, validation: h.validation, outcome: h.outcome })),
    previous_attempt_rejected_because: rejectionReasons.length ? rejectionReasons : undefined,
    respond_with: OUTPUT_SPEC,
    reminder: "Pick the single most valuable next action. If module work is in progress or a human step is open, do not duplicate it. Conclude when more work has low expected value.",
  });
  const response = await provider.complete({ system: SYSTEM, prompt, modelClass, maxTokens });
  let raw: unknown;
  try { raw = parseModelJson(response.text); } catch (error) { throw new ModelError(error instanceof Error ? error.message : "unparseable model output", "invalid_output"); }
  return { raw, text: response.text.slice(0, 8000), model: response.model, modelClass, promptTokens: response.promptTokens, completionTokens: response.completionTokens };
}

export async function recordModelCall(runId: string, stepId: string | null, provider: string, model: string, modelClass: string, status: string, latencyMs: number, promptTokens: number, completionTokens: number, error?: string) {
  await getD1().prepare("INSERT INTO agent_model_calls (id,run_id,step_id,provider,model,model_class,status,latency_ms,prompt_tokens,completion_tokens,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), runId, stepId, provider, model, modelClass, status, Math.round(latencyMs), promptTokens, completionTokens, error ?? null).run();
}
