import { env } from "cloudflare:workers";

export const SOURCE_MODULES = ["site_finder", "site_investigator", "crypto_wallet_logger", "wallet_investigator", "form_submitter", "operation_hunter", "platform"] as const;
export type SourceModule = (typeof SOURCE_MODULES)[number];

export function getD1(): D1Database {
  if (!env.DB) throw new Error("Database binding DB is unavailable");
  return env.DB;
}

export function getBucket(): R2Bucket {
  if (!env.BUCKET) throw new Error("Evidence storage binding BUCKET is unavailable");
  return env.BUCKET;
}

export function apiError(status: number, code: string, message: string, details?: unknown) {
  return Response.json({ error: { code, message, details }, request_id: crypto.randomUUID() }, { status });
}

export function assertModule(value: string): value is SourceModule {
  return SOURCE_MODULES.includes(value as SourceModule);
}

export function selectModuleKey(config: string | undefined, module: SourceModule, legacy: string | undefined, allowLegacy: boolean) {
  let keys: Partial<Record<SourceModule, string>>;
  try { keys = JSON.parse(config ?? "{}"); } catch { throw new Error("AUTH_CONFIG_INVALID"); }
  return keys[module]?.trim() || (allowLegacy ? legacy?.trim() : "") || "";
}

export async function authorizeModule(request: Request, module: SourceModule) {
  const configured = selectModuleKey(env.MODULE_API_KEYS, module, env.INGEST_API_KEY, env.ALLOW_LEGACY_API_KEY === "true");
  if (!configured) throw new Error("AUTH_NOT_CONFIGURED");
  const supplied = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!supplied || supplied !== configured) throw new Error("UNAUTHORIZED");
}

export async function readJsonBody(request: Request, maxBytes = 5 * 1024 * 1024) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("REQUEST_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("REQUEST_TOO_LARGE");
  return JSON.parse(text);
}

export async function enforceRateLimit(module: SourceModule, limit = 120) {
  const db = getD1(); const windowStart = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  await db.prepare("INSERT INTO rate_limit_windows (module_name, window_start, request_count) VALUES (?, ?, 1) ON CONFLICT(module_name, window_start) DO UPDATE SET request_count = request_count + 1").bind(module, windowStart).run();
  const row = await db.prepare("SELECT request_count FROM rate_limit_windows WHERE module_name = ? AND window_start = ?").bind(module, windowStart).first<{ request_count: number }>();
  if ((row?.request_count ?? 0) > limit) throw new Error("RATE_LIMITED");
}

export async function writeAudit(requestId: string, actor: string | null, action: string, resourceType: string, resourceId: string | null, status: string, details: unknown = {}) {
  await getD1().prepare("INSERT INTO audit_log (id, request_id, actor_module, action, resource_type, resource_id, status, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), requestId, actor, action, resourceType, resourceId, status, json(details)).run();
}

export function authError(error: unknown) {
  if (!(error instanceof Error)) return null;
  if (error.message === "UNAUTHORIZED") return apiError(401, "UNAUTHORIZED", "The module API key is missing or invalid.");
  if (error.message === "AUTH_NOT_CONFIGURED" || error.message === "AUTH_CONFIG_INVALID") return apiError(503, "AUTH_NOT_CONFIGURED", "Production module authentication is not configured correctly.");
  if (error.message === "RATE_LIMITED") return apiError(429, "RATE_LIMITED", "The module request limit has been exceeded. Retry with backoff.");
  if (error.message === "REQUEST_TOO_LARGE") return apiError(413, "REQUEST_TOO_LARGE", "Request bodies are limited to 5 MB.");
  return null;
}

export function json(value: unknown) { return JSON.stringify(value ?? {}); }

export async function sha256(value: string | ArrayBuffer) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function now() { return new Date().toISOString(); }
