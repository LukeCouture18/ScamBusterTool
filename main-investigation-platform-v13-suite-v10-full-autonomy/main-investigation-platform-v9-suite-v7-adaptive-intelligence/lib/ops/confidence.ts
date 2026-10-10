/**
 * Confidence calibration: separate dimensions, never one generic number.
 *
 *   observation_reliability  how trustworthy an observation is (by source and kind)
 *   relationship_strength    how well supported a graph link is (independent sources)
 *   hypothesis_confidence    how far a hypothesis' tests have supported it
 *   discovery_confidence     Site Finder's triage confidence in a candidate
 *   entity_resolution        how sure we are two records are the same thing
 *   ai_uncertainty           a model's own stated uncertainty about a proposal
 *
 * Every change is recorded with its reason and basis. AI-sourced values may only
 * be written to `ai_uncertainty` (and to hypothesis confidence through the v4
 * test machinery, which moves it only on observed results). An AI can never
 * raise the reliability of evidence or the strength of a relationship.
 */
import { getD1 } from "../platform";
import { clamp, r3, type Row } from "./common";

export const DIMENSIONS = ["observation_reliability", "relationship_strength", "hypothesis_confidence", "discovery_confidence", "entity_resolution", "ai_uncertainty"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Basis = "observed" | "deterministic" | "human" | "ai";
const AI_WRITABLE = new Set<Dimension>(["ai_uncertainty"]);

/** Reliability of an observation by who made it and how. */
export const SOURCE_RELIABILITY: Record<string, number> = {
  site_investigator: 0.85, crypto_wallet_logger: 0.9, wallet_investigator: 0.85, site_finder: 0.6, platform: 0.5,
};

export async function recordConfidence(c: { subjectType: string; subjectId: string; dimension: Dimension; value: number; reason: string; basis: Basis; sourceRef?: string }) {
  if (!DIMENSIONS.includes(c.dimension)) throw new Error("CONFIDENCE_DIMENSION_INVALID");
  if (c.basis === "ai" && !AI_WRITABLE.has(c.dimension)) throw new Error("AI_CANNOT_SET_CONFIDENCE:" + c.dimension);
  const db = getD1();
  const prev = await db.prepare("SELECT value FROM confidence_records WHERE subject_type=? AND subject_id=? AND dimension=? ORDER BY at DESC, rowid DESC LIMIT 1").bind(c.subjectType, c.subjectId, c.dimension).first<Row>();
  const value = r3(clamp(c.value));
  if (prev && Math.abs(Number(prev.value) - value) < 0.005) return { changed: false, value };
  await db.prepare("INSERT INTO confidence_records (id,subject_type,subject_id,dimension,value,previous,reason,basis,source_ref) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), c.subjectType, c.subjectId, c.dimension, value, prev ? Number(prev.value) : null, c.reason.slice(0, 300), c.basis, c.sourceRef ?? null).run();
  return { changed: true, value, previous: prev ? Number(prev.value) : null };
}

export async function currentConfidence(subjectType: string, subjectId: string) {
  const rows = (await getD1().prepare("SELECT dimension,value,reason,basis,at FROM confidence_records c WHERE subject_type=? AND subject_id=? AND at=(SELECT MAX(at) FROM confidence_records c2 WHERE c2.subject_type=c.subject_type AND c2.subject_id=c.subject_id AND c2.dimension=c.dimension)").bind(subjectType, subjectId).all<Row>()).results;
  return Object.fromEntries(rows.map(r => [String(r.dimension), { value: Number(r.value), reason: String(r.reason), basis: String(r.basis), at: String(r.at) }]));
}

/** Observation reliability for new module evidence: by source module, reduced for error pages. */
export async function calibrateEvidence(limit = 200) {
  const db = getD1();
  const rows = (await db.prepare("SELECT e.id,e.source_module,e.evidence_type FROM evidence e WHERE NOT EXISTS (SELECT 1 FROM confidence_records c WHERE c.subject_type='evidence' AND c.subject_id=e.id AND c.dimension='observation_reliability') ORDER BY e.rowid DESC LIMIT ?").bind(limit).all<Row>()).results;
  for (const r of rows) {
    const base = SOURCE_RELIABILITY[String(r.source_module)] ?? 0.5;
    const isError = /(^|_)error$/.test(String(r.evidence_type));
    await recordConfidence({ subjectType: "evidence", subjectId: String(r.id), dimension: "observation_reliability", value: isError ? base * 0.6 : base,
      reason: `${r.source_module} ${String(r.evidence_type).replace(/_/g, " ")}${isError ? " (an error page: says less about the site)" : ""}`, basis: "deterministic", sourceRef: `evidence:${r.id}` });
  }
  return rows.length;
}
