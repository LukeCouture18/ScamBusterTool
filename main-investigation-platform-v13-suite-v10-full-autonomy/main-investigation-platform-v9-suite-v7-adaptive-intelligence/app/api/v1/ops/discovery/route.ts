import { z } from "zod";
import { apiError } from "@/lib/platform";
import { discoveryView } from "@/lib/ops/view";
export async function GET() { try { return Response.json(await discoveryView()); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_DISCOVERY_ERROR", error instanceof Error ? error.message : "Unavailable"); } }
