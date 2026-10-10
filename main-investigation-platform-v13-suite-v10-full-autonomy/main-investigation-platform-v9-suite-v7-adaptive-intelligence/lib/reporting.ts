import { getD1, json } from "./platform";
import { snapshotReport, deriveState } from "./planner";

/**
 * Freezes the investigation's evidence into a reporting candidate that waits for
 * analyst approval. Shared by the report route and the v3 investigator's
 * `report.request_draft` capability, so both apply the same rule: at least two
 * captured evidence items, a hash-frozen snapshot, and a pending approval gate.
 * Nothing is submitted anywhere until a person approves it.
 */
export async function createReportCandidate(investigationId: string) {
  const db = getD1();
  const evidence = await db.prepare("SELECT COUNT(DISTINCT id) n,COUNT(DISTINCT source_module) sources FROM evidence WHERE investigation_id=?").bind(investigationId).first<{ n: number; sources: number }>();
  if (Number(evidence?.n ?? 0) < 2) return { ok: false as const, code: "INSUFFICIENT_EVIDENCE", message: "At least two captured evidence items are needed to prepare a reporting candidate." };
  const { snapshot, hash } = await snapshotReport(investigationId), id = crypto.randomUUID(), gate = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO approval_gates (id,investigation_id,action,scope,requested_reason) VALUES (?,?,'PREPARE_REPORT',?,?)").bind(gate, investigationId, json({ candidate_id: id, evidence_sha256: hash }), "Review the frozen evidence snapshot and confirm the reporting scope."),
    db.prepare("INSERT INTO report_candidates (id,investigation_id,evidence_snapshot,evidence_sha256,approval_id) VALUES (?,?,?,?,?)").bind(id, investigationId, snapshot, hash, gate),
  ]);
  await deriveState(investigationId);
  return { ok: true as const, candidate_id: id, status: "needs_review", evidence_sha256: hash, evidence_count: evidence?.n, independent_sources: evidence?.sources };
}
