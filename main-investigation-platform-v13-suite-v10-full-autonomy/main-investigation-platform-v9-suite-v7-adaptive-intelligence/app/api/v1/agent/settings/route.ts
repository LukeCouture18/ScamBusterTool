import { z } from "zod";
import { apiError, getD1, readJsonBody } from "@/lib/platform";
const KEYS = ["enabled", "auto_start_on_useful", "campaign_model_strategist", "campaign_model_reviewer", "max_actions", "max_duration_seconds", "max_discovery_expansions", "max_module_calls", "max_model_calls", "max_model_tokens", "max_retries", "max_low_value_steps"] as const;
const BOOL = new Set(["enabled", "auto_start_on_useful", "campaign_model_strategist", "campaign_model_reviewer"]);
const schema = z.object(Object.fromEntries(KEYS.map(k => [k, (BOOL.has(k) ? z.boolean() : z.number().int().min(0).max(BOOL.has(k) ? 1 : 1_000_000)).optional()]))).strict();
export async function GET() {
  try { const rows = await getD1().prepare("SELECT key,value FROM agent_settings").all<{ key: string; value: string }>(); return Response.json(Object.fromEntries(rows.results.map(r => [r.key, BOOL.has(r.key) ? r.value === "true" : Number(r.value)]))); }
  catch (error) { return apiError(500, "AGENT_SETTINGS_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
export async function PATCH(request: Request) {
  try {
    const body = schema.parse(await readJsonBody(request, 4096)); const db = getD1();
    for (const [key, value] of Object.entries(body)) { if (value === undefined) continue; await db.prepare("INSERT INTO agent_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(key, String(value)).run(); }
    const rows = await db.prepare("SELECT key,value FROM agent_settings").all<{ key: string; value: string }>();
    return Response.json(Object.fromEntries(rows.results.map(r => [r.key, BOOL.has(r.key) ? r.value === "true" : Number(r.value)])));
  } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid settings.", error.issues); return apiError(500, "AGENT_SETTINGS_ERROR", error instanceof Error ? error.message : "Unable to update"); }
}
