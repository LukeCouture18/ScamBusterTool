import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { replayDecision } from "@/lib/ops/decisions";
const schema = z.object({ provider: z.string().max(40).optional(), tier: z.enum(["fast", "standard", "deep"]).optional() }).strict();
/** Developer replay: re-asks another model the same question and applies the same validator. Executes nothing. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const b = schema.parse(await readJsonBody(request, 512)); return Response.json(await replayDecision((await context.params).id, b)); }
  catch (error) { if (error instanceof Error && error.message === "DECISION_NOT_FOUND") return apiError(404, "NOT_FOUND", "Decision not found."); if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid replay options.", error.issues); return apiError(500, "OPS_REPLAY_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
