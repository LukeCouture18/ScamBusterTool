import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { budgetSummary, setLimit } from "@/lib/ops/budgets";
export async function GET() { try { return Response.json({ budgets: await budgetSummary() }); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_BUDGETS_ERROR", error instanceof Error ? error.message : "Unavailable"); } }
const schema = z.object({ scope: z.string().regex(/^(global|module:[a-z_]{3,40}|provider:[a-z0-9_-]{2,40})$/), kind: z.enum(["module_jobs", "discovery_requests", "investigations", "model_calls", "model_tokens", "model_cost_usd"]), max: z.number().min(0).max(1e9) }).strict();
/** Sets a daily limit. Campaign budgets stay on the campaign (/api/v1/campaigns/:id/budget). */
export async function POST(request: Request) {
  try { const b = schema.parse(await readJsonBody(request, 512)); await setLimit(b.scope, b.kind, b.max); return Response.json({ budgets: await budgetSummary() }); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_BUDGET_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
