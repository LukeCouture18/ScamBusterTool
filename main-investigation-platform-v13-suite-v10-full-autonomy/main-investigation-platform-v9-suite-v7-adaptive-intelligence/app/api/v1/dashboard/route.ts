import { apiError, getD1, SOURCE_MODULES } from "@/lib/platform";

export async function GET() {
  try {
    const db = getD1();
    const [counts, entityCounts, investigations, activity, modules, batches] = await Promise.all([
      db.prepare("SELECT (SELECT COUNT(*) FROM investigations WHERE status!='closed') investigations, (SELECT COUNT(*) FROM entities) entities, (SELECT COUNT(*) FROM relationships) relationships, (SELECT COUNT(*) FROM evidence) evidence, (SELECT COUNT(*) FROM findings) findings, (SELECT COUNT(*) FROM notes) notes, (SELECT COUNT(*) FROM jobs WHERE status IN ('pending','running','retrying','needs-review','awaiting-approval')) queued_jobs, (SELECT COUNT(*) FROM investigation_pipelines WHERE status IN ('running','paused','needs-review')) active_pipelines, (SELECT COUNT(*) FROM review_queue WHERE status='open') review_items, (SELECT COUNT(*) FROM notifications WHERE is_read=0) unread_notifications").first(),
      db.prepare("SELECT entity_type, COUNT(*) count FROM entities GROUP BY entity_type ORDER BY count DESC").all(),
      db.prepare("SELECT id, external_id, title, status, priority, updated_at FROM investigations ORDER BY updated_at DESC LIMIT 6").all(),
      db.prepare("SELECT source_module, status, message, occurred_at FROM module_activity ORDER BY occurred_at DESC LIMIT 12").all(),
      db.prepare("SELECT module_name source_module, CASE WHEN last_heartbeat_at >= datetime('now','-90 seconds') THEN runtime_status ELSE 'offline' END status, CASE WHEN last_error IS NOT NULL THEN last_error ELSE 'Module heartbeat received' END message, last_heartbeat_at occurred_at FROM module_registry").all(),
      db.prepare("SELECT source_module, batch_id, status, received_count, inserted_count, updated_count, error_count, completed_at FROM ingestion_batches ORDER BY received_at DESC LIMIT 8").all(),
    ]);
    const moduleMap = new Map((modules.results as Array<Record<string, unknown>>).map((row) => [row.source_module, row]));
    return Response.json({ counts, entity_counts: entityCounts.results, investigations: investigations.results, activity: activity.results, batches: batches.results, modules: SOURCE_MODULES.map((name) => moduleMap.get(name) ?? { source_module: name, status: "offline", message: "No data received yet", occurred_at: null }), generated_at: new Date().toISOString() });
  } catch (error) { return apiError(503, "DATA_UNAVAILABLE", error instanceof Error ? error.message : "Dashboard data is unavailable"); }
}
