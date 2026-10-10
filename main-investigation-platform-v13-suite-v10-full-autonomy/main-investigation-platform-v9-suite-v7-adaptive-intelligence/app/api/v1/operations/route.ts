import { apiError } from "@/lib/platform";
import { hunterOperations } from "@/lib/ops/hunter";
/** Operations reconstructed by Operation Hunter (living model summaries). Membership is inference, not proof of ownership. */
export async function GET(request: Request) {
  try { const limit = Number(new URL(request.url).searchParams.get("limit") ?? 30); return Response.json(await hunterOperations(Number.isFinite(limit) ? limit : 30)); }
  catch (error) { return apiError(500, "OPERATIONS_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
