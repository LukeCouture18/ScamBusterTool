import { z } from "zod";
import { apiError } from "@/lib/platform";
import { campaignWorkspace } from "@/lib/ops/view";
/** v5 campaign workspace: goal, gaps, queue, timeline (lineage + changes), contradictions and activity. */
export async function GET(_r: Request, context: { params: Promise<{ id: string }> }) {
  try { const w = await campaignWorkspace((await context.params).id); return w ? Response.json(w) : apiError(404, "NOT_FOUND", "Campaign not found."); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_CAMPAIGN_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
