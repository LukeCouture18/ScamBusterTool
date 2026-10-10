/**
 * Model/provider abstraction for the v3 AI investigator.
 *
 * The investigator talks to `ModelProvider`, never to a vendor SDK. Adapters
 * for Anthropic, OpenAI, Google and any OpenAI-compatible local server (for
 * example Ollama or vLLM) use plain `fetch`, so no provider is baked into the
 * architecture and a new one is one object with a `complete()` method.
 *
 * Three model classes let each kind of work use an appropriately priced model:
 *   fast      inexpensive classification / extraction
 *   standard  normal investigation reasoning (the default planner)
 *   deep      difficult planning, used after rejected or low-value steps
 *
 * A provider only returns text. Everything it returns is untrusted: the
 * investigator parses it against a strict schema and a deterministic policy
 * before anything happens (lib/agent/policy.ts). A failing, slow or
 * misbehaving provider can cost a retry, never investigation state.
 *
 * `rules` is a deterministic planner that speaks the same output format. It is
 * used when no model is configured, when retries are exhausted, and as the
 * baseline in evaluation. It is not presented as AI.
 */
import { env } from "cloudflare:workers";

export type ModelClass = "fast" | "standard" | "deep";
export type ModelRequest = { system: string; prompt: string; modelClass: ModelClass; maxTokens: number; timeoutMs?: number; context?: unknown };
export type ModelResponse = { text: string; model: string; promptTokens: number; completionTokens: number };
export interface ModelProvider {
  readonly name: string;
  /** True when the provider has what it needs (key, model names). */
  configured(): boolean;
  model(modelClass: ModelClass): string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class ModelError extends Error {
  constructor(message: string, readonly kind: "timeout" | "http" | "network" | "invalid_output" | "not_configured", readonly status?: number) { super(message); }
}

type EnvLike = Record<string, string | undefined>;
function config(): EnvLike { return (env ?? {}) as unknown as EnvLike; }
function setting(...keys: string[]) { const e = config(); for (const k of keys) { const v = e[k]?.trim(); if (v) return v; } return ""; }
/** Read-only access to AI configuration for the v5 model router. */
export function aiSetting(...keys: string[]) { return setting(...keys); }

/** Model names per class. Anthropic has defaults; other vendors must be configured explicitly. */
function modelFor(prefix: string, modelClass: ModelClass, defaults?: Record<ModelClass, string>) {
  const upper = modelClass.toUpperCase();
  return setting(`AI_${prefix}_MODEL_${upper}`, `AI_MODEL_${upper}`) || defaults?.[modelClass] || "";
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new ModelError(`Model request timed out after ${timeoutMs} ms`, "timeout");
    throw new ModelError(`Model request failed: ${error instanceof Error ? error.message : String(error)}`, "network");
  }
  const text = await response.text();
  if (!response.ok) throw new ModelError(`Model provider returned HTTP ${response.status}: ${text.slice(0, 300)}`, "http", response.status);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new ModelError("Model provider returned non-JSON", "invalid_output"); }
}

const ANTHROPIC_DEFAULTS: Record<ModelClass, string> = { fast: "claude-haiku-4-5-20251001", standard: "claude-sonnet-5", deep: "claude-opus-5-5" };

export const anthropicProvider: ModelProvider = {
  name: "anthropic",
  configured() { return Boolean(setting("AI_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY")); },
  model(c) { return modelFor("ANTHROPIC", c, ANTHROPIC_DEFAULTS); },
  async complete(r) {
    const key = setting("AI_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"); if (!key) throw new ModelError("Anthropic API key not configured", "not_configured");
    const model = this.model(r.modelClass);
    const base = setting("AI_ANTHROPIC_BASE_URL") || "https://api.anthropic.com";
    const out = await post(`${base}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" },
      { model, max_tokens: r.maxTokens, system: r.system, messages: [{ role: "user", content: r.prompt }] }, r.timeoutMs ?? 45000);
    const parts = Array.isArray(out.content) ? out.content as Array<{ type?: string; text?: string }> : [];
    const usage = (out.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    return { text: parts.filter(p => p.type === "text").map(p => p.text ?? "").join(""), model, promptTokens: Number(usage.input_tokens ?? 0), completionTokens: Number(usage.output_tokens ?? 0) };
  },
};

function openAiCompatible(name: string, keyNames: string[], baseDefault: string, prefix: string): ModelProvider {
  return {
    name,
    configured() { return Boolean((keyNames.length ? setting(...keyNames) : "local") && this.model("standard") && (name !== "local" || setting("AI_LOCAL_BASE_URL"))); },
    model(c) { return modelFor(prefix, c); },
    async complete(r) {
      const key = keyNames.length ? setting(...keyNames) : setting("AI_LOCAL_API_KEY");
      if (keyNames.length && !key) throw new ModelError(`${name} API key not configured`, "not_configured");
      const model = this.model(r.modelClass); if (!model) throw new ModelError(`${name} model for class ${r.modelClass} not configured (AI_${prefix}_MODEL_${r.modelClass.toUpperCase()})`, "not_configured");
      const base = setting(`AI_${prefix}_BASE_URL`) || baseDefault; if (!base) throw new ModelError(`${name} base URL not configured`, "not_configured");
      const out = await post(`${base.replace(/\/$/, "")}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {},
        { model, max_completion_tokens: r.maxTokens, response_format: { type: "json_object" }, messages: [{ role: "system", content: r.system }, { role: "user", content: r.prompt }] }, r.timeoutMs ?? 45000);
      const choice = (Array.isArray(out.choices) ? out.choices[0] : undefined) as { message?: { content?: string } } | undefined;
      const usage = (out.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
      return { text: String(choice?.message?.content ?? ""), model, promptTokens: Number(usage.prompt_tokens ?? 0), completionTokens: Number(usage.completion_tokens ?? 0) };
    },
  };
}

export const openaiProvider = openAiCompatible("openai", ["AI_OPENAI_API_KEY", "OPENAI_API_KEY"], "https://api.openai.com/v1", "OPENAI");
/** Any OpenAI-compatible local server: set AI_LOCAL_BASE_URL (e.g. http://127.0.0.1:11434/v1) and AI_LOCAL_MODEL_*. */
export const localProvider = openAiCompatible("local", [], "", "LOCAL");

export const googleProvider: ModelProvider = {
  name: "google",
  configured() { return Boolean(setting("AI_GOOGLE_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY") && this.model("standard")); },
  model(c) { return modelFor("GOOGLE", c); },
  async complete(r) {
    const key = setting("AI_GOOGLE_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"); if (!key) throw new ModelError("Google API key not configured", "not_configured");
    const model = this.model(r.modelClass); if (!model) throw new ModelError(`Google model for class ${r.modelClass} not configured`, "not_configured");
    const base = setting("AI_GOOGLE_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta";
    const out = await post(`${base}/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": key },
      { systemInstruction: { parts: [{ text: r.system }] }, contents: [{ role: "user", parts: [{ text: r.prompt }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: r.maxTokens } }, r.timeoutMs ?? 45000);
    const candidate = (Array.isArray(out.candidates) ? out.candidates[0] : undefined) as { content?: { parts?: Array<{ text?: string }> } } | undefined;
    const usage = (out.usageMetadata ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number };
    return { text: (candidate?.content?.parts ?? []).map(p => p.text ?? "").join(""), model, promptTokens: Number(usage.promptTokenCount ?? 0), completionTokens: Number(usage.candidatesTokenCount ?? 0) };
  },
};

const registry = new Map<string, ModelProvider>([["anthropic", anthropicProvider], ["openai", openaiProvider], ["google", googleProvider], ["local", localProvider]]);

/** Adds or replaces a provider (tests use this for scripted and adversarial models). */
export function registerProvider(provider: ModelProvider) { registry.set(provider.name, provider); }
export function getProvider(name: string) { return registry.get(name) ?? null; }

/**
 * The provider the investigator should use: AI_PROVIDER when it is configured,
 * otherwise `rules` (the deterministic planner). The reason is reported so the
 * UI can say "no model configured" instead of pretending.
 */
export function selectProvider(): { name: string; provider: ModelProvider | null; note: string } {
  const wanted = setting("AI_PROVIDER").toLowerCase();
  if (!wanted || wanted === "rules") return { name: "rules", provider: null, note: "No model provider configured; using the deterministic planner." };
  const provider = registry.get(wanted);
  if (!provider) return { name: "rules", provider: null, note: `Unknown AI_PROVIDER "${wanted}"; using the deterministic planner.` };
  if (!provider.configured()) return { name: "rules", provider: null, note: `AI_PROVIDER=${wanted} is missing its key or model names; using the deterministic planner.` };
  return { name: provider.name, provider, note: `Using ${provider.name}.` };
}

/** Extracts the first JSON object from model text (tolerates code fences). Throws ModelError on failure. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{"), end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ModelError("Model output contained no JSON object", "invalid_output");
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { throw new ModelError("Model output was not valid JSON", "invalid_output"); }
}
