import { apiError } from "@/lib/platform";
import { campaignOverview } from "@/lib/campaign/view";
/** The simple campaign view: status, what and why, findings, human tasks, progress and budget. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const view = await campaignOverview((await context.params).id);
    return view ? Response.json(view) : apiError(404, "NOT_FOUND", "Campaign not found.");
  } catch (error) { return apiError(500, "CAMPAIGN_VIEW_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
