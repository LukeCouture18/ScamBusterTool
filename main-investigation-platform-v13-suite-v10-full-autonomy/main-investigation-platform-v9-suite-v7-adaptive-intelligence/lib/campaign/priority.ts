/**
 * The deterministic priority engine.
 *
 * Every piece of safe work the campaign could do next is an opportunity row
 * with a priority computed from named, inspectable factors:
 *
 *   information gain   what it could newly tell us (new wallets, new shared nodes)
 *   evidence strength  how strongly observed data supports doing it
 *   novelty            how much of it is not already covered by other work
 *   relationship       how connected it is to the rest of the campaign graph
 *   duplicate prob.    how likely it repeats work already done or selected
 *   experience         what similar work actually produced before (learned prior)
 *   accessibility      dead sites / sign-in walls observed before
 *   cost               expected module jobs / discovery requests
 *   budget             whether the campaign can afford it at all
 *
 * The engine re-scores the whole queue every campaign tick, so a finished
 * investigation, a person's decision, or a new module observation changes the
 * order of everything still pending. Near-identical candidates collapse to one
 * representative: one highly connected site outranks twenty mirrors of a kit
 * that has already been looked at, and the mirrors are suppressed with a reason.
 */
import { getD1, json } from "../platform";
import { candidateKeys, type GraphSummary } from "./graph";
import { prior } from "./experience";
import { splitTarget } from "./hypotheses";
import { MIN_YIELD } from "./reviewer";

type Row = Record<string, unknown>;
export const W = { info_gain: 0.25, evidence_strength: 0.12, novelty: 0.15, relationship: 0.2, proven_link: 0.3, experience: 0.13, accessibility: 0.1, cost: 0.1, duplicate: 0.6 };
export const SUPPRESS_DUP = 0.85;
export const SATURATION_WINDOW = 2;            // this many unproductive pivots of a type in a row saturates that type
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
function parse<T>(v: unknown, f: T): T { try { return typeof v === "string" ? JSON.parse(v) as T : (v as T) ?? f; } catch { return f; } }

export type Factors = { info_gain: number; evidence_strength: number; novelty: number; relationship: number; proven_link?: number; dup_prob: number; experience: number; accessibility: number; cost: number; budget_ok: 0 | 1; saturation?: number };
export function combine(f: Factors) {
  const raw = W.info_gain * f.info_gain + W.evidence_strength * f.evidence_strength + W.novelty * f.novelty + W.relationship * f.relationship + W.proven_link * (f.proven_link ?? 0) + W.experience * f.experience + W.accessibility * f.accessibility - W.cost * f.cost - W.duplicate * f.dup_prob - 0.5 * (f.saturation ?? 0);
  return r3(f.budget_ok ? raw : raw - 1);
}

export function contextFor(kind: string, parts: Record<string, string | number | boolean>) {
  return Object.entries(parts).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${typeof v === "boolean" ? (v ? 1 : 0) : v}`).join("|") || kind;
}

async function upsertOpportunity(campaignId: string, o: { kind: string; targetType: string; targetKey: string; fingerprint: string; priority: number; factors: Factors; cost: number; reason: string; status?: string; hypothesisId?: string | null; investigationId?: string | null }) {
  const db = getD1();
  const existing = await db.prepare("SELECT id,status,result FROM opportunities WHERE campaign_id=? AND fingerprint=?").bind(campaignId, o.fingerprint).first<Row>();
  if (!existing) {
    await db.prepare("INSERT INTO opportunities (id,campaign_id,kind,target_type,target_key,fingerprint,status,priority,factors,cost,reason,hypothesis_id,investigation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), campaignId, o.kind, o.targetType, o.targetKey.slice(0, 400), o.fingerprint, o.status ?? "open", o.priority, json(o.factors), o.cost, o.reason.slice(0, 400), o.hypothesisId ?? null, o.investigationId ?? null).run();
    return;
  }
  // Only queued work is re-scored; executing/done rows keep the score they were chosen with. Work the
  // Reviewer rejected only for low expected yield is re-opened when new information raises its yield.
  let reopen = false;
  if (existing.status === "rejected") {
    const failed = (parse<Row>(existing.result, {}).review as Row | undefined)?.checks as Array<Row> | undefined;
    const onlyYield = Array.isArray(failed) && failed.filter(c => !c.pass).every(c => c.question === "yield");
    reopen = onlyYield && o.factors.info_gain >= MIN_YIELD && o.factors.dup_prob < SUPPRESS_DUP && !(o.factors.saturation ?? 0) && (o.status ?? "open") === "open";
    if (!reopen) return;
  }
  if (!reopen && !["open", "suppressed", "saturated", "blocked"].includes(String(existing.status))) return;
  await db.prepare("UPDATE opportunities SET priority=?,factors=?,cost=?,reason=?,status=?,investigation_id=COALESCE(?,investigation_id),updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(o.priority, json(o.factors), o.cost, o.reason.slice(0, 400), o.status ?? "open", o.investigationId ?? null, existing.id).run();
}

/** Re-scores the whole queue. Returns the open opportunities, best first. */
export async function prioritize(campaign: Row, summary: GraphSummary, edges: Row[]) {
  const db = getD1(); const cid = String(campaign.id);
  const members = (await db.prepare("SELECT m.*,c.score,c.details,c.wallets,c.cluster_key,c.decision,c.investigation_id cand_inv FROM campaign_members m LEFT JOIN inbox_candidates c ON c.canonical_domain=m.domain WHERE m.campaign_id=?").bind(cid).all<Row>()).results;
  const budgetInv = Number(campaign.used_investigations) < Number(campaign.max_investigations);
  const budgetDisc = Number(campaign.used_discovery_requests) < Number(campaign.max_discovery_requests);

  // Shared nodes: graph nodes linked to two or more sites. These are what make a site informative about the campaign.
  const nodeSites = new Map<string, Set<string>>(), siteNodes = new Map<string, Set<string>>();
  for (const e of edges) if (e.src_type === "site" && e.dst_type !== "investigation") {
    const node = `${e.dst_type}|${e.dst_key}`; const site = String(e.src_key);
    (nodeSites.get(node) ?? nodeSites.set(node, new Set()).get(node)!).add(site);
    (siteNodes.get(site) ?? siteNodes.set(site, new Set()).get(site)!).add(node);
  }
  const shared = (site: string) => [...(siteNodes.get(site) ?? [])].filter(n => (nodeSites.get(n)?.size ?? 0) >= 2);
  const maxDegree = Math.max(1, ...members.map(m => shared(String(m.domain)).reduce((s, n) => s + (nodeSites.get(n)!.size - 1), 0)));

  // Coverage: what investigated (or in-progress) members already tell us.
  const covered = new Set<string>();
  for (const m of members) if (["investigating", "waiting_human", "done"].includes(String(m.state))) for (const n of siteNodes.get(String(m.domain)) ?? []) covered.add(n);
  // Previous results: sites whose investigation found real evidence (observed), or that a person marked useful.
  const provenSites = new Set<string>([
    ...(await db.prepare("SELECT target_key FROM opportunities WHERE campaign_id=? AND kind='investigate_candidate' AND status='done' AND CAST(json_extract(result,'$.useful') AS REAL)>=0.5").bind(cid).all<{ target_key: string }>()).results.map(r => r.target_key),
    ...(await db.prepare("SELECT m.domain FROM campaign_members m JOIN inbox_candidates c ON c.canonical_domain=m.domain WHERE m.campaign_id=? AND c.decision='useful'").bind(cid).all<{ domain: string }>()).results.map(r => r.domain),
  ]);
  const provenLink = (site: string) => {
    let best = 0;
    for (const n of siteNodes.get(site) ?? []) for (const other of nodeSites.get(n) ?? []) if (other !== site && provenSites.has(other)) best = Math.max(best, n.startsWith("wallet|") ? 1 : 0.5);
    return best;
  };
  const bad = new Set((await db.prepare("SELECT canonical_domain FROM finder_outcomes WHERE outcome IN ('dead_site','auth_barrier')").all<{ canonical_domain: string }>()).results.map(r => r.canonical_domain));

  // Preliminary scores (without duplicate probability) to pick representatives deterministically.
  type Pre = { m: Row; domain: string; f: Factors; newNodes: string[]; groups: string[] };
  const pre: Pre[] = [];
  for (const m of members.filter(m => m.state === "pending")) {
    const domain = String(m.domain);
    const nodes = [...(siteNodes.get(domain) ?? [])];
    const sharedNodes = shared(domain);
    const newNodes = nodes.filter(n => !covered.has(n) && (nodeSites.get(n)?.size ?? 0) >= 2 || (n.startsWith("wallet|") && !covered.has(n)));
    const wallets = candidateKeys(m.details, m.wallets).filter(([t]) => t === "wallet").length;
    const degree = sharedNodes.reduce((s, n) => s + (nodeSites.get(n)!.size - 1), 0);
    const groups = nodes.filter(n => n.startsWith("kit|") || n.startsWith("indicator|favtmpl:"));
    const ctx = contextFor("investigate", { kit: groups.length > 0, wallet: wallets > 0, hub: degree >= 3 });
    const exp = await prior("investigate_candidate", ctx, cid);
    const f: Factors = {
      // A site tied to a confirmed one usually shows its own deposit wallet: that link is itself expected information.
      info_gain: clamp(0.3 + 0.15 * newNodes.length + (wallets ? 0.2 : 0) + 0.15 * provenLink(domain)),
      evidence_strength: clamp(Number(m.score ?? 0.5)),
      novelty: nodes.length ? clamp(nodes.filter(n => !covered.has(n)).length / nodes.length) : 1,
      relationship: clamp(degree / maxDegree),
      proven_link: provenLink(domain),
      dup_prob: 0,
      experience: exp.value,
      accessibility: bad.has(domain) ? 0.2 : 1,
      cost: 0.3,
      budget_ok: budgetInv && m.cand_inv ? 1 : 0,
    };
    pre.push({ m, domain, f, newNodes, groups });
  }
  pre.sort((a, b) => combine(b.f) - combine(a.f) || a.domain.localeCompare(b.domain));
  const tentative = new Set(covered);
  for (const p of pre) {
    const groupCovered = p.groups.some(g => tentative.has(g));
    const brings = p.newNodes.filter(n => !tentative.has(n));
    if (groupCovered && brings.length === 0) {
      p.f.dup_prob = 0.9;
    } else {
      p.f.dup_prob = groupCovered ? 0.3 : 0.05;
      for (const n of siteNodes.get(p.domain) ?? []) tentative.add(n);
    }
  }
  for (const p of pre) {
    const priority = combine(p.f);
    const suppressed = p.f.dup_prob >= SUPPRESS_DUP;
    // Name the representative: a covered member first, else the pending one chosen to stand for the group.
    const rep = suppressed ? members.find(o => o.domain !== p.domain && ["investigating", "waiting_human", "done"].includes(String(o.state)) && [...(siteNodes.get(String(o.domain)) ?? [])].some(n => p.groups.includes(n)))?.domain
      ?? pre.find(o => o !== p && o.groups.some(g => p.groups.includes(g)) && o.f.dup_prob < SUPPRESS_DUP)?.domain : undefined;
    const reason = suppressed ? `Near-identical to ${rep ?? "a site already covered"}: same kit, no new wallet or shared infrastructure.`
      : !p.m.cand_inv ? "No investigation record yet for this candidate."
      : `Investigate ${p.domain}: ${explain(p.f)}.`;
    await upsertOpportunity(cid, { kind: "investigate_candidate", targetType: "site", targetKey: p.domain, fingerprint: `investigate:${p.domain}`, priority, factors: p.f, cost: 3, reason,
      status: suppressed ? "suppressed" : p.m.cand_inv ? "open" : "blocked", investigationId: p.m.cand_inv ? String(p.m.cand_inv) : null });
  }

  // Hypothesis tests (bounded passive discovery pivots).
  const hyps = (await db.prepare("SELECT * FROM hypotheses WHERE campaign_id=? AND status='proposed'").bind(cid).all<Row>()).results;
  const history = (await db.prepare("SELECT h.test_target,o.result,o.updated_at FROM opportunities o JOIN hypotheses h ON h.id=o.hypothesis_id WHERE o.campaign_id=? AND o.kind='test_hypothesis' AND o.status='done' ORDER BY o.updated_at").bind(cid).all<Row>()).results;
  const byType = new Map<string, number[]>();
  for (const r of history) { const t = splitTarget(String(r.test_target)).type; (byType.get(t) ?? byType.set(t, []).get(t)!).push(Number(parse<Row>(r.result, {}).verified_count ?? 0)); }
  for (const h of hyps) {
    const { type } = splitTarget(String(h.test_target));
    const refs = parse<string[]>(h.observation_refs, []);
    const sites = new Set(edges.filter(e => refs.includes(String(e.id))).map(e => String(e.src_key)));
    const recent = (byType.get(type) ?? []).slice(-SATURATION_WINDOW);
    const saturated = recent.length >= SATURATION_WINDOW && recent.every(n => n === 0) ? 1 : 0;
    const hub = summary.unexplored_hubs.find(x => x.key === h.test_target);
    const ctx = contextFor("pivot", { type, hot: summary.convergence.length > 0 || summary.recurring_wallets.length > 0, big: sites.size >= 3 });
    const exp = await prior(`pivot:${type}`, ctx, cid);
    const f: Factors = {
      info_gain: clamp(0.35 + 0.1 * Math.min(sites.size, 5)),
      evidence_strength: clamp(0.4 + 0.15 * Math.min(refs.length, 4)),
      novelty: hub ? 1 : 0.4,
      relationship: clamp((hub?.degree ?? sites.size) / Math.max(2, members.length)),
      dup_prob: 0,
      experience: exp.value,
      accessibility: 1,
      cost: 0.35,
      budget_ok: budgetDisc ? 1 : 0,
      saturation: saturated,
    };
    const priority = combine(f);
    await upsertOpportunity(cid, { kind: "test_hypothesis", targetType: "pivot", targetKey: String(h.test_target), fingerprint: `hypothesis:${h.id}`, priority, factors: f, cost: 1,
      reason: saturated ? `The last ${SATURATION_WINDOW} ${type} pivots found nothing new; this path is saturated.` : `Test: ${String(h.statement).slice(0, 160)} (${explain(f)}).`,
      status: saturated ? "saturated" : "open", hypothesisId: String(h.id) });
  }
  return (await db.prepare("SELECT * FROM opportunities WHERE campaign_id=? AND status='open' ORDER BY priority DESC, created_at ASC, id ASC").bind(cid).all<Row>()).results;
}

/** A short, deterministic, human-readable why: the two strongest positive factors. */
export function explain(f: Factors) {
  const named: Array<[string, number]> = [
    [f.proven_link === 1 ? "it shows a wallet seen on a site already confirmed" : "it shares infrastructure with a site already confirmed", W.proven_link * (f.proven_link ?? 0)],
    ["it is connected to many other campaign sites", W.relationship * f.relationship],
    ["it could reveal new wallets or infrastructure", W.info_gain * f.info_gain],
    ["little of it is covered by work already done", W.novelty * f.novelty],
    ["similar work was useful before", W.experience * (f.experience - 0.5) * 2],
    ["strong public signals", W.evidence_strength * f.evidence_strength],
  ];
  return named.sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s]) => s).join(" and ");
}
