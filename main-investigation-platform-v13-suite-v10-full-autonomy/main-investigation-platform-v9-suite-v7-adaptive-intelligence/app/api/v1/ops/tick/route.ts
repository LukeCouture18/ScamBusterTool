import { z } from "zod";
import { apiError } from "@/lib/platform";
import { schedulerTick } from "@/lib/ops/scheduler";
/** Runs one scheduler tick now (the cron trigger does this continuously). Takes the same lease; a concurrent tick is skipped. */
export async function POST() { try { return Response.json(await schedulerTick({ owner: `web:${crypto.randomUUID()}` })); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_TICK_ERROR", error instanceof Error ? error.message : "Unavailable"); } }
