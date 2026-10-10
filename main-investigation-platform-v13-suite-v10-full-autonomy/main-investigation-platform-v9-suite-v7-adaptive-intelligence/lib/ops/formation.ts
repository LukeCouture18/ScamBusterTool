/**
 * Automatic campaign formation, merge, split, inactivity and reopening.
 *
 * Grouping is decided by the global intelligence graph, never by intuition:
 * two domains are *supported* as related when they share a wallet, a Site
 * Finder kit, or at least two different kinds of non-generic infrastructure
 * (hosting IP, name servers, certificate names, template, favicon, chat
 * service). A campaign is proposed for a connected group of at least
 * MIN_FORMATION supported domains that no active campaign covers. An AI may
 * propose a grouping too, but it must cite existing graph edges that connect
 * every domain it names (`validateGrouping`); otherwise the proposal is refused.
 *
 * Merges and splits keep history: members and edges are copied with their
 * original provenance, the old campaign keeps its rows and gets a lineage
 * entry, and nothing is deleted.
 */
import { getD1 } from "../platform";
import { assertExecutionAllowed } from "./guard";
import { proposeWork } from "./workitems";
import { getBool, json, parse, type Row } from "./common";

export const MIN_FORMATION = 3;
const STRONG_SINGLE = new Set(["wallet", "template:kit"]);          // one shared wallet or kit suffices
const INFRA_TYPES = new Set(["ip", "nameserver", "certificate", "template", "favicon", "identifier"]);

type Support = { a: string; b: string; kinds: string[]; edgeIds: string[] };

/** Pairs of domains supported by shared, active, non-generic graph nodes. */
async function supportedPairs(domains?: Set<string>) {
  const db = getD1();
  const rows = (await db.prepare(`SELECT e.id,d.node_key domain,n.id nid,n.node_type,n.node_key FROM intel_edges e JOIN intel_nodes d ON d.id=e.src_node AND d.node_type='domain'
    JOIN intel_nodes n ON n.id=e.dst_node WHERE e.active=1 AND n.generic=0 AND n.node_type IN ('wallet','ip','nameserver','certificate','template','favicon','identifier') AND e.basis IN ('observed','deterministic')`).all<Row>()).results;
  const byNode = new Map<string, Row[]>();
  for (const r of rows) { if (domains && !domains.has(String(r.domain))) continue; (byNode.get(String(r.nid)) ?? byNode.set(String(r.nid), []).get(String(r.nid))!).push(r); }
  const pairs = new Map<string, Support>();
  for (const list of byNode.values()) {
    const uniq = [...new Map(list.map(r => [String(r.domain), r])).values()];
    if (uniq.length < 2 || uniq.length > 40) continue;
    for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
      const [a, b] = [String(uniq[i].domain), String(uniq[j].domain)].sort();
      const k = `${a}|${b}`;
      const p = pairs.get(k) ?? { a, b, kinds: [], edgeIds: [] };
      const kind = uniq[i].node_type === "template" && String(uniq[i].node_key).startsWith("kit:") ? "template:kit" : String(uniq[i].node_type);
      if (!p.kinds.includes(kind)) p.kinds.push(kind);
      p.edgeIds.push(String(uniq[i].id), String(uniq[j].id));
      pairs.set(k, p);
    }
  }
  return [...pairs.values()].filter(p => p.kinds.some(k => STRONG_SINGLE.has(k)) || p.kinds.filter(k => INFRA_TYPES.has(k.split(":")[0])).length >= 2);
}

function components(pairs: Support[]) {
  const adj = new Map<string, Set<string>>();
  for (const p of pairs) { (adj.get(p.a) ?? adj.set(p.a, new Set()).get(p.a)!).add(p.b); (adj.get(p.b) ?? adj.set(p.b, new Set()).get(p.b)!).add(p.a); }
  const seen = new Set<string>(), out: string[][] = [];
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    const comp: string[] = [], stack = [s]; seen.add(s);
    while (stack.length) { const x = stack.pop()!; comp.push(x); for (const y of adj.get(x) ?? []) if (!seen.has(y)) { seen.add(y); stack.push(y); } }
    out.push(comp.sort());
  }
  return out;
}

/** Proposes campaigns for supported groups no active campaign covers. */
export async function proposeFormations() {
  if (!(await getBool("auto_form_campaigns", true))) return [];
  const db = getD1();
  // Sites already in a campaign (running, finished or dormant) are covered: a finished campaign
  // reopens on change rather than being formed again.
  const covered = new Set((await db.prepare("SELECT m.domain FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE c.status NOT IN ('STOPPED','MERGED') AND m.state<>'suppressed'").all<Row>()).results.map(r => String(r.domain)));
  const skipped = new Set((await db.prepare("SELECT canonical_domain FROM inbox_candidates WHERE decision='skip'").all<Row>()).results.map(r => String(r.canonical_domain)));
  const pairs = (await supportedPairs()).filter(p => !skipped.has(p.a) && !skipped.has(p.b));
  const out: string[] = [];
  for (const comp of components(pairs)) {
    const fresh = comp.filter(d => !covered.has(d));
    if (fresh.length < MIN_FORMATION) continue;
    const scores = (await db.prepare(`SELECT canonical_domain,score FROM inbox_candidates WHERE canonical_domain IN (${fresh.map(() => "?").join(",")})`).bind(...fresh).all<Row>()).results;
    if (!scores.length) continue;
    const seed = scores.sort((x, y) => Number(y.score) - Number(x.score) || String(x.canonical_domain).localeCompare(String(y.canonical_domain)))[0];
    const refs = [...new Set(pairs.filter(p => fresh.includes(p.a) && fresh.includes(p.b)).flatMap(p => p.edgeIds))].slice(0, 60);
    const kinds = [...new Set(pairs.filter(p => fresh.includes(p.a) && fresh.includes(p.b)).flatMap(p => p.kinds))];
    const w = await proposeWork({ kind: "form_campaign", targetType: "domain", targetKey: String(seed.canonical_domain), fingerprint: `form_campaign:${fresh.slice(0, 3).join(",")}`, source: "formation",
      reason: `${fresh.length} sites are linked by shared ${kinds.map(k => k.replace("template:kit", "kit")).join(", ")}: investigate them together`,
      factors: { info_gain: Math.min(1, 0.4 + 0.08 * fresh.length), novelty: 0.7, evidence_strength: Math.max(...scores.map(s => Number(s.score))), campaign_relevance: 0.5, cost: 0.4, freshness: 1 } });
    await db.prepare("UPDATE work_items SET result=? WHERE id=? AND status='queued'").bind(json({ domains: fresh, refs, kinds }), w.id).run();
    out.push(w.id);
  }
  return out;
}

/** Validates a grouping someone (a model, a command) proposes: every domain must be connected through cited, real, supported edges. */
export async function validateGrouping(domains: string[], edgeRefs: string[]) {
  const reasons: string[] = [];
  const set = new Set(domains.map(d => d.toLowerCase()));
  if (set.size < 2) reasons.push("a grouping needs at least two domains");
  if (!edgeRefs.length) reasons.push("no supporting edges were cited");
  const db = getD1();
  const cited: Row[] = [];
  for (const ref of new Set(edgeRefs)) {
    const e = await db.prepare("SELECT e.id,e.active,e.basis,d.node_key domain,d.node_type dt,n.id nid,n.generic FROM intel_edges e JOIN intel_nodes d ON d.id=e.src_node JOIN intel_nodes n ON n.id=e.dst_node WHERE e.id=?").bind(ref).first<Row>();
    if (!e) { reasons.push(`edge ${ref} does not exist`); continue; }
    if (!Number(e.active)) reasons.push(`edge ${ref} no longer holds`);
    if (Number(e.generic)) reasons.push(`edge ${ref} points at generic hosting`);
    if (e.dt !== "domain" || !set.has(String(e.domain))) reasons.push(`edge ${ref} is not about a proposed domain`);
    cited.push(e);
  }
  if (!reasons.length) {
    const byNode = new Map<string, Set<string>>();
    for (const e of cited) (byNode.get(String(e.nid)) ?? byNode.set(String(e.nid), new Set()).get(String(e.nid))!).add(String(e.domain));
    const pairs: Support[] = [];
    for (const ds of byNode.values()) { const l = [...ds]; for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) pairs.push({ a: l[i], b: l[j], kinds: [], edgeIds: [] }); }
    const comps = components(pairs);
    const largest = comps.sort((a, b) => b.length - a.length)[0] ?? [];
    const missing = [...set].filter(d => !largest.includes(d));
    if (missing.length) reasons.push(`the cited edges do not connect ${missing.join(", ")} to the rest`);
  }
  return reasons.length ? { ok: false as const, reasons } : { ok: true as const };
}

async function lineage(campaignId: string, event: string, related: string | null, detail: unknown) {
  await getD1().prepare("INSERT INTO campaign_lineage (id,campaign_id,event,related_campaign_id,detail) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), campaignId, event, related, json(detail)).run();
}

export async function executeFormation(w: Row) {
  assertExecutionAllowed("formation.form");
  const db = getD1();
  const existing = await db.prepare("SELECT campaign_id FROM campaign_meta WHERE formed_by_work_item=?").bind(w.id).first<Row>();
  if (existing) return { campaignId: String(existing.campaign_id), already: true };
  const r = parse<Row>(w.result, {});
  const domains = parse<string[]>(r.domains, []);
  const covered = (await db.prepare(`SELECT m.domain FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE c.status IN ('RUNNING','PAUSED') AND m.domain IN (${domains.map(() => "?").join(",") || "''"})`).bind(...domains).all<Row>()).results;
  if (domains.length - covered.length < MIN_FORMATION) return { skipped: "an active campaign already covers these sites" };
  const check = await validateGrouping(domains, parse<string[]>(r.refs, []));
  if (!check.ok) return { refused: check.reasons };
  const { createCampaign } = await import("../campaign/campaign");
  // An auto-formed campaign is exactly the graph-validated group: it does not run open-ended
  // association (which would make auto campaigns grow into each other). It still grows through its
  // own hypothesis pivots, and overlapping groups are combined only by a supported merge.
  const c = await createCampaign({ seed_domain: String(w.target_key), title: `Auto: ${domains.length} linked sites around ${w.target_key}`, started_by: "formation", auto_associate: false });
  const id = String(c!.id);
  for (const d of domains) {
    if (d === String(w.target_key)) continue;
    const cand = await db.prepare("SELECT id,investigation_id FROM inbox_candidates WHERE canonical_domain=?").bind(d).first<Row>();
    if (cand) await db.prepare("INSERT OR IGNORE INTO campaign_members (id,campaign_id,investigation_id,candidate_id,domain,role,state,reason) VALUES (?,?,?,?,?,'member','pending',?)")
      .bind(crypto.randomUUID(), id, cand.investigation_id ?? null, cand.id, d, `linked by shared ${parse<string[]>(r.kinds, []).map(k => k.replace("template:kit", "kit")).join(", ")} (graph-validated formation)`).run();
  }
  await db.prepare("INSERT OR IGNORE INTO campaign_meta (campaign_id,origin,formation_refs,formed_by_work_item,goal) VALUES (?,?,?,?,?)").bind(id, "auto", json(r.refs ?? []), w.id, "").run();
  await lineage(id, "formed", null, { domains, kinds: r.kinds, work_item: w.id });
  return { campaignId: id };
}

/** Two active campaigns whose sites are strongly linked become one. */
export async function proposeMerges() {
  if (!(await getBool("auto_merge_campaigns", true))) return [];
  const db = getD1();
  const members = (await db.prepare("SELECT m.campaign_id,m.domain,c.created_at FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE c.status IN ('RUNNING','PAUSED') AND m.state<>'suppressed'").all<Row>()).results;
  const of = new Map<string, string>(); const created = new Map<string, string>();
  for (const m of members) { if (!of.has(String(m.domain))) of.set(String(m.domain), String(m.campaign_id)); created.set(String(m.campaign_id), String(m.created_at)); }
  const pairs = await supportedPairs(new Set(of.keys()));
  const cross = new Map<string, Support[]>();
  for (const p of pairs) {
    const ca = of.get(p.a), cb = of.get(p.b);
    if (!ca || !cb || ca === cb) continue;
    const k = [ca, cb].sort().join("|");
    (cross.get(k) ?? cross.set(k, []).get(k)!).push(p);
  }
  const out: string[] = [];
  for (const [k, ps] of cross) {
    const strong = ps.some(p => p.kinds.includes("wallet")) || ps.length >= 2;
    if (!strong) continue;
    const [a, b] = k.split("|");
    const survivor = (created.get(a) ?? "") <= (created.get(b) ?? "") ? a : b, absorbed = survivor === a ? b : a;
    const w = await proposeWork({ kind: "merge_campaigns", targetType: "campaign_pair", targetKey: `${survivor}|${absorbed}`, source: "formation",
      reason: `Campaigns share ${ps.some(p => p.kinds.includes("wallet")) ? "a wallet" : `${ps.length} supported links`}; investigate them as one`, campaignId: survivor,
      factors: { info_gain: 0.5, evidence_strength: 0.7, campaign_relevance: 1, cost: 0.1, dup_prob: 0 } });
    await db.prepare("UPDATE work_items SET result=? WHERE id=? AND status='queued'").bind(json({ refs: [...new Set(ps.flatMap(p => p.edgeIds))].slice(0, 40), pairs: ps.length }), w.id).run();
    out.push(w.id);
  }
  return out;
}

export async function executeMerge(w: Row): Promise<Row> {
  assertExecutionAllowed("formation.merge");
  const db = getD1();
  const [survivor, absorbed] = String(w.target_key).split("|");
  const b = await db.prepare("SELECT status FROM campaigns WHERE id=?").bind(absorbed).first<Row>();
  if (!b || !["RUNNING", "PAUSED"].includes(String(b.status))) return { skipped: `campaign ${absorbed} is ${b?.status ?? "missing"}` };
  // Wait until the absorbed campaign has nothing in flight, so no running work loses its owner.
  const busy = Number((await db.prepare("SELECT COUNT(*) n FROM opportunities WHERE campaign_id=? AND status='executing'").bind(absorbed).first<Row>())?.n ?? 0);
  if (busy) return { defer: true, reason: `${busy} item(s) still running in the absorbed campaign` };
  await db.batch([
    db.prepare("UPDATE campaigns SET status='PAUSED',headline='Merging…',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(absorbed),
  ]);
  const members = (await db.prepare("SELECT * FROM campaign_members WHERE campaign_id=?").bind(absorbed).all<Row>()).results;
  for (const m of members) await db.prepare("INSERT OR IGNORE INTO campaign_members (id,campaign_id,investigation_id,candidate_id,domain,role,state,reason) VALUES (?,?,?,?,?,'member',?,?)")
    .bind(crypto.randomUUID(), survivor, m.investigation_id, m.candidate_id, m.domain, m.state === "investigating" ? "pending" : m.state, `merged from campaign ${absorbed.slice(0, 8)}: ${String(m.reason).slice(0, 200)}`).run();
  // Edges keep their original provenance (same source table and row).
  await db.prepare("INSERT OR IGNORE INTO campaign_edges (id,campaign_id,src_type,src_key,dst_type,dst_key,kind,basis,source_table,source_ref) SELECT lower(hex(randomblob(16))),?,src_type,src_key,dst_type,dst_key,kind,basis,source_table,source_ref FROM campaign_edges WHERE campaign_id=?").bind(survivor, absorbed).run();
  await db.batch([
    db.prepare("UPDATE campaigns SET status='MERGED',stop_reason=?,headline=?,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(`Merged into ${survivor}`, "Merged into another campaign", absorbed),
    db.prepare("UPDATE opportunities SET status='cancelled',reason='campaign merged',updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND status='open'").bind(absorbed),
    db.prepare("INSERT INTO campaign_meta (campaign_id,origin,merged_into) VALUES (?,'manual',?) ON CONFLICT(campaign_id) DO UPDATE SET merged_into=excluded.merged_into,updated_at=CURRENT_TIMESTAMP").bind(absorbed, survivor),
    db.prepare("UPDATE campaigns SET next_tick_at=CURRENT_TIMESTAMP WHERE id=?").bind(survivor),
  ]);
  await lineage(absorbed, "merged_into", survivor, { members: members.length, work_item: w.id, refs: parse<Row>(w.result, {}).refs });
  await lineage(survivor, "absorbed", absorbed, { members: members.length, work_item: w.id });
  return { merged: absorbed, into: survivor, members: members.length };
}

/** A campaign whose sites no longer connect (links went inactive) splits into its connected parts. */
export async function proposeSplits() {
  const db = getD1(); const out: string[] = [];
  for (const c of (await db.prepare("SELECT id FROM campaigns WHERE status IN ('RUNNING','PAUSED')").all<Row>()).results) {
    const members = (await db.prepare("SELECT domain FROM campaign_members WHERE campaign_id=? AND state<>'suppressed'").bind(c.id).all<Row>()).results.map(r => String(r.domain));
    if (members.length < 4) continue;
    const comps = components(await supportedPairs(new Set(members))).filter(x => x.length >= 2);
    const connected = new Set(comps.flat());
    if (comps.length < 2 || connected.size < members.length * 0.6) continue;
    const parts = comps.sort((a, b) => b.length - a.length);
    const w = await proposeWork({ kind: "split_campaign", targetType: "campaign", targetKey: String(c.id), source: "formation",
      reason: `Its sites now form ${parts.length} unconnected groups (${parts.map(p => p.length).join(" + ")}); investigate them separately`, campaignId: String(c.id),
      factors: { info_gain: 0.4, evidence_strength: 0.6, campaign_relevance: 1, cost: 0.1 } });
    await db.prepare("UPDATE work_items SET result=? WHERE id=? AND status='queued'").bind(json({ parts }), w.id).run();
    out.push(w.id);
  }
  return out;
}

export async function executeSplit(w: Row): Promise<Row> {
  assertExecutionAllowed("formation.split");
  const db = getD1();
  const cid = String(w.target_key);
  const parts = parse<string[][]>(parse<Row>(w.result, {}).parts, []);
  if (parts.length < 2) return { skipped: "nothing to split" };
  const busy = Number((await db.prepare("SELECT COUNT(*) n FROM opportunities WHERE campaign_id=? AND status='executing'").bind(cid).first<Row>())?.n ?? 0);
  if (busy) return { defer: true, reason: `${busy} item(s) still running` };
  const created: string[] = [];
  const { createCampaign } = await import("../campaign/campaign");
  for (const part of parts.slice(1)) {
    const seed = part[0];
    const nc = await createCampaign({ seed_domain: seed, title: `Split: ${part.length} sites around ${seed}`, started_by: "split", auto_associate: false });
    const nid = String(nc!.id);
    for (const d of part.slice(1)) {
      const m = await db.prepare("SELECT * FROM campaign_members WHERE campaign_id=? AND domain=?").bind(cid, d).first<Row>();
      if (m) await db.prepare("INSERT OR IGNORE INTO campaign_members (id,campaign_id,investigation_id,candidate_id,domain,role,state,reason) VALUES (?,?,?,?,?,'member',?,?)")
        .bind(crypto.randomUUID(), nid, m.investigation_id, m.candidate_id, d, m.state === "investigating" ? "pending" : m.state, `split from campaign ${cid.slice(0, 8)}: ${String(m.reason).slice(0, 200)}`).run();
    }
    const ph = part.map(() => "?").join(",");
    await db.prepare(`INSERT OR IGNORE INTO campaign_edges (id,campaign_id,src_type,src_key,dst_type,dst_key,kind,basis,source_table,source_ref) SELECT lower(hex(randomblob(16))),?,src_type,src_key,dst_type,dst_key,kind,basis,source_table,source_ref FROM campaign_edges WHERE campaign_id=? AND src_key IN (${ph})`).bind(nid, cid, ...part).run();
    await db.prepare(`UPDATE campaign_members SET state='suppressed',reason=?,updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND domain IN (${ph})`).bind(`moved to split campaign ${nid.slice(0, 8)}`, cid, ...part).run();
    await db.prepare(`UPDATE opportunities SET status='cancelled',reason='moved to split campaign',updated_at=CURRENT_TIMESTAMP WHERE campaign_id=? AND status='open' AND target_key IN (${ph})`).bind(cid, ...part).run();
    await db.prepare("INSERT INTO campaign_meta (campaign_id,origin,split_from) VALUES (?,'split',?) ON CONFLICT(campaign_id) DO UPDATE SET split_from=excluded.split_from,origin='split'").bind(nid, cid).run();
    await lineage(nid, "split_from", cid, { domains: part, work_item: w.id });
    await lineage(cid, "split_off", nid, { domains: part, work_item: w.id });
    created.push(nid);
  }
  return { split: cid, into: created };
}

/** A campaign whose known sites are all gone becomes inactive (it can reopen). */
export async function checkInactive(campaignId: string) {
  const db = getD1();
  const c = await db.prepare("SELECT status FROM campaigns WHERE id=?").bind(campaignId).first<Row>();
  if (!c || !["RUNNING", "COMPLETE", "BUDGET_EXHAUSTED"].includes(String(c.status))) return false;
  const rows = (await db.prepare("SELECT m.domain,f.value FROM campaign_members m LEFT JOIN entity_facets f ON f.subject_type='domain' AND f.subject_key=m.domain AND f.facet='status' WHERE m.campaign_id=? AND m.state<>'suppressed'").bind(campaignId).all<Row>()).results;
  const known = rows.filter(r => r.value != null);
  if (known.length < 2 || known.some(r => parse<string>(r.value, "") === "live") || known.length < rows.length * 0.8) return false;
  const busy = Number((await db.prepare("SELECT COUNT(*) n FROM opportunities WHERE campaign_id=? AND status='executing'").bind(campaignId).first<Row>())?.n ?? 0);
  if (busy) return false;
  await db.prepare("UPDATE campaigns SET status='INACTIVE',stop_reason='Every known site in this campaign is gone',headline='Inactive: the sites went dark',finished_at=CURRENT_TIMESTAMP,lease_owner=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(campaignId).run();
  await lineage(campaignId, "inactive", null, { dead: known.length, members: rows.length });
  await db.prepare("INSERT INTO entity_changes (id,subject_type,subject_key,facet,change_kind,significance,source_table,source_ref) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), "campaign", campaignId, "status", "cluster_inactive", 0.5, "campaigns", campaignId).run();
  return true;
}

export async function reopenCampaign(campaignId: string, why: string) {
  const db = getD1();
  const r = await db.prepare("UPDATE campaigns SET status='RUNNING',stop_reason=NULL,finished_at=NULL,headline=?,deadline_at=?,next_tick_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('INACTIVE','COMPLETE')")
    .bind(`Reopened: ${why.slice(0, 120)}`, new Date(Date.now() + 86400000).toISOString(), campaignId).run();
  if ((r.meta?.changes ?? 0) === 1) { await lineage(campaignId, "reopened", null, { why }); return true; }
  return false;
}

/** Read-only comparison of two campaigns: what their sites share. */
export async function compareCampaigns(a: string, b: string) {
  const db = getD1();
  const doms = async (id: string) => (await db.prepare("SELECT domain FROM campaign_members WHERE campaign_id=? AND state<>'suppressed'").bind(id).all<Row>()).results.map(r => String(r.domain));
  const [da, dbb] = [await doms(a), await doms(b)];
  const pairs = (await supportedPairs(new Set([...da, ...dbb]))).filter(p => (da.includes(p.a) && dbb.includes(p.b)) || (da.includes(p.b) && dbb.includes(p.a)));
  const shared = (await db.prepare(`SELECT n.node_type,n.node_key,COUNT(DISTINCT d.node_key) sites FROM intel_edges e JOIN intel_nodes d ON d.id=e.src_node AND d.node_type='domain' JOIN intel_nodes n ON n.id=e.dst_node
    WHERE e.active=1 AND n.generic=0 AND d.node_key IN (${[...da, ...dbb].map(() => "?").join(",") || "''"}) GROUP BY n.id HAVING SUM(CASE WHEN d.node_key IN (${da.map(() => "?").join(",") || "''"}) THEN 1 ELSE 0 END)>0 AND SUM(CASE WHEN d.node_key IN (${dbb.map(() => "?").join(",") || "''"}) THEN 1 ELSE 0 END)>0`)
    .bind(...da, ...dbb, ...da, ...dbb).all<Row>()).results;
  return { a: { id: a, sites: da.length }, b: { id: b, sites: dbb.length }, shared_nodes: shared.map(s => ({ type: s.node_type, key: s.node_key, sites: Number(s.sites) })),
    supported_links: pairs.length, merge_supported: pairs.some(p => p.kinds.includes("wallet")) || pairs.length >= 2,
    note: "Shared infrastructure or wallets are reasons to investigate together, not proof of common ownership." };
}
