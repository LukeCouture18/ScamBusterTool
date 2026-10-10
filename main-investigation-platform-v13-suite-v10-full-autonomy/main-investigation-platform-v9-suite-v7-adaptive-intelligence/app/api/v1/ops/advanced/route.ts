import { z } from "zod";
import { apiError } from "@/lib/platform";
import { advancedTelemetry } from "@/lib/ops/view";
/** Advanced telemetry (hidden by default in the UI): health, routing, learning, scheduler, experiments, simulations, decisions. */
export async function GET() { try { return Response.json(await advancedTelemetry()); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_ADVANCED_ERROR", error instanceof Error ? error.message : "Unavailable"); } }
