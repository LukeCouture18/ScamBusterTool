import { apiError } from "@/lib/platform";
import { humanTasks } from "@/lib/campaign/view";
/** Everything in this campaign that needs a person. An unknown campaign simply has no tasks. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { return Response.json({ tasks: await humanTasks((await context.params).id) }); }
  catch (error) { return apiError(500, "CAMPAIGN_VIEW_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
