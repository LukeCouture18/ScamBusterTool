/**
 * The Reviewer: self-critique before any expensive or expansive action.
 *
 * Six deterministic questions, each answered from the database, never from a
 * model's say-so:
 *   1 evidence     What observed evidence supports this action?
 *   2 attempted    Has it (or its equivalent) already been attempted?
 *   3 yield        What could it realistically produce?
 *   4 cheaper      Is there a cheaper action that would tell us as much?
 *   5 wrong        Could the hypothesis be wrong (has this line of reasoning failed)?
 *   6 repetitive   Is this expansion becoming repetitive?
 * plus the authoritative budget check.
 *
 * Verdicts: approve | defer (keep queued, do cheaper work first) | reject (never
 * run this). A rejection is written to the opportunity and the executor refuses
 * any opportunity that does not carry an approving review for this tick. A model
 * critique, when enabled, may only ADD a rejection; it can never approve
 * something the deterministic Reviewer rejected.
 */
import { getD1 } from "../platform";
import { splitTarget } from "./hypotheses";

type Row = Record<string, unknown>;
export type Check = { question: "evidence" | "attempted" | "yield" | "cheaper" | "wrong" | "repetitive" | "budget"; pass: boolean; note: string; defer?: boolean };
export type Review = { opportunity_id: string; verdict: "approve" | "defer" | "reject"; checks: Check[]; reasons: string[] };
export const MIN_YIELD = 0.35, MAX_PIVOTS_PER_TYPE = 3, DISPROVED_BEFORE_DOUBT = 2;
function parse<T>(v: unknown, f: T): T { try { return typeof v === "string" ? JSON.parse(v) as T : (v as T) ?? f; } catch { return f; } }

export async function review(campaign: Row, op: Row, queue: Row[]): Promise<Review> {
  const db = getD1(); const cid = String(campaign.id);
  const f = parse<Record<string, number>>(op.factors, {});
  const checks: Check[] = [];
  const add = (question: Check["question"], pass: boolean, note: string, defer = false) => checks.push({ question, pass, note, ...(defer && !pass ? { defer: true } : {}) });

  if (op.kind === "investigate_candidate") {
    const c = await db.prepare("SELECT id,investigation_id,evidence_id,decision FROM inbox_candidates WHERE canonical_domain=?").bind(op.target_key).first<Row>();
    add("evidence", Boolean(c?.investigation_id && c?.evidence_id), c?.evidence_id ? "Site Finder's public observation is on record" : "no observed record for this site");
    const run = c?.investigation_id ? await db.prepare("SELECT id,status FROM agent_runs WHERE investigation_id=? ORDER BY started_at DESC LIMIT 1").bind(c.investigation_id).first<Row>() : null;
    const siJob = c?.investigation_id ? await db.prepare("SELECT id FROM jobs WHERE investigation_id=? AND job_type='INVESTIGATE_SITE' AND status IN ('pending','running','retrying','completed') LIMIT 1").bind(c.investigation_id).first<Row>() : null;
    add("attempted", !run && !siJob && c?.decision !== "skip", run ? `already investigated (run ${String(run.status).toLowerCase()})` : siJob ? "a site investigation already exists" : c?.decision === "skip" ? "a person skipped this site" : "not attempted before");
    add("yield", (f.info_gain ?? 0) >= MIN_YIELD && (f.dup_prob ?? 0) < 0.85, `expected information gain ${Number(f.info_gain ?? 0).toFixed(2)}, duplicate probability ${Number(f.dup_prob ?? 0).toFixed(2)}`);
    add("cheaper", true, "a site investigation is the cheapest way to observe this site");
    add("wrong", (f.accessibility ?? 1) > 0.2 || (f.relationship ?? 0) > 0.5, (f.accessibility ?? 1) > 0.2 ? "no barrier or dead-site outcome on record" : "a barrier or dead site was observed before");
    add("repetitive", (f.dup_prob ?? 0) < 0.85, (f.dup_prob ?? 0) < 0.85 ? "brings information not covered by other members" : "near-identical to a covered member");
    // v5: campaign work also draws on the platform-wide daily budgets, so every autonomous investigation is bounded globally.
    const { canSpend } = await import("../ops/budgets");
    const g = await canSpend("investigations", 1, ["module:site_investigator"]);
    add("budget", Number(campaign.used_investigations) < Number(campaign.max_investigations) && Number(campaign.used_module_jobs) < Number(campaign.max_module_jobs) && g.ok, `investigations ${campaign.used_investigations}/${campaign.max_investigations}, module jobs ${campaign.used_module_jobs}/${campaign.max_module_jobs}${g.ok ? "" : `; platform ${g.scope} daily investigations limit reached`}`, true);
  } else if (op.kind === "test_hypothesis") {
    const h = await db.prepare("SELECT * FROM hypotheses WHERE id=?").bind(op.hypothesis_id).first<Row>();
    const refs = parse<string[]>(h?.observation_refs, []);
    const live = refs.length ? Number((await db.prepare(`SELECT COUNT(*) n FROM campaign_edges WHERE campaign_id=? AND basis IN ('observed','deterministic') AND id IN (${refs.map(() => "?").join(",")})`).bind(cid, ...refs).first<{ n: number }>())?.n ?? 0) : 0;
    add("evidence", Boolean(h) && live === refs.length && live >= 2, h ? `${live}/${refs.length} cited observations exist with provenance` : "hypothesis missing");
    const { type } = splitTarget(String(op.target_key));
    const same = await db.prepare("SELECT COUNT(*) n FROM opportunities WHERE campaign_id=? AND kind='test_hypothesis' AND target_key=? AND status IN ('executing','done') AND id<>?").bind(cid, op.target_key, op.id).first<{ n: number }>();
    const jobDup = await db.prepare("SELECT id FROM jobs WHERE job_type='FIND_RELATED_SITES' AND instr(payload, ?) > 0 AND instr(payload, ?) > 0 AND status IN ('pending','running','retrying') LIMIT 1").bind(`"campaign_id":"${cid}"`, JSON.stringify(op.target_key)).first<Row>();
    add("attempted", !Number(same?.n) && !jobDup && h?.status === "proposed", Number(same?.n) || jobDup ? "this pivot was already run" : h?.status !== "proposed" ? `hypothesis is ${h?.status}` : "not attempted before");
    add("yield", (f.info_gain ?? 0) >= MIN_YIELD && !(f.saturation ?? 0), (f.saturation ?? 0) ? `${type} pivots are saturated` : `expected information gain ${Number(f.info_gain ?? 0).toFixed(2)}`);
    const cheaper = queue.find(o => o.kind === "investigate_candidate" && o.id !== op.id && Number(o.priority) >= Number(op.priority) - 0.02 && Number(o.cost) <= Number(op.cost) * 3 && !(f.relationship >= 0.6));
    add("cheaper", !cheaper, cheaper ? `investigating ${cheaper.target_key} first is as valuable and adds no discovery load` : "no cheaper action would answer this", true);
    const disproved = await db.prepare("SELECT COUNT(*) n FROM hypotheses WHERE campaign_id=? AND status='disproved' AND test_target LIKE ?").bind(cid, `${type}:%`).first<{ n: number }>();
    add("wrong", Number(disproved?.n ?? 0) < DISPROVED_BEFORE_DOUBT && Number(h?.confidence ?? 0) >= 0.3, `${Number(disproved?.n ?? 0)} ${type} hypotheses already disproved in this campaign; confidence ${Number(h?.confidence ?? 0).toFixed(2)}`);
    const ran = await db.prepare("SELECT COUNT(*) n FROM opportunities o JOIN hypotheses h ON h.id=o.hypothesis_id WHERE o.campaign_id=? AND o.kind='test_hypothesis' AND o.status IN ('executing','done') AND h.test_target LIKE ?").bind(cid, `${type}:%`).first<{ n: number }>();
    const inflight = await db.prepare("SELECT COUNT(*) n FROM opportunities o JOIN hypotheses h ON h.id=o.hypothesis_id WHERE o.campaign_id=? AND o.kind='test_hypothesis' AND o.status='executing' AND h.test_target LIKE ?").bind(cid, `${type}:%`).first<{ n: number }>();
    if (Number(ran?.n ?? 0) >= MAX_PIVOTS_PER_TYPE) add("repetitive", false, `${Number(ran?.n ?? 0)} ${type} pivot(s) already run (limit ${MAX_PIVOTS_PER_TYPE})`);
    // One in-flight pivot per indicator type: diminishing returns can only be seen once a result is back.
    else add("repetitive", !Number(inflight?.n ?? 0), Number(inflight?.n ?? 0) ? `waiting for the result of another ${type} pivot first` : `${Number(ran?.n ?? 0)} ${type} pivot(s) run so far`, true);
    const { canSpend } = await import("../ops/budgets");
    const g = await canSpend("discovery_requests", 1, ["module:site_finder"]);
    add("budget", Number(campaign.used_discovery_requests) < Number(campaign.max_discovery_requests) && g.ok, `discovery ${campaign.used_discovery_requests}/${campaign.max_discovery_requests}${g.ok ? "" : `; platform ${g.scope} daily discovery limit reached`}`, true);
  } else {
    add("evidence", false, `unknown opportunity kind ${String(op.kind)}`);
  }
  const failed = checks.filter(c => !c.pass);
  // Deferrable failures keep the work queued (do cheaper work first, wait for a similar
  // result, or wait for a person to raise the budget); any other failed question rejects.
  const verdict: Review["verdict"] = !failed.length ? "approve" : failed.every(c => c.defer) ? "defer" : "reject";
  return { opportunity_id: String(op.id), verdict, checks, reasons: failed.map(c => `${c.question}: ${c.note}`) };
}

/** A model critique may only add a rejection with one of these codes. */
export const MODEL_REJECTION_CODES = ["weak_evidence", "already_covered", "low_yield", "cheaper_alternative", "likely_wrong", "repetitive"] as const;
