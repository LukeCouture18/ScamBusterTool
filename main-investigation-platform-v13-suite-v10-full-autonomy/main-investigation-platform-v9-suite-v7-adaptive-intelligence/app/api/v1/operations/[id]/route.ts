import { apiError } from "@/lib/platform";
import { hunterOperation } from "@/lib/ops/hunter";
/** One reconstructed operation: model summary, members (with why), proposals and what Main did with them. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { const op = await hunterOperation((await context.params).id); return op ? Response.json(op) : apiError(404, "NOT_FOUND", "Operation not found."); }
  catch (error) { return apiError(500, "OPERATION_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
