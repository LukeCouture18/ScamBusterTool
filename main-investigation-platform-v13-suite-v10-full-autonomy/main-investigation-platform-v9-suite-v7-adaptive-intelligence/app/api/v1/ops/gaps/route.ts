import { z } from "zod";
import { apiError } from "@/lib/platform";
import { gapsFor } from "@/lib/ops/gaps";
export async function GET(request: Request) {
  try { const p = new URL(request.url).searchParams; return Response.json({ gaps: await gapsFor({ investigationId: p.get("investigation") ?? undefined, campaignId: p.get("campaign") ?? undefined, status: p.get("status") ?? undefined }) }); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_GAPS_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
