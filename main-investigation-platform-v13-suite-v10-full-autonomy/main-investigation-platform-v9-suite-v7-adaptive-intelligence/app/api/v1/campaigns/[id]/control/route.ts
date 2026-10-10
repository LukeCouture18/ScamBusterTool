import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { control, tickCampaign } from "@/lib/campaign/campaign";
const schema = z.object({ action: z.enum(["pause", "resume", "stop"]) }).strict();
/** Pause, resume or stop a campaign. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { action } = schema.parse(await readJsonBody(request, 1024));
    const id = (await context.params).id;
    const c = await control(id, action);
    if (action === "resume" && c?.status === "RUNNING") await tickCampaign(id);
    return Response.json({ id, status: c?.status });
  } catch (error) {
    if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "action must be pause, resume or stop.", error.issues);
    if (error instanceof Error && error.message === "CAMPAIGN_NOT_FOUND") return apiError(404, "NOT_FOUND", "Campaign not found.");
    return apiError(500, "CAMPAIGN_CONTROL_ERROR", error instanceof Error ? error.message : "Unable to update");
  }
}
