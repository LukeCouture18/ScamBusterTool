/**
 * Operational reliability: observability and automatic recovery for a
 * long-running system. Failed work is never silently discarded: it is retried
 * with backoff up to its limit, then kept as `failed`, a person is notified, and
 * it stays visible in Operations.
 */
import { getD1 } from "../platform";
import { json, hoursSince, type Row } from "./common";

export const STALE_RUN_HOURS = 6, STUCK_CAMPAIGN_MINUTES = 30, SCHEDULER_STALE_MINUTES = 15;

export function backoffMs(attempts: number) { return Math.min(6 * 3600000, 5 * 60000 * 2 ** Math.max(0, attempts - 1)); }

/** Recovers recoverable stuck work. Returns what it did. */
export async function recover(owner: string) {
  const db = getD1(); const now = new Date().toISOString(); const did: Row = {};
  // 1. Work items claimed by a tick that died before recording an outcome: adopt the job/run it
  //    had already created (never create it twice), otherwise requeue with backoff.
  const orphans = (await db.prepare("SELECT * FROM work_items WHERE status='running' AND job_id IS NULL AND run_id IS NULL AND lease_until IS NOT NULL AND lease_until<?").bind(now).all<Row>()).results;
  let adopted = 0, requeued = 0;
  for (const w of orphans) {
    const j = await db.prepare("SELECT id FROM jobs WHERE json_extract(payload,'$.work_item_id')=? ORDER BY created_at DESC LIMIT 1").bind(w.id).first<Row>();
    const r = await db.prepare("SELECT id FROM agent_runs WHERE started_by=? ORDER BY started_at DESC LIMIT 1").bind(`ops:${w.id}`).first<Row>();
    if (j || r) { await db.prepare("UPDATE work_items SET job_id=?,run_id=?,lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(j?.id ?? null, r?.id ?? null, w.id).run(); adopted++; }
    else if (w.kind === "campaign_step" || Number(w.attempts) < Number(w.max_attempts)) {
      await db.prepare("UPDATE work_items SET status='queued',lease_owner=NULL,lease_until=NULL,not_before=?,last_error='recovered after an interrupted tick',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(new Date(Date.now() + (w.kind === "campaign_step" ? 0 : backoffMs(Number(w.attempts)))).toISOString(), w.id).run(); requeued++;
    } else await failForGood(w, "interrupted repeatedly");
  }
  did.adopted = adopted; did.requeued = requeued;
  // 2. Stale investigator runs: RUNNING with an expired lease and an old next_run_at get their lease cleared (the next tick advances them).
  const stale = await db.prepare("UPDATE agent_runs SET lease_owner=NULL,lease_until=NULL,next_run_at=CURRENT_TIMESTAMP WHERE status='RUNNING' AND lease_until IS NOT NULL AND lease_until<?").bind(now).run();
  did.runs_unleased = stale.meta?.changes ?? 0;
  // 3. Stuck campaigns: a lease that expired.
  const camp = await db.prepare("UPDATE campaigns SET lease_owner=NULL,lease_until=NULL,next_tick_at=CURRENT_TIMESTAMP WHERE status='RUNNING' AND lease_until IS NOT NULL AND lease_until<?").bind(now).run();
  did.campaigns_unleased = camp.meta?.changes ?? 0;
  // Module jobs with an expired worker lease are already recovered by claimJob (lib/jobs.ts).
  return did;
}

export async function failForGood(w: Row, why: string) {
  const db = getD1();
  await db.prepare("UPDATE work_items SET status='failed',last_error=?,lease_owner=NULL,lease_until=NULL,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(why.slice(0, 300), w.id).run();
  await db.prepare("INSERT INTO work_item_events (id,work_item_id,event,detail) VALUES (?,?,?,?)").bind(crypto.randomUUID(), w.id, "failed", json({ why })).run();
  const { notify } = await import("./notifications");
  await notify({ kind: "health", severity: "warning", title: `Work failed after ${w.attempts} attempt(s): ${String(w.kind).replace(/_/g, " ")}`, body: `${String(w.target_key).slice(0, 80)}: ${why}. It is kept in the queue history; retry it from Operations.`, link: "/operations", dedupeKey: `failed:${w.kind}` });
}

export async function healthSnapshot() {
  const db = getD1(); const t0 = Date.now();
  const q = async <T extends Row>(sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<T>()).results;
  const queue = Object.fromEntries((await q("SELECT status,COUNT(*) n FROM work_items GROUP BY status")).map(r => [String(r.status), Number(r.n)]));
  const jobs = Object.fromEntries((await q("SELECT status,COUNT(*) n FROM jobs WHERE updated_at>=datetime('now','-1 day') GROUP BY status")).map(r => [String(r.status), Number(r.n)]));
  const latency = (await q("SELECT job_type,AVG((julianday(completed_at)-julianday(created_at))*86400) s,COUNT(*) n FROM jobs WHERE completed_at IS NOT NULL AND completed_at>=datetime('now','-1 day') GROUP BY job_type"));
  const retries = Number((await q("SELECT COUNT(*) n FROM jobs WHERE attempt_count>1 AND updated_at>=datetime('now','-1 day')"))[0]?.n ?? 0);
  const modules = (await q("SELECT module_name,runtime_status,last_heartbeat_at,last_error FROM module_registry")).map(m => ({ module: m.module_name, status: hoursSince(m.last_heartbeat_at) * 60 > 3 ? "offline" : String(m.runtime_status), last_heartbeat_at: m.last_heartbeat_at, last_error: m.last_error }));
  const providers = (await q("SELECT provider,COUNT(*) n,SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok FROM model_invocations WHERE is_replay=0 AND created_at>=datetime('now','-1 day') GROUP BY provider")).map(p => ({ provider: p.provider, calls: Number(p.n), failure_rate: Number(p.n) ? 1 - Number(p.ok) / Number(p.n) : 0 }));
  const aiFailures = Number((await q("SELECT COUNT(*) n FROM model_invocations WHERE status NOT IN ('ok','skipped_budget') AND is_replay=0 AND created_at>=datetime('now','-1 day')"))[0]?.n ?? 0);
  const lastTick = (await q("SELECT started_at,finished_at,status FROM scheduler_ticks ORDER BY started_at DESC LIMIT 1"))[0];
  const staleRuns = (await q("SELECT id,investigation_id,status,updated_at FROM agent_runs WHERE status IN ('RUNNING','WAITING_FOR_MODULE') AND updated_at<datetime('now', ?) LIMIT 20", `-${STALE_RUN_HOURS} hours`));
  const stuckCampaigns = (await q("SELECT id,title,next_tick_at FROM campaigns WHERE status='RUNNING' AND next_tick_at<datetime('now', ?) LIMIT 20", `-${STUCK_CAMPAIGN_MINUTES} minutes`));
  const failedWork = (await q("SELECT id,kind,target_key,last_error,attempts,finished_at FROM work_items WHERE status='failed' ORDER BY finished_at DESC LIMIT 20"));
  const dbMs = Date.now() - t0;
  const schedulerAgeMin = lastTick ? hoursSince(lastTick.started_at) * 60 : null;
  const status = (schedulerAgeMin != null && schedulerAgeMin > SCHEDULER_STALE_MINUTES) || modules.some(m => m.status === "offline") || providers.some(p => p.failure_rate > 0.5) ? "degraded" : "ok";
  return {
    status, queue, jobs_24h: jobs, job_latency_seconds: latency.map(l => ({ job_type: l.job_type, avg: Math.round(Number(l.s)), n: Number(l.n) })), retries_24h: retries,
    modules, providers, ai_failures_24h: aiFailures,
    scheduler: { last_tick: lastTick ?? null, minutes_since: schedulerAgeMin == null ? null : Math.round(schedulerAgeMin), paused: (await q("SELECT value FROM ops_state WHERE key='scheduler_paused'"))[0]?.value === "true" },
    database: { ok: true, query_ms: dbMs }, stale_investigations: staleRuns, stuck_campaigns: stuckCampaigns, failed_work: failedWork,
  };
}

/** Records a compact health row per component and notifies once per unhealthy component. */
export async function recordHealth() {
  const h = await healthSnapshot();
  const db = getD1();
  const { notify } = await import("./notifications");
  const rows: Array<[string, string, unknown]> = [
    ["scheduler", h.scheduler.minutes_since != null && h.scheduler.minutes_since > SCHEDULER_STALE_MINUTES ? "degraded" : "ok", h.scheduler],
    ["queue", (h.queue.failed ?? 0) > 20 ? "degraded" : "ok", h.queue],
    ["database", "ok", h.database],
    ...h.modules.map(m => [`module:${m.module}`, m.status === "offline" || m.status === "error" ? "down" : "ok", m] as [string, string, unknown]),
    ...h.providers.map(p => [`provider:${p.provider}`, p.failure_rate > 0.5 ? "degraded" : "ok", p] as [string, string, unknown]),
  ];
  for (const [component, status, detail] of rows) {
    const last = await db.prepare("SELECT status FROM health_checks WHERE component=? ORDER BY at DESC, rowid DESC LIMIT 1").bind(component).first<Row>();
    if (last?.status !== status) await db.prepare("INSERT INTO health_checks (id,component,status,detail) VALUES (?,?,?,?)").bind(crypto.randomUUID(), component, status, json(detail)).run();
    if (status !== "ok" && (component.startsWith("module:") || component.startsWith("provider:"))) await notify({ kind: "health", severity: "warning", title: `${component.replace(":", " ")} is ${status}`, body: "Work that needs it waits and resumes on its own when it recovers.", link: "/operations", dedupeKey: `health:${component}` });
  }
  return h;
}
