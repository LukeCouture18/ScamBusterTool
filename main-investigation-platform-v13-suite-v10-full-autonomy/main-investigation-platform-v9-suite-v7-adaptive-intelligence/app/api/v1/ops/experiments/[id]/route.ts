import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { stopExperiment, summarize } from "@/lib/ops/experiments";
export async function GET(_r: Request, context: { params: Promise<{ id: string }> }) { try { return Response.json(await summarize((await context.params).id)); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_EXPERIMENT_ERROR", error instanceof Error ? error.message : "Unavailable"); } }
const schema = z.object({ action: z.literal("stop") }).strict();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { schema.parse(await readJsonBody(request, 256)); return Response.json({ stopped: await stopExperiment((await context.params).id) }); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_EXPERIMENT_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
