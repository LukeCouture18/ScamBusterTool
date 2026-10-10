import { apiError } from "@/lib/platform";
import { investigationAdvanced } from "@/lib/agent/view";
/** Full audit trail for the Advanced expander: steps, rejections, budgets, model calls, inferences, provenance. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { const view = await investigationAdvanced((await context.params).id); return view ? Response.json(view, { headers: { "cache-control": "no-store" } }) : apiError(404, "NOT_FOUND", "Investigation not found."); }
  catch (error) { return apiError(500, "AGENT_ADVANCED_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
