/**
 * Deterministic contradiction detection. A contradiction is never resolved by
 * silently picking a side: it is recorded, a review work item is created (which
 * appears as a human task), and an important one notifies.
 *
 *   providers_disagree              two sources report different values for the same facet at the same time
 *   observations_conflict           a module says a site is dead while another fresh observation says live
 *   ai_contradicts_evidence         a supported hypothesis whose produced sites a person rejected, or an AI
 *                                   inference whose cited evidence has since changed
 *   known_fact_changed              a fact changed after a report was prepared
 *   equivalent_records_incompatible two records treated as the same thing disagree (a wallet recorded on
 *                                   two different networks)
 */
import { getD1 } from "../platform";
import { proposeWork } from "./workitems";
import { hash, parse, type Row } from "./common";

export type ContradictionInput = { kind: string; subjectType: string; subjectKey: string; aRef: string; bRef: string; aValue?: string | null; bValue?: string | null; detail: string; importance?: number };

export async function recordContradiction(c: ContradictionInput) {
  const db = getD1();
  const fp = await hash([c.kind, c.subjectType, c.subjectKey, [c.aRef, c.bRef].sort().join("|")].join("::"));
  const existing = await db.prepare("SELECT id,status FROM contradictions WHERE fingerprint=?").bind(fp).first<Row>();
  if (existing) return { id: String(existing.id), created: false };
  const id = crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO contradictions (id,kind,subject_type,subject_key,a_ref,b_ref,a_value,b_value,detail,importance,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, c.kind, c.subjectType, c.subjectKey, c.aRef, c.bRef, c.aValue ?? null, c.bValue ?? null, c.detail.slice(0, 400), c.importance ?? 0.5, fp).run();
  const w = await proposeWork({ kind: "review_contradiction", targetType: "contradiction", targetKey: id, source: "contradiction", reason: c.detail.slice(0, 380),
    factors: { info_gain: c.importance ?? 0.5, evidence_strength: 0.6, freshness: 1, cost: 0.1 } });
  await db.prepare("UPDATE contradictions SET work_item_id=? WHERE id=?").bind(w.id, id).run();
  if ((c.importance ?? 0.5) >= 0.7) {
    const { notify } = await import("./notifications");
    await notify({ kind: "contradiction", severity: "warning", title: `Contradiction: ${c.subjectKey}`, body: c.detail, link: "/tasks", dedupeKey: `contradiction:${c.subjectType}:${c.subjectKey}:${c.kind}` });
  }
  return { id, created: true };
}

/** Periodic detectors over existing rows (the temporal layer catches disagreements as they arrive). */
export async function detectContradictions() {
  const db = getD1(); let found = 0;
  // Observations conflict: a failed/dead Site Investigator result while Finder observed the site live afterwards-or-at-once.
  // Same simultaneity window as temporal intelligence (lib/ops/temporal.ts); 0 disables it.
  const { getNum } = await import("./common");
  const windowS = await getNum("disagreement_window_seconds", 3600);
  for (const r of windowS <= 0 ? [] : (await db.prepare("SELECT f.subject_key,f.value,f.source_table,f.source_ref,f.last_seen_at,s.value sv,s.source_ref sref,s.observed_at FROM entity_facets f JOIN entity_snapshots s ON s.subject_type=f.subject_type AND s.subject_key=f.subject_key AND s.facet=f.facet AND s.value_hash<>f.value_hash WHERE f.facet='status' AND f.subject_type='domain' AND ABS(julianday(f.last_seen_at)-julianday(s.observed_at))*86400<? AND s.source_table<>f.source_table LIMIT 50").bind(windowS).all<Row>()).results) {
    const c = await recordContradiction({ kind: "observations_conflict", subjectType: "domain", subjectKey: String(r.subject_key), aRef: `${r.source_table}:${r.source_ref}`, bRef: `snapshot:${r.sref}`,
      aValue: String(r.value), bValue: String(r.sv), detail: `${r.subject_key} was observed both ${parse(r.value, "")} and ${parse(r.sv, "")} by different sources at nearly the same time`, importance: 0.6 });
    if (c.created) found++;
  }
  // AI reasoning contradicted by people: a supported hypothesis whose produced sites were skipped as not scams.
  for (const h of (await db.prepare("SELECT id,campaign_id,statement,history FROM hypotheses WHERE status IN ('supported','inconclusive')").all<Row>()).results) {
    const hist = parse<Row[]>(h.history, []);
    const produced = hist.flatMap(e => Array.isArray(e.verified) ? e.verified as string[] : []);
    for (const d of produced) {
      const skip = await db.prepare("SELECT id FROM inbox_candidates WHERE canonical_domain=? AND decision='skip' AND decision_reason IN ('not_a_scam','not_crypto')").bind(d).first<Row>();
      if (!skip) continue;
      const c = await recordContradiction({ kind: "ai_contradicts_evidence", subjectType: "hypothesis", subjectKey: String(h.id), aRef: `hypotheses:${h.id}`, bRef: `inbox_candidates:${skip.id}`,
        detail: `Hypothesis "${String(h.statement).slice(0, 90)}" is supported by ${d}, which a person marked not a scam`, importance: 0.7 });
      if (c.created) found++;
    }
  }
  // AI inference whose cited evidence has changed since (a newer version exists).
  for (const r of (await db.prepare("SELECT i.id,i.claim,i.cited_evidence,i.investigation_id FROM agent_inferences i WHERE i.status='unverified' LIMIT 100").all<Row>()).results) {
    for (const ev of parse<string[]>(r.cited_evidence, [])) {
      const versions = Number((await db.prepare("SELECT COUNT(*) n FROM evidence_versions WHERE evidence_id=?").bind(ev).first<Row>())?.n ?? 0);
      if (versions < 2) continue;
      const c = await recordContradiction({ kind: "ai_contradicts_evidence", subjectType: "inference", subjectKey: String(r.id), aRef: `agent_inferences:${r.id}`, bRef: `evidence:${ev}`,
        detail: `An AI inference ("${String(r.claim).slice(0, 80)}") cites evidence that has since changed`, importance: 0.5 });
      if (c.created) found++;
    }
  }
  // Equivalent records with incompatible properties: one wallet address recorded on different networks.
  const byAddr = new Map<string, Array<{ id: string; net: string }>>();
  for (const r of (await db.prepare("SELECT id,canonical_key,canonical_data FROM entities WHERE entity_type='wallet' ORDER BY rowid DESC LIMIT 2000").all<Row>()).results) {
    const net = String(parse<Row>(r.canonical_data, {}).network ?? "").toLowerCase();
    if (!net) continue;
    const addr = String(r.canonical_key).replace(/^[a-z0-9_]+:(?=\w{20,})/i, "").toLowerCase();
    (byAddr.get(addr) ?? byAddr.set(addr, []).get(addr)!).push({ id: String(r.id), net });
  }
  for (const [addr, recs] of byAddr) {
    const nets = [...new Set(recs.map(x => x.net))];
    if (nets.length < 2) continue;
    const a = recs.find(x => x.net === nets[0])!, b = recs.find(x => x.net === nets[1])!;
    const c = await recordContradiction({ kind: "equivalent_records_incompatible", subjectType: "wallet", subjectKey: addr, aRef: `entities:${a.id}`, bRef: `entities:${b.id}`,
      aValue: a.net, bValue: b.net, detail: `Wallet ${addr.slice(0, 24)}… is recorded on different networks (${nets.join(", ")})`, importance: 0.6 });
    if (c.created) found++;
  }
  return found;
}

/** A person resolves (picks what is right, with a note) or dismisses a contradiction. */
export async function resolveContradiction(id: string, resolution: "resolved" | "dismissed", note: string) {
  const db = getD1();
  const c = await db.prepare("SELECT * FROM contradictions WHERE id=?").bind(id).first<Row>();
  if (!c) throw new Error("CONTRADICTION_NOT_FOUND");
  if (c.status !== "open") return { already: String(c.status) };
  await db.prepare("UPDATE contradictions SET status=?,resolution=?,resolved_at=CURRENT_TIMESTAMP WHERE id=?").bind(resolution, note.slice(0, 400), id).run();
  if (c.work_item_id) {
    const { markWork } = await import("./workitems");
    await markWork(String(c.work_item_id), "done", { result: { resolution, note: note.slice(0, 200), by: "analyst" } });
  }
  return { ok: true };
}
