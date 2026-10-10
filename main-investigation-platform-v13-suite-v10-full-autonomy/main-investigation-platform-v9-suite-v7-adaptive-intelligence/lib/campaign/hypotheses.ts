/**
 * Explicit, disprovable investigation hypotheses.
 *
 *   observation -> hypothesis -> proposed test -> result -> confidence change
 *
 * A hypothesis is REASONING, never evidence. It lives in its own table, never
 * becomes a graph edge, and its confidence moves only on the observed result of
 * its test (a Site Finder pivot whose returned candidates are re-checked against
 * the platform's own records) or on a person's decision. Nothing a model or a
 * later role "concludes" can raise it.
 *
 * Proposals — deterministic or from a model — go through one validator:
 * the observation must cite campaign edges that exist (observed or
 * deterministic basis), the test target must be an indicator those edges
 * actually point at, and the statement is plain text.
 */
import { z } from "zod";
import { getD1, json } from "../platform";
import { keyMatch, type GraphSummary } from "./graph";
import { assertExecutionAllowed } from "../ops/guard";

type Row = Record<string, unknown>;
export const PIVOT_TYPES = ["ip", "ns", "san", "favicon", "favtmpl", "service", "wallet", "kit"] as const;
export const SUPPORT_AT = 0.75, DISPROVE_AT = 0.2, SUPPORT_STEP = 0.25, DISPROVE_STEP = 0.35, HUMAN_CONTRADICTION_STEP = 0.2;

export const HYPOTHESIS_SCHEMA = z.object({
  observation_refs: z.array(z.string().min(1).max(64)).min(1).max(20),
  statement: z.string().min(8).max(300),
  test_target: z.string().min(3).max(420),
}).strict();

function parse<T>(v: unknown, f: T): T { try { return typeof v === "string" ? JSON.parse(v) as T : (v as T) ?? f; } catch { return f; } }
export function splitTarget(target: string): { type: string; value: string } {
  const i = target.indexOf(":"); return { type: target.slice(0, i), value: target.slice(i + 1) };
}
/** The node key an edge points at, in test-target form. */
function edgeTarget(e: Row) { return e.dst_type === "kit" ? `kit:${e.dst_key}` : e.dst_type === "wallet" ? `wallet:${e.dst_key}` : String(e.dst_key); }

/** Pure validation (reads only): used by proposeHypothesis and by v5 decision replay. */
export async function validateHypothesis(campaignId: string, raw: unknown) {
  const parsed = HYPOTHESIS_SCHEMA.safeParse(raw);
  if (!parsed.success) return { ok: false as const, reasons: parsed.error.issues.map(i => `${i.path.join(".") || "hypothesis"}: ${i.message}`) };
  const h = parsed.data, reasons: string[] = [];
  if (/https?:\/\/|www\.|<[a-z/]|\]\(/i.test(h.statement)) reasons.push("statement must be plain text (no links or markup)");
  const { type, value } = splitTarget(h.test_target);
  if (!(PIVOT_TYPES as readonly string[]).includes(type) || !value) reasons.push(`test_target type "${type}" is not a supported passive pivot`);
  const edges: Row[] = [];
  for (const ref of new Set(h.observation_refs)) {
    const e = await getD1().prepare("SELECT * FROM campaign_edges WHERE id=? AND campaign_id=?").bind(ref, campaignId).first<Row>();
    if (!e) reasons.push(`observation_ref ${ref} is not an edge in this campaign`);
    else if (!["observed", "deterministic"].includes(String(e.basis))) reasons.push(`observation_ref ${ref} has basis ${e.basis}`);
    else edges.push(e);
  }
  if (edges.length && !edges.every(e => edgeTarget(e) === h.test_target)) reasons.push("test_target is not the indicator the cited edges point at");
  if (edges.length && new Set(edges.map(e => String(e.src_key))).size < 2) reasons.push("a pattern needs at least two sites");
  if (reasons.length) return { ok: false as const, reasons };
  return { ok: true as const, h, edges, type };
}

export async function proposeHypothesis(campaignId: string, raw: unknown, proposedBy: "deterministic" | "model") {
  const v = await validateHypothesis(campaignId, raw);
  if (!v.ok) return v;
  const { h, edges, type } = v;
  assertExecutionAllowed("hypothesis.insert");
  const id = crypto.randomUUID();
  const observation = `${new Set(edges.map(e => String(e.src_key))).size} sites in this campaign share ${type === "kit" ? "a Site Finder kit/template cluster" : type === "wallet" ? "a displayed wallet" : `the ${type} indicator`} (${edges.length} observed link${edges.length === 1 ? "" : "s"}).`;
  const r = await getD1().prepare("INSERT OR IGNORE INTO hypotheses (id,campaign_id,observation,observation_refs,statement,test_kind,test_target,status,confidence,history,proposed_by) VALUES (?,?,?,?,?,'discovery_pivot',?,'proposed',0.5,?,?)")
    .bind(id, campaignId, observation, json(edges.map(e => e.id)), h.statement.replace(/\s+/g, " ").trim(), h.test_target, json([{ at: new Date().toISOString(), to: 0.5, reason: "proposed", basis: proposedBy }]), proposedBy).run();
  if ((r.meta?.changes ?? 0) !== 1) return { ok: false as const, reasons: ["a hypothesis with this test already exists in the campaign"], duplicate: true };
  return { ok: true as const, id };
}

/** Discovery Strategist, deterministic half: one hypothesis per repeated observable pattern. */
export async function deterministicHypotheses(campaignId: string, summary: GraphSummary) {
  const made: string[] = [];
  const phrase: Record<string, string> = { ip: "hosting IP", ns: "nameserver set", san: "certificate name pattern", favicon: "favicon", favtmpl: "page template", service: "chat/support service" };
  for (const r of summary.repeated_indicators) {
    const target = r.key; const { type } = splitTarget(target);
    const p = await proposeHypothesis(campaignId, { observation_refs: r.edge_ids.slice(0, 20), test_target: target, statement: `Other sites not yet in this campaign may share this ${phrase[type] ?? type}. A passive Site Finder pivot on it would find them if they exist.` }, "deterministic");
    if (p.ok) made.push(p.id);
  }
  for (const k of summary.kits.filter(k => k.sites.length >= 2)) {
    const p = await proposeHypothesis(campaignId, { observation_refs: k.edge_ids.slice(0, 20), test_target: `kit:${k.kit}`, statement: "More sites built from the same kit may exist beyond the ones already found. A passive template pivot would find them if they exist." }, "deterministic");
    if (p.ok) made.push(p.id);
  }
  for (const w of summary.recurring_wallets) {
    const p = await proposeHypothesis(campaignId, { observation_refs: w.edge_ids.slice(0, 20), test_target: `wallet:${w.wallet}`, statement: "Other public sites may display this same wallet. A passive pivot on the address would find them if they exist." }, "deterministic");
    if (p.ok) made.push(p.id);
  }
  return made;
}

async function move(h: Row, delta: number, reason: string, basis: string, extra: Row = {}) {
  const before = Number(h.confidence);
  const after = Math.max(0, Math.min(1, before + delta));
  const status = after >= SUPPORT_AT ? "supported" : after <= DISPROVE_AT ? "disproved" : extra.final ? "inconclusive" : String(h.status) === "proposed" ? "proposed" : String(h.status);
  const hist = parse<Row[]>(h.history, []); hist.push({ at: new Date().toISOString(), from: Number(before.toFixed(3)), to: Number(after.toFixed(3)), reason: reason.slice(0, 200), basis, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "final")) });
  await getD1().prepare("UPDATE hypotheses SET confidence=?,status=?,history=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(after, status, json(hist.slice(-30)), h.id).run();
  return { from: before, to: after, status };
}

/**
 * Analyst: evaluates a finished pivot against OBSERVED data. The module's own
 * claim of "new candidates" is not trusted: each claimed domain must now exist
 * in the inbox and must actually carry the indicator that was pivoted on.
 */
export async function evaluatePivot(hypothesisId: string, job: Row, knownBefore: Set<string>) {
  const db = getD1();
  const h = await db.prepare("SELECT * FROM hypotheses WHERE id=?").bind(hypothesisId).first<Row>();
  if (!h || !["testing", "proposed"].includes(String(h.status))) return null;
  if (job.status !== "completed") {
    const hist = parse<Row[]>(h.history, []); hist.push({ at: new Date().toISOString(), reason: `test did not complete (${job.status}); no confidence change`, basis: "deterministic", job_id: job.id });
    await db.prepare("UPDATE hypotheses SET status='proposed',history=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(json(hist), h.id).run();
    return { verified: [], claimed: 0, status: "proposed", saturated: false };
  }
  const result = parse<Row>(job.result, {});
  const claimed = (Array.isArray(result.new_candidates) ? result.new_candidates as unknown[] : []).map(d => String(d).toLowerCase()).slice(0, 100);
  const { type, value } = splitTarget(String(h.test_target));
  const verified: string[] = [];
  for (const domain of claimed) {
    if (knownBefore.has(domain)) continue;
    const c = type === "kit"
      ? await db.prepare("SELECT canonical_domain FROM inbox_candidates WHERE canonical_domain=? AND cluster_key=?").bind(domain, value).first<Row>()
      : await (async () => { const [where, needle] = keyMatch(type, value); return db.prepare(`SELECT canonical_domain FROM inbox_candidates WHERE canonical_domain=? AND ${where}`).bind(domain, needle).first<Row>(); })();
    if (c) verified.push(domain);
  }
  const unverified = claimed.filter(d => !verified.includes(d) && !knownBefore.has(d));
  const out = verified.length
    ? await move(h, SUPPORT_STEP * Math.min(verified.length, 3), `pivot found ${verified.length} new site(s) that observably share the indicator`, "observed", { job_id: job.id, verified, unverified: unverified.slice(0, 10) })
    : await move(h, -DISPROVE_STEP, unverified.length ? `pivot returned ${unverified.length} site(s) but none observably share the indicator` : "pivot found no new site sharing the indicator", "observed", { job_id: job.id, unverified: unverified.slice(0, 10) });
  return { verified, claimed: claimed.length, status: out.status, saturated: Boolean(result.saturated) };
}

/**
 * Later contradicting evidence: when a person skips sites that a supported
 * hypothesis's test produced (not a scam, dead, not crypto), confidence drops.
 * A hypothesis is never protected by having been "supported" once.
 */
export async function applyHumanContradictions(campaignId: string) {
  const db = getD1(); let changed = 0;
  const hyps = (await db.prepare("SELECT * FROM hypotheses WHERE campaign_id=? AND status IN ('supported','proposed','testing','inconclusive')").bind(campaignId).all<Row>()).results;
  for (const h of hyps) {
    const hist = parse<Row[]>(h.history, []);
    const produced = new Set(hist.flatMap(e => Array.isArray(e.verified) ? (e.verified as string[]) : []));
    const counted = new Set(hist.flatMap(e => Array.isArray(e.contradicted_by) ? (e.contradicted_by as string[]) : []));
    for (const domain of produced) {
      if (counted.has(domain)) continue;
      const d = await db.prepare("SELECT id,decision,decision_reason FROM inbox_candidates WHERE canonical_domain=? AND decision='skip'").bind(domain).first<Row>();
      if (!d) continue;
      const decision = await db.prepare("SELECT id FROM inbox_decisions WHERE candidate_id=? ORDER BY seq DESC LIMIT 1").bind(d.id).first<Row>();
      const fresh = await db.prepare("SELECT * FROM hypotheses WHERE id=?").bind(h.id).first<Row>();
      await move(fresh!, -HUMAN_CONTRADICTION_STEP, `you skipped ${domain} (${d.decision_reason ?? "no reason"}), which this hypothesis's test produced`, "human", { contradicted_by: [domain], decision_id: decision?.id ?? null, final: true });
      changed++;
    }
  }
  return changed;
}
