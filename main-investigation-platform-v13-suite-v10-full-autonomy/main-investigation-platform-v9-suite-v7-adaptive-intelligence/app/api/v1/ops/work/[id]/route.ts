import { z } from "zod";
import { apiError } from "@/lib/platform";
import { workItemView } from "@/lib/ops/workitems";
export async function GET(_r: Request, context: { params: Promise<{ id: string }> }) {
  try { const w = await workItemView((await context.params).id); return w ? Response.json(w) : apiError(404, "NOT_FOUND", "Work item not found."); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_WORK_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
