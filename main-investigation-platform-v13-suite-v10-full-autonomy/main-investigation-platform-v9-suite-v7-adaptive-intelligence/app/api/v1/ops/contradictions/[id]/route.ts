import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { resolveContradiction } from "@/lib/ops/contradictions";
const schema = z.object({ resolution: z.enum(["resolved", "dismissed"]), note: z.string().min(3).max(400) }).strict();
/** An analyst resolves or dismisses a contradiction; the decision is recorded as a human label. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const b = schema.parse(await readJsonBody(request, 2048)); return Response.json(await resolveContradiction((await context.params).id, b.resolution, b.note)); }
  catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "resolution and a short note are required.", error.issues); if (error instanceof Error && error.message === "CONTRADICTION_NOT_FOUND") return apiError(404, "NOT_FOUND", "Contradiction not found."); return apiError(500, "OPS_CONTRADICTION_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
