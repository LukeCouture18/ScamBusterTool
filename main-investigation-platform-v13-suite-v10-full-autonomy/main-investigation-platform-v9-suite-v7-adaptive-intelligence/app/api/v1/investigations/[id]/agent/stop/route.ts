import { apiError, getD1 } from "@/lib/platform";
import { timeline } from "@/lib/orchestrator";
/** Stop the active AI investigation. In-flight module jobs are left to finish; the loop does not resume. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const db = getD1(); const inv = await db.prepare("SELECT id FROM investigations WHERE id=? OR external_id=?").bind((await context.params).id, (await context.params).id).first<{ id: string }>();
    if (!inv) return apiError(404, "NOT_FOUND", "Investigation not found.");
    const r = await db.prepare("UPDATE agent_runs SET status='STOPPED',stop_reason='Stopped by operator',headline='Stopped by you',finished_at=CURRENT_TIMESTAMP,lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE investigation_id=? AND status IN ('RUNNING','WAITING_FOR_MODULE','WAITING_FOR_HUMAN','PAUSED')").bind(inv.id).run();
    if (r.meta?.changes) await timeline({ investigationId: inv.id, sourceModule: "platform", eventType: "agent.stopped", title: "Investigation stopped", detail: "Stopped by operator." });
    return Response.json({ stopped: (r.meta?.changes ?? 0) > 0 });
  } catch (error) { return apiError(500, "AGENT_STOP_ERROR", error instanceof Error ? error.message : "Unable to stop"); }
}
