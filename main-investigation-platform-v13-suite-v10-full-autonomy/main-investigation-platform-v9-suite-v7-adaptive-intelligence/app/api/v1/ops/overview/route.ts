import { z } from "zod";
import { apiError } from "@/lib/platform";
import { operationsOverview } from "@/lib/ops/view";
/** Operations home: system state, what the AI is doing, campaigns, discoveries, findings, human tasks, throughput and budgets. */
export async function GET() { try { return Response.json(await operationsOverview()); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_OVERVIEW_ERROR", error instanceof Error ? error.message : "Unavailable"); } }
