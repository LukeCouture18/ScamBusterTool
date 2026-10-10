import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { queueView } from "@/lib/ops/view";
import { getD1 } from "@/lib/platform";
import { cancelWork, workEvent } from "@/lib/ops/workitems";
const STATUS = z.enum(["queued", "running", "waiting_human", "done", "failed", "cancelled", "suppressed", "deferred"]);
/** The global opportunity queue (filter by status, kind, campaign). */
export async function GET(request: Request) {
  try { const u = new URL(request.url); const status = u.searchParams.get("status"); return Response.json(await queueView({ status: status ? STATUS.parse(status) : undefined, kind: u.searchParams.get("kind") ?? undefined, campaignId: u.searchParams.get("campaign") ?? undefined, limit: Number(u.searchParams.get("limit") ?? 60) })); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_QUEUE_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
const action = z.object({ id: z.string().min(8).max(64), action: z.enum(["retry", "cancel"]) }).strict();
/** Operator actions on one item: retry failed/cancelled work, or cancel queued work. Neither bypasses the scheduler. */
export async function POST(request: Request) {
  try {
    const b = action.parse(await readJsonBody(request, 1024));
    if (b.action === "cancel") return Response.json({ cancelled: await cancelWork({ id: b.id }, "cancelled by operator") });
    const r = await getD1().prepare("UPDATE work_items SET status='queued',attempts=0,last_error=NULL,job_id=NULL,run_id=NULL,not_before=NULL,finished_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('failed','cancelled')").bind(b.id).run();
    if ((r.meta?.changes ?? 0) !== 1) return apiError(409, "NOT_RETRYABLE", "Only failed or cancelled work can be retried.");
    await workEvent(b.id, "retried_by_operator", {});
    return Response.json({ retried: true });
  } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_QUEUE_ACTION_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
