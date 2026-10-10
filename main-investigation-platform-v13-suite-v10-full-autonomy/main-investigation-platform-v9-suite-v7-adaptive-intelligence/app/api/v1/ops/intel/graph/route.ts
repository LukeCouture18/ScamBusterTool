import { z } from "zod";
import { apiError } from "@/lib/platform";
import { graphQuery } from "@/lib/ops/intel";
const list = (v: string | null) => (v ? v.split(",").map(s => s.trim()).filter(Boolean).slice(0, 20) : undefined);
/** A readable, filtered subgraph of the global intelligence graph (never the whole hairball). */
export async function GET(request: Request) {
  try {
    const u = new URL(request.url); const p = u.searchParams;
    return Response.json(await graphQuery({ types: list(p.get("types")), kinds: list(p.get("kinds")), minStrength: p.get("min_strength") ? Number(p.get("min_strength")) : undefined,
      sinceDays: p.get("since_days") ? Number(p.get("since_days")) : undefined, campaignId: p.get("campaign") ?? undefined, focus: p.get("focus") ?? undefined,
      depth: p.get("depth") ? Math.min(2, Number(p.get("depth"))) : undefined, limit: p.get("limit") ? Math.min(150, Number(p.get("limit"))) : undefined, includeGeneric: p.get("include_generic") === "1", includeInactive: p.get("include_inactive") === "1" }));
  } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_GRAPH_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
