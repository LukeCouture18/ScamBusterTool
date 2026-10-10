/**
 * Model routing (v5).
 *
 * The goal is not maximum model usage. Callers ask for a *task*; the router
 * decides whether a model is worth calling at all and, if so, which tier and
 * provider:
 *
 *   fast      extraction, classification, summarisation, command parsing
 *   standard  investigation planning, evidence analysis
 *   deep      difficult graph / hypothesis / campaign decisions
 *
 * It refuses (returns `null`, so the caller runs its deterministic path) when
 * no provider is configured, the global or provider budget for calls, tokens
 * or estimated cost would be exceeded, or the provider has been failing. On a
 * provider error it falls back to the next configured provider. Every attempt
 * is recorded with provider, model, tier, latency, tokens, estimated cost and
 * outcome, and linked to the AI decision it served so its usefulness can be
 * measured later.
 */
import { getD1 } from "../platform";
import { aiSetting, getProvider, parseModelJson, type ModelClass, type ModelProvider } from "./models";
import { canSpend, spend } from "../ops/budgets";

export const TASK_TIER: Record<string, ModelClass> = {
  extraction: "fast", classification: "fast", summarization: "fast", command_parse: "fast", planner_choice: "fast", review_critique: "fast",
  investigation_planning: "standard", evidence_analysis: "standard", hypothesis_proposal: "standard", report_draft: "standard",
  graph_analysis: "deep", hypothesis_analysis: "deep", campaign_decision: "deep",
};
/** Rough USD per million tokens [prompt, completion] by tier; override with AI_PRICE_JSON {"model":[in,out]}. */
const TIER_PRICE: Record<ModelClass, [number, number]> = { fast: [1, 5], standard: [3, 15], deep: [15, 75] };
export const FAILURE_WINDOW = 12, FAILURE_TRIP = 0.6;

function price(model: string, tier: ModelClass): [number, number] {
  try { const table = JSON.parse(aiSetting("AI_PRICE_JSON") || "{}") as Record<string, [number, number]>; if (Array.isArray(table[model])) return table[model]; } catch { /* default */ }
  return TIER_PRICE[tier];
}

/** Configured providers in preference order: AI_PROVIDER, then AI_FALLBACK_PROVIDERS. */
export function providerChain(): ModelProvider[] {
  const names = [aiSetting("AI_PROVIDER"), ...aiSetting("AI_FALLBACK_PROVIDERS").split(",")].map(s => s.trim().toLowerCase()).filter(n => n && n !== "rules");
  const out: ModelProvider[] = [];
  for (const n of [...new Set(names)]) { const p = getProvider(n); if (p && p.configured()) out.push(p); }
  return out;
}

export async function providerHealthy(name: string) {
  const rows = (await getD1().prepare("SELECT status FROM model_invocations WHERE provider=? AND is_replay=0 AND status NOT IN ('skipped_budget') ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(name, FAILURE_WINDOW).all<{ status: string }>()).results;
  if (rows.length < 4) return true;
  return rows.filter(r => r.status !== "ok").length / rows.length < FAILURE_TRIP;
}

export type RouteRequest = { task: string; system: string; prompt: string; maxTokens: number; decisionId?: string | null; tierOverride?: ModelClass; replay?: boolean; provider?: string };
export type RouteResult = { text: string; parsed: unknown; provider: string; model: string; tier: ModelClass; promptTokens: number; completionTokens: number; costUsd: number; invocationId: string };

async function record(row: { decisionId?: string | null; task: string; tier: string; provider: string; model: string; status: string; latency: number; pt: number; ct: number; cost: number; error?: string; replay?: boolean }) {
  const id = crypto.randomUUID();
  await getD1().prepare("INSERT INTO model_invocations (id,decision_id,task,tier,provider,model,status,latency_ms,prompt_tokens,completion_tokens,cost_usd,error,is_replay) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, row.decisionId ?? null, row.task, row.tier, row.provider, row.model, row.status, row.latency, row.pt, row.ct, row.cost, row.error?.slice(0, 300) ?? null, row.replay ? 1 : 0).run();
  return id;
}

/** Routes one request, or returns `{ skipped }` so the caller uses its deterministic path. */
export async function routedComplete(r: RouteRequest): Promise<RouteResult | { skipped: string; attempted?: number }> {
  let attempted = 0;
  const tier = r.tierOverride ?? TASK_TIER[r.task] ?? "standard";
  const chain = r.provider ? [getProvider(r.provider)].filter((p): p is ModelProvider => Boolean(p && p.configured())) : providerChain();
  if (!chain.length) return { skipped: "no model provider configured" };
  const estTokens = r.maxTokens + Math.ceil((r.system.length + r.prompt.length) / 4);
  for (const p of chain) {
    const scopes = [`provider:${p.name}`];
    if (!r.replay) {
      for (const [kind, units] of [["model_calls", 1], ["model_tokens", estTokens]] as const) {
        const ok = await canSpend(kind, units, scopes);
        if (!ok.ok) { await record({ decisionId: r.decisionId, task: r.task, tier, provider: p.name, model: p.model(tier), status: "skipped_budget", latency: 0, pt: 0, ct: 0, cost: 0, error: `${kind} budget (${ok.scope})` }); return { skipped: `${kind} budget reached (${ok.scope})` }; }
      }
      const [pin, pout] = price(p.model(tier), tier);
      const cost = await canSpend("model_cost_usd", (estTokens * Math.max(pin, pout)) / 1e6, scopes);
      if (!cost.ok) { await record({ decisionId: r.decisionId, task: r.task, tier, provider: p.name, model: p.model(tier), status: "skipped_budget", latency: 0, pt: 0, ct: 0, cost: 0, error: "cost budget" }); return { skipped: "model cost budget reached" }; }
      if (!(await providerHealthy(p.name))) { await record({ decisionId: r.decisionId, task: r.task, tier, provider: p.name, model: p.model(tier), status: "fallback", latency: 0, pt: 0, ct: 0, cost: 0, error: "provider unhealthy; skipped" }); continue; }
    }
    const started = Date.now();
    attempted++;
    try {
      const res = await p.complete({ system: r.system, prompt: r.prompt, modelClass: tier, maxTokens: r.maxTokens, timeoutMs: 30000 });
      const [pin, pout] = price(res.model, tier);
      const costUsd = (res.promptTokens * pin + res.completionTokens * pout) / 1e6;
      let parsed: unknown = null, status = "ok";
      try { parsed = parseModelJson(res.text); } catch { status = "invalid_output"; }
      const invocationId = await record({ decisionId: r.decisionId, task: r.task, tier, provider: p.name, model: res.model, status, latency: Date.now() - started, pt: res.promptTokens, ct: res.completionTokens, cost: costUsd, replay: r.replay });
      if (!r.replay) {
        await spend("model_calls", 1, invocationId, scopes);
        await spend("model_tokens", res.promptTokens + res.completionTokens, invocationId, scopes);
        await spend("model_cost_usd", costUsd, invocationId, scopes);
      }
      return { text: res.text, parsed, provider: p.name, model: res.model, tier, promptTokens: res.promptTokens, completionTokens: res.completionTokens, costUsd, invocationId };
    } catch (error) {
      const invocationId = await record({ decisionId: r.decisionId, task: r.task, tier, provider: p.name, model: p.model(tier), status: error instanceof Error && /timed out/i.test(error.message) ? "timeout" : "error", latency: Date.now() - started, pt: 0, ct: 0, cost: 0, error: error instanceof Error ? error.message : String(error), replay: r.replay });
      if (!r.replay) await spend("model_calls", 1, invocationId, scopes);
      // try the next provider
    }
  }
  return { skipped: attempted ? "every configured provider failed" : "no healthy provider", attempted };
}

/** Marks how useful the decisions an invocation served turned out to be (observed outcome). */
export async function markUsefulness(decisionId: string, useful: number) {
  await getD1().prepare("UPDATE model_invocations SET useful=? WHERE decision_id=?").bind(Math.max(0, Math.min(1, useful)), decisionId).run();
}

export async function routingStats() {
  return (await getD1().prepare("SELECT provider,model,tier,task,COUNT(*) calls,SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok,AVG(latency_ms) latency,SUM(prompt_tokens+completion_tokens) tokens,SUM(cost_usd) cost,AVG(useful) useful FROM model_invocations WHERE is_replay=0 GROUP BY provider,model,tier,task ORDER BY calls DESC LIMIT 50").all<Record<string, unknown>>()).results;
}
