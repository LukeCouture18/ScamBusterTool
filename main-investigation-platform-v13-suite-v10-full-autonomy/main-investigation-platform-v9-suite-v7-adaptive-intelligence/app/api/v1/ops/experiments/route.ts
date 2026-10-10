import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { createExperiment, STRATEGIES } from "@/lib/ops/experiments";
import { getD1 } from "@/lib/platform";
export async function GET() {
  try { return Response.json({ strategies: Object.entries(STRATEGIES).map(([id, s]) => ({ id, domain: s.domain, describe: s.describe })), experiments: (await getD1().prepare("SELECT * FROM strategy_experiments ORDER BY started_at DESC LIMIT 30").all()).results }); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_EXPERIMENTS_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
/** A bounded A/B experiment between two registered strategies (ordering only, ±20%). */
export async function POST(request: Request) {
  try { return Response.json({ id: await createExperiment(await readJsonBody(request, 4096)) }, { status: 201 }); }
  catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid experiment.", error.issues); const m = error instanceof Error ? error.message : ""; if (m.startsWith("EXPERIMENT_")) return apiError(400, m.split(":")[0], m); return apiError(500, "OPS_EXPERIMENT_ERROR", m || "Unavailable"); }
}
