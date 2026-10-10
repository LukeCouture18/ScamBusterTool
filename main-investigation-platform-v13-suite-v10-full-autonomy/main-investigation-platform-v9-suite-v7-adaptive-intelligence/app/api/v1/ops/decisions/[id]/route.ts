import { z } from "zod";
import { apiError } from "@/lib/platform";
import { decisionView } from "@/lib/ops/decisions";
export async function GET(_r: Request, context: { params: Promise<{ id: string }> }) {
  try { const d = await decisionView((await context.params).id); return d ? Response.json(d) : apiError(404, "NOT_FOUND", "Decision not found."); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_DECISION_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
