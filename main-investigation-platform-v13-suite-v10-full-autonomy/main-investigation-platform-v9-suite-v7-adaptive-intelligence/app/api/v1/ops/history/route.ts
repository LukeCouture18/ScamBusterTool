import { z } from "zod";
import { apiError } from "@/lib/platform";
import { history } from "@/lib/ops/temporal";
/** Observation history of one entity: facets, snapshots and changes. */
export async function GET(request: Request) {
  try { const p = new URL(request.url).searchParams; const type = z.enum(["domain", "wallet", "campaign"]).parse(p.get("type") ?? "domain"); const key = z.string().min(1).max(400).parse(p.get("key")); return Response.json(await history(type, key)); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_HISTORY_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
