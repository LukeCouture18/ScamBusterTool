import { apiError } from "@/lib/platform";
import { campaignAdvanced } from "@/lib/campaign/view";
/** Advanced: opportunities and scores, role traces, hypotheses, costs, experience, provenance and raw jobs. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await campaignAdvanced((await context.params).id);
    return body ? Response.json(body) : apiError(404, "NOT_FOUND", "Campaign not found.");
  } catch (error) { return apiError(500, "CAMPAIGN_VIEW_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
