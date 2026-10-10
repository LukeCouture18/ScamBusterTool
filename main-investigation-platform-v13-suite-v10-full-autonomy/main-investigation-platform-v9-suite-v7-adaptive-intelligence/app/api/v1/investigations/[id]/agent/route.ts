import { apiError } from "@/lib/platform";
import { investigationView } from "@/lib/agent/view";
/** Simple investigation view for the UI: status, activity, human step. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { const view = await investigationView((await context.params).id); return view ? Response.json(view, { headers: { "cache-control": "no-store" } }) : apiError(404, "NOT_FOUND", "Investigation not found."); }
  catch (error) { return apiError(500, "AGENT_VIEW_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
