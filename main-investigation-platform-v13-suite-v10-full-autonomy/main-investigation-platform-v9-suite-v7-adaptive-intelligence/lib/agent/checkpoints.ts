/**
 * Human checkpoints: pause for a person and resume from what they produce.
 *
 * A checkpoint records the evidence/entity high-water marks at the moment it
 * opened. It resolves automatically only when NEW evidence (or a new entity)
 * has arrived past those marks — i.e. the person actually did the human-only
 * step and a module captured the result — or when the person explicitly marks
 * it done (analyst_review, or an override). Resolving it wakes the run.
 *
 * The platform never performs the human step; it only recognises that it
 * happened and continues from the new evidence.
 */
import { getD1 } from "../platform";
import { timeline } from "../orchestrator";
import { wake } from "./runner";

type Row = Record<string, unknown>;

export async function openCheckpoints(investigationId: string) {
  const rows = await getD1().prepare("SELECT id,kind,title,instructions,url,status,created_at FROM human_checkpoints WHERE investigation_id=? AND status='open' ORDER BY created_at").bind(investigationId).all<Row>();
  return rows.results;
}

/** New observed evidence past a checkpoint's watermark means the human step happened. */
async function newEvidenceSince(investigationId: string, evidenceWatermark: number, observationWatermark: number) {
  const db = getD1();
  const ev = await db.prepare("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND rowid>?").bind(investigationId, evidenceWatermark).first<{ n: number }>();
  const ie = await db.prepare("SELECT COUNT(*) n FROM investigation_entities WHERE investigation_id=? AND rowid>?").bind(investigationId, observationWatermark).first<{ n: number }>();
  return Number(ev?.n ?? 0) + Number(ie?.n ?? 0);
}

/**
 * Checks every open checkpoint for an investigation and auto-resolves those
 * that now have new evidence. Idempotent. Called when evidence arrives.
 */
export async function tryResolveFromEvidence(investigationId: string) {
  const db = getD1();
  const open = await db.prepare("SELECT * FROM human_checkpoints WHERE investigation_id=? AND status='open'").bind(investigationId).all<Row>();
  let resolved = 0;
  for (const c of open.results) {
    if (String(c.kind) === "analyst_review") continue;                 // only a person closes a review
const gained = c.run_id ? await newEvidenceSince(investigationId, Number(c.evidence_watermark ?? 0), Number(c.observation_watermark ?? 0)) : Number((await db.prepare("SELECT COUNT(*) n FROM evidence WHERE investigation_id=? AND rowid>? AND source_module='crypto_wallet_logger' AND (observation_scope='authenticated' OR (evidence_type='wallet_observation' AND json_extract(metadata,'$.context_class')='deposit'))").bind(investigationId,Number(c.evidence_watermark??0)).first<{n:number}>())?.n??0);
    if (gained <= 0) continue;
    const marks = await db.prepare("SELECT id FROM evidence WHERE investigation_id=? AND rowid>? ORDER BY rowid LIMIT 5").bind(investigationId, Number(c.evidence_watermark ?? 0)).all<{ id: string }>();
    const changed = await db.prepare("UPDATE human_checkpoints SET status='resolved',resolution='new_evidence',resolution_evidence=?,resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").bind(JSON.stringify(marks.results.map(r => r.id)), c.id).run();
    if ((changed.meta?.changes ?? 0) === 1) {
      resolved++;
      await timeline({ investigationId, sourceModule: "platform", eventType: "agent.human_resolved", title: "Human step completed", detail: `${c.kind} resolved from new evidence; resuming.`, data: { checkpoint_id: c.id } });
    }
  }
  if (resolved) await wake(investigationId, "human");
  return resolved;
}

/** Explicit resolution by a person (used for analyst_review, or to override a stuck barrier). */
export async function resolveCheckpoint(id: string, resolution: "analyst_confirmed" | "cancelled") {
  const db = getD1();
  const c = await db.prepare("SELECT * FROM human_checkpoints WHERE id=? AND status='open'").bind(id).first<Row>();
  if (!c) return null;
  await db.prepare("UPDATE human_checkpoints SET status=?,resolution=?,resolved_at=CURRENT_TIMESTAMP WHERE id=?").bind(resolution === "cancelled" ? "cancelled" : "resolved", resolution, id).run();
  await timeline({ investigationId: String(c.investigation_id), sourceModule: "platform", eventType: "agent.human_resolved", title: resolution === "cancelled" ? "Human step cancelled" : "Marked done by analyst", detail: String(c.kind), data: { checkpoint_id: id } });
  if (resolution === "cancelled") {
    // Cancelling a barrier stops the run rather than resuming into the same wall.
    await db.prepare("UPDATE agent_runs SET status='STOPPED',stop_reason='Human step cancelled',headline='Stopped: human step cancelled',finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE investigation_id=? AND status='WAITING_FOR_HUMAN'").bind(c.investigation_id).run();
    return "cancelled";
  }
  await wake(String(c.investigation_id), "human");
  return "resolved";
}
