import { apiError } from "@/lib/platform";
import { agentEnabled, startRun, tick } from "@/lib/agent/runner";
/** Start (or resume) the AI investigator for this investigation, then run one step. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!(await agentEnabled())) return apiError(409, "AGENT_DISABLED", "The AI investigator is turned off in settings.");
    const run = await startRun((await context.params).id, "web-operator");
    if (!run) return apiError(404, "NOT_FOUND", "Investigation not found.");
    if (run.status === "RUNNING") await tick(run.id);
    return Response.json({ run_id: run.id, status: run.status });
  } catch (error) { return apiError(500, "AGENT_START_ERROR", error instanceof Error ? error.message : "Unable to start"); }
}
