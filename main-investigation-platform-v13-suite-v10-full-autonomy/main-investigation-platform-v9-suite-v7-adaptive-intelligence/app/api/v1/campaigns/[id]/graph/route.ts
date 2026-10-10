import { apiError } from "@/lib/platform";
import { campaignGraph } from "@/lib/campaign/view";
/** The campaign graph: observable relationships with provenance, plus hypotheses as a separate overlay. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await campaignGraph((await context.params).id);
    return body ? Response.json(body) : apiError(404, "NOT_FOUND", "Campaign not found.");
  } catch (error) { return apiError(500, "CAMPAIGN_VIEW_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
