import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { requestReconstruction } from "@/lib/ops/hunter";
const schema = z.object({ campaign_id: z.string().max(80).optional(), domain: z.string().max(400).optional(), operation_id: z.string().max(200).optional() }).strict();
/** Operator: queue a reconstruction (a `reconstruct_operation` work item; the scheduler runs it within budgets). */
export async function POST(request: Request) {
  try { const b = schema.parse(await readJsonBody(request, 4096)); return Response.json(await requestReconstruction({ campaignId: b.campaign_id, domain: b.domain, operationId: b.operation_id }), { status: 202 }); }
  catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); if (error instanceof Error && ["TARGET_REQUIRED", "OPERATION_NOT_FOUND"].includes(error.message)) return apiError(400, error.message, error.message.replace(/_/g, " ").toLowerCase()); return apiError(500, "RECONSTRUCT_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
