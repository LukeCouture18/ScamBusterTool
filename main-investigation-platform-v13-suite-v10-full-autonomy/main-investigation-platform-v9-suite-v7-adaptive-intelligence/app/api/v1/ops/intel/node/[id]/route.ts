import { apiError } from "@/lib/platform";
import { nodeDetail } from "@/lib/ops/intel";
/** One node: relationships with provenance, observation history, evidence, campaigns, gaps, reasoning links and confidence history. */
export async function GET(_r: Request, context: { params: Promise<{ id: string }> }) {
  try { const n = await nodeDetail((await context.params).id); return n ? Response.json(n) : apiError(404, "NOT_FOUND", "Node not found."); }
  catch (error) { return apiError(500, "OPS_NODE_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
