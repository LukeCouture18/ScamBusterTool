/**
 * Cross-investigation memory and Site Finder outcome labels.
 *
 * Both are written only by deterministic code from things that happened:
 * module observations, job results, detected barriers and your decisions. The
 * `basis` column records which. Model output (rationales, inferences,
 * conclusions it proposed) is never a source, so an AI conclusion cannot turn
 * into "memory" or into a training label for discovery.
 */
import { getD1, json } from "../platform";
import type { Digest } from "./state";

type Row = Record<string, unknown>;
export type Basis = "observed" | "deterministic" | "human" | "external_metadata";
export const FINDER_OUTCOMES = ["useful", "skip", "meaningful_evidence", "wallet_evidence", "investigation_completed", "dead_site", "auth_barrier", "duplicate", "low_evidence"] as const;
export type FinderOutcome = (typeof FINDER_OUTCOMES)[number];

export async function recordFact(subjectType: string, subjectKey: string, factType: string, value: unknown, basis: Basis, investigationId: string | null, sourceRef: string) {
  if (!subjectKey) return;
  await getD1().prepare("INSERT INTO memory_facts (id,subject_type,subject_key,fact_type,value,basis,investigation_id,source_ref) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(subject_type,subject_key,fact_type,source_ref) DO UPDATE SET value=excluded.value,basis=excluded.basis")
    .bind(crypto.randomUUID(), subjectType, subjectKey.slice(0, 400), factType, json(value), basis, investigationId, sourceRef.slice(0, 300)).run();
}

export async function recordOutcome(domain: string, outcome: FinderOutcome, basis: Exclude<Basis, "external_metadata">, investigationId: string | null, detail: unknown = {}, finderCandidateId?: string | null) {
  if (!domain) return false;
  const id = `${domain}|${outcome}|${investigationId ?? "-"}`;
  const r = await getD1().prepare("INSERT OR IGNORE INTO finder_outcomes (id,canonical_domain,finder_candidate_id,investigation_id,outcome,basis,detail) VALUES (?,?,?,?,?,?,?)")
    .bind(id, domain, finderCandidateId ?? domain, investigationId, outcome, basis, json(detail)).run();
  return (r.meta?.changes ?? 0) === 1;
}

/**
 * Derives outcomes and memory facts from the current digest. Idempotent: each
 * outcome is recorded once per candidate and investigation. `runStatus` is
 * only used for investigation_completed, which the completion gate (not the
 * model) decides.
 */
export async function syncFromDigest(d: Digest, runStatus?: string) {
  const inv = d.investigation.id;
  const domain = d.inbox?.domain ?? "";
  const siteKey = d.site?.domain ?? domain;
  const recorded: string[] = [];
  const out = async (o: FinderOutcome, basis: "observed" | "deterministic", detail: unknown) => { if (domain && await recordOutcome(domain, o, basis, inv, detail, d.inbox?.candidate_id)) recorded.push(o); };
  const siEvidence = d.evidence.by_module.site_investigator ?? 0;
  if (d.evidence.meaningful > 0) await out("meaningful_evidence", "observed", { count: d.evidence.meaningful, by_module: d.evidence.by_module });
  if (d.wallets.length > 0) await out("wallet_evidence", "observed", { wallets: d.wallets.length, sources: [...new Set(d.wallets.flatMap(w => w.sources))] });
  if (d.dead.dead) await out("dead_site", "observed", { reason: d.dead.reason, evidence: d.dead.evidence_ids });
  if (d.barriers.length) await out("auth_barrier", "observed", { kinds: d.barriers.map(b => b.kind), evidence: d.barriers.flatMap(b => b.evidence_ids).slice(0, 5) });
  const settled = !d.in_flight.length && !d.checkpoints.some(c => c.status === "open");
  if (settled && d.progress.site_investigated && !d.wallets.length && !d.barriers.length && !d.dead.dead) await out("low_evidence", "deterministic", { meaningful: d.evidence.meaningful });
  if (runStatus === "COMPLETE") await out("investigation_completed", "deterministic", { wallets_analyzed: d.progress.wallets_analyzed, meaningful: d.evidence.meaningful });

  if (siteKey && (siEvidence || d.dead.dead || d.barriers.length)) {
    await recordFact("site", siteKey, "evidence_yield", { meaningful: d.evidence.meaningful, wallets: d.wallets.length, barriers: d.barriers.map(b => b.kind), dead: d.dead.dead }, "observed", inv, `investigation:${inv}`);
  }
  for (const w of d.wallets) await recordFact("wallet", w.key, "wallet_observed", { site: siteKey, sources: w.sources, analyzed: w.analyzed }, "observed", inv, `investigation:${inv}`);
  for (const b of d.barriers) await recordFact("site", siteKey, "barrier", { kind: b.kind, evidence: b.evidence_ids }, "observed", inv, `investigation:${inv}:${b.kind}`);
  if (d.inbox?.cluster_key && (d.wallets.length || d.barriers.length || d.dead.dead)) {
    await recordFact("cluster", d.inbox.cluster_key, "member_outcome", { site: siteKey, wallets: d.wallets.length, barriers: d.barriers.map(b => b.kind), dead: d.dead.dead }, "observed", inv, `investigation:${inv}`);
  }
  for (const s of d.inbox?.strategies ?? []) if (d.wallets.length || d.dead.dead || d.barriers.length)
    await recordFact("strategy", s, "strategy_outcome", { site: siteKey, wallets: d.wallets.length, dead: d.dead.dead, barrier: d.barriers.length > 0 }, "observed", inv, `investigation:${inv}`);
  return recorded;
}

export async function searchMemory(subject: "site" | "wallet" | "cluster", value: string, excludeInvestigation: string) {
  const db = getD1();
  let investigations: Row[] = [];
  if (subject === "site" || subject === "wallet") {
    const type = subject === "site" ? "site" : "wallet";
    const rows = await db.prepare("SELECT DISTINCT i.id,i.title,i.status,(SELECT COUNT(*) FROM evidence ev WHERE ev.investigation_id=i.id) evidence_count,(SELECT state FROM investigation_state s WHERE s.investigation_id=i.id) state FROM entities e JOIN investigation_entities ie ON ie.entity_id=e.id JOIN investigations i ON i.id=ie.investigation_id WHERE e.entity_type=? AND e.canonical_key=? AND i.id<>? LIMIT 20")
      .bind(type, value, excludeInvestigation).all<Row>();
    investigations = rows.results;
  } else {
    const rows = await db.prepare("SELECT c.canonical_domain domain,c.decision,c.decision_reason,c.investigation_id id,(SELECT group_concat(outcome) FROM finder_outcomes f WHERE f.canonical_domain=c.canonical_domain) outcomes FROM inbox_candidates c WHERE c.cluster_key=? AND (c.investigation_id IS NULL OR c.investigation_id<>?) LIMIT 20")
      .bind(value, excludeInvestigation).all<Row>();
    investigations = rows.results.filter(r => r.decision || r.outcomes);
  }
  const facts = await db.prepare("SELECT subject_type,subject_key,fact_type,value,basis,investigation_id,created_at FROM memory_facts WHERE subject_type=? AND subject_key=? AND COALESCE(investigation_id,'')<>? ORDER BY created_at DESC LIMIT 30")
    .bind(subject, value, excludeInvestigation).all<Row>();
  return { subject, value, investigations, facts: facts.results.map(f => ({ ...f, value: (() => { try { return JSON.parse(String(f.value)); } catch { return {}; } })() })),
    note: "Memory holds observed outcomes, deterministic analysis and your decisions. It does not contain AI conclusions." };
}
