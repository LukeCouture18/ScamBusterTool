import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { setBudget, BUDGET_FIELDS } from "@/lib/campaign/campaign";
const schema = z.object(Object.fromEntries(BUDGET_FIELDS.map(k => [k, z.number().int().min(0).optional()]))).strict();
/** Set campaign budgets. Raising a spent budget lets a BUDGET_EXHAUSTED campaign continue. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const c = await setBudget((await context.params).id, schema.parse(await readJsonBody(request, 2048)));
    return Response.json({ id: c?.id, status: c?.status, budgets: Object.fromEntries(BUDGET_FIELDS.map(k => [k, c?.[k]])) });
  } catch (error) {
    if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid budget.", error.issues);
    const m = error instanceof Error ? error.message : "";
    if (m === "CAMPAIGN_NOT_FOUND") return apiError(404, "NOT_FOUND", "Campaign not found.");
    if (m.startsWith("BUDGET_INVALID")) return apiError(400, "BUDGET_INVALID", m);
    return apiError(500, "CAMPAIGN_BUDGET_ERROR", m || "Unable to update");
  }
}
