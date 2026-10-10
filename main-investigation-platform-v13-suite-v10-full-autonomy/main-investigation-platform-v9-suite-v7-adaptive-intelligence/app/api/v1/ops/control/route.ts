import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { getBool, getNum, setState } from "@/lib/ops/common";
const schema = z.object({ scheduler: z.enum(["pause", "resume"]).optional(), discovery: z.enum(["pause", "resume", "pause_low_priority"]).optional() }).strict();
/** Pause/resume operations or discovery. Running module work always finishes; nothing new starts while paused. */
export async function POST(request: Request) {
  try {
    const b = schema.parse(await readJsonBody(request, 512));
    if (b.scheduler) await setState("scheduler_paused", b.scheduler === "pause");
    if (b.discovery === "pause") await setState("discovery_paused", true);
    if (b.discovery === "resume") { await setState("discovery_paused", false); await setState("discovery_min_priority", 0); }
    if (b.discovery === "pause_low_priority") await setState("discovery_min_priority", 0.35);
    return Response.json({ scheduler_paused: await getBool("scheduler_paused", false), discovery_paused: await getBool("discovery_paused", false), discovery_min_priority: await getNum("discovery_min_priority", 0) });
  } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_CONTROL_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
