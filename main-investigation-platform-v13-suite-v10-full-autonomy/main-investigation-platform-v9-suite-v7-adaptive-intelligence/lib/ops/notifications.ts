/**
 * Attention management. Notifications are for things a person should know:
 * something needs them, something unusually useful happened, a campaign
 * finished, an important contradiction appeared, a budget is nearly spent, a
 * report is ready, or a module/provider is unhealthy. Routine successful
 * background work never notifies. Repeats of the same thing collapse into one
 * open notification with a count.
 */
import { getD1 } from "../platform";
import { type Row } from "./common";

export const KINDS = ["human_action", "useful_discovery", "campaign_completed", "contradiction", "budget_warning", "report_ready", "health"] as const;
export type Kind = (typeof KINDS)[number];

export async function notify(n: { kind: Kind; severity?: "info" | "warning" | "critical"; title: string; body?: string; link?: string; dedupeKey: string }) {
  if (!KINDS.includes(n.kind)) throw new Error("NOTIFICATION_KIND_INVALID");
  const db = getD1();
  const r = await db.prepare("UPDATE ops_notifications SET count=count+1,last_at=CURRENT_TIMESTAMP,title=?,body=? WHERE dedupe_key=? AND status='open'").bind(n.title.slice(0, 200), (n.body ?? "").slice(0, 600), n.dedupeKey).run();
  if ((r.meta?.changes ?? 0) > 0) return { deduped: true };
  await db.prepare("INSERT OR IGNORE INTO ops_notifications (id,kind,severity,title,body,link,dedupe_key) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), n.kind, n.severity ?? "info", n.title.slice(0, 200), (n.body ?? "").slice(0, 600), n.link ?? null, n.dedupeKey).run();
  return { deduped: false };
}

export async function listNotifications(status = "open", limit = 50) {
  return (await getD1().prepare("SELECT * FROM ops_notifications WHERE status=? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_at DESC LIMIT ?").bind(status, limit).all<Row>()).results;
}

export async function markNotification(id: string, status: "read" | "dismissed") {
  const r = await getD1().prepare("UPDATE ops_notifications SET status=? WHERE id=? AND status='open'").bind(status, id).run();
  return (r.meta?.changes ?? 0) === 1;
}
