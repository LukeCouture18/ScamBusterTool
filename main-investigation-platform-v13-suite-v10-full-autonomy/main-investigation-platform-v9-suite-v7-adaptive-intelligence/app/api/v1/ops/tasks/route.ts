import { z } from "zod";
import { apiError } from "@/lib/platform";
import { humanTasks } from "@/lib/ops/view";
/** Everything that needs a person: access checkpoints, analyst reviews, contradictions and report approvals. */
export async function GET() { try { return Response.json(await humanTasks()); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_TASKS_ERROR", error instanceof Error ? error.message : "Unavailable"); } }
