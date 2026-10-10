import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { createCampaign, tickCampaign, BUDGET_FIELDS } from "@/lib/campaign/campaign";
import { listCampaigns } from "@/lib/campaign/view";

const schema = z.object({
  seed_domain: z.string().min(3).max(253),
  title: z.string().max(200).optional(),
  auto_associate: z.boolean().optional(),
  budgets: z.object(Object.fromEntries(BUDGET_FIELDS.map(k => [k, z.number().int().min(0).optional()]))).strict().optional(),
}).strict();

export async function GET() {
  try { return Response.json({ campaigns: await listCampaigns() }); }
  catch (error) { return apiError(500, "CAMPAIGN_LIST_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}

/** Start a campaign around a seed site already in the inbox, then run its first tick. */
export async function POST(request: Request) {
  try {
    const body = schema.parse(await readJsonBody(request, 8192));
    const c = await createCampaign({ ...body, started_by: "web-operator" });
    const first = await tickCampaign(String(c!.id));
    return Response.json({ id: c!.id, status: first.status, doing: first.headline }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid campaign.", error.issues);
    const m = error instanceof Error ? error.message : "";
    if (m === "SEED_NOT_FOUND") return apiError(404, "SEED_NOT_FOUND", "That site is not in the inbox yet.");
    if (m.startsWith("BUDGET_INVALID")) return apiError(400, "BUDGET_INVALID", m);
    return apiError(500, "CAMPAIGN_START_ERROR", m || "Unable to start");
  }
}
