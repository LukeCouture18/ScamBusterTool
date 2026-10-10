/**
 * The global intelligence graph: one graph across every investigation and
 * campaign, derived incrementally from rows the platform already trusts.
 *
 *   inbox_candidates        Site Finder's public, passive observation of a domain
 *                           (hosting IP, name servers, certificate names, template,
 *                           favicon, chat service, publicly shown wallets, kit)
 *   investigation_entities  what modules observed inside an investigation (wallets)
 *   relationships           site-to-site links a module recorded
 *   evidence                module evidence supporting a domain (wallet/deposit pages)
 *   campaign_members        campaign membership (deterministic)
 *
 * `addIntelEdge` is the only writer. Like the v4 campaign graph it refuses any
 * basis other than observed/deterministic, any source table not listed, and any
 * source row that does not exist. Hypotheses are linked through
 * `intel_reasoning_links`, never as edges. Edge names describe what was seen:
 * sharing hosting, a certificate, a template or a wallet is a reason to look
 * together, not evidence of common ownership.
 */
import { getD1 } from "../platform";
import { assertExecutionAllowed } from "./guard";
import { getState, setState, json, parse, clamp, r3, type Row } from "./common";

const SOURCE_TABLES = new Set(["inbox_candidates", "investigation_entities", "relationships", "evidence", "campaign_members", "investigations", "jobs"]);
export const GENERIC_DEGREE = 25;
const KEY_NODE: Record<string, [string, string]> = {          // Finder key type -> [node type, edge kind]
  ip: ["ip", "hosted_on"], ns: ["nameserver", "uses_nameserver"], san: ["certificate", "presents_certificate"], favtmpl: ["template", "uses_template"],
  favicon: ["favicon", "shows_favicon"], service: ["identifier", "uses_service"], wallet: ["wallet", "displays_wallet"], asn: ["asn", "hosted_in_asn"], tech: ["technology", "uses_technology"],
};
const SOURCE_WEIGHT: Record<string, number> = { inbox_candidates: 0.4, investigation_entities: 0.7, relationships: 0.7, evidence: 0.75, campaign_members: 0.5, investigations: 0.5, jobs: 0.5 };

export async function upsertNode(type: string, key: string, label = "", prov: Row = {}) {
  assertExecutionAllowed("intel.node");
  const db = getD1(); const k = key.slice(0, 400);
  await db.prepare("INSERT INTO intel_nodes (id,node_type,node_key,label,provenance) VALUES (?,?,?,?,?) ON CONFLICT(node_type,node_key) DO UPDATE SET last_seen_at=CURRENT_TIMESTAMP")
    .bind(crypto.randomUUID(), type, k, (label || k).slice(0, 120), json(prov)).run();
  return String((await db.prepare("SELECT id FROM intel_nodes WHERE node_type=? AND node_key=?").bind(type, k).first<Row>())!.id);
}

export async function addIntelEdge(e: { src: string; dst: string; kind: string; basis: "observed" | "deterministic"; sourceTable: string; sourceRef: string }) {
  assertExecutionAllowed("intel.edge");
  if (e.basis !== "observed" && e.basis !== "deterministic") throw new Error("INTEL_EDGE_BASIS_NOT_ALLOWED");
  if (!SOURCE_TABLES.has(e.sourceTable)) throw new Error("INTEL_EDGE_SOURCE_NOT_ALLOWED");
  const db = getD1();
  if (!(await db.prepare(`SELECT 1 FROM ${e.sourceTable} WHERE id=? LIMIT 1`).bind(e.sourceRef).first())) throw new Error("INTEL_EDGE_SOURCE_ROW_MISSING");
  for (const n of [e.src, e.dst]) if (!(await db.prepare("SELECT 1 FROM intel_nodes WHERE id=?").bind(n).first())) throw new Error("INTEL_EDGE_NODE_MISSING");
  const r = await db.prepare("INSERT INTO intel_edges (id,src_node,dst_node,kind,basis,source_table,source_ref,strength) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(src_node,dst_node,kind,source_table,source_ref) DO UPDATE SET last_seen_at=CURRENT_TIMESTAMP,active=1")
    .bind(crypto.randomUUID(), e.src, e.dst, e.kind, e.basis, e.sourceTable, e.sourceRef, SOURCE_WEIGHT[e.sourceTable] ?? 0.5).run();
  return (r.meta?.changes ?? 0) > 0;
}

function keysOf(details: unknown, wallets: unknown): Array<[string, string]> {
  const d = parse<Row>(details, {});
  const out = (Array.isArray(d.keys) ? d.keys as unknown[] : []).filter((k): k is [string, string] => Array.isArray(k) && k.length === 2).map(k => [String(k[0]), String(k[1])] as [string, string]);
  for (const w of parse<string[]>(wallets, [])) if (w) out.push(["wallet", String(w).toLowerCase()]);
  return out.filter(([t, v]) => KEY_NODE[t] && v);
}

/** Incremental sync from platform rows. Safe to re-run: every write is idempotent. */
export async function syncGlobalGraph(limit = 200) {
  const db = getD1(); let edges = 0;
  const touched = new Set<string>();
  // 1. Site Finder's passive observations (re-read when a candidate is updated).
  // Compound cursor (updated_at, rowid): candidates are updated in place when Finder re-observes them.
  const [cAt, cRid] = (await getState("intel_cursor:inbox_candidates", "|0")).split("|");
  const cands = (await db.prepare("SELECT rowid rid,* FROM inbox_candidates WHERE updated_at>? OR (updated_at=? AND rowid>?) ORDER BY updated_at, rowid LIMIT ?").bind(cAt, cAt, Number(cRid || 0), limit).all<Row>()).results;
  for (const c of cands) {
    const domain = String(c.canonical_domain);
    const dn = await upsertNode("domain", domain, domain, { table: "inbox_candidates", ref: c.id }); touched.add(dn);
    for (const [t, v] of keysOf(c.details, c.wallets)) {
      const [type, kind] = KEY_NODE[t];
      const n = await upsertNode(type, v, v, { table: "inbox_candidates", ref: c.id }); touched.add(n);
      if (await addIntelEdge({ src: dn, dst: n, kind, basis: "observed", sourceTable: "inbox_candidates", sourceRef: String(c.id) })) edges++;
    }
    if (c.cluster_key && !String(c.cluster_key).startsWith("c:")) {
      const n = await upsertNode("template", `kit:${c.cluster_key}`, `kit ${String(c.cluster_key).slice(0, 40)}`, { table: "inbox_candidates", ref: c.id }); touched.add(n);
      if (await addIntelEdge({ src: dn, dst: n, kind: "same_kit", basis: "deterministic", sourceTable: "inbox_candidates", sourceRef: String(c.id) })) edges++;
    }
    if (c.investigation_id) {
      const inv = await upsertNode("investigation", String(c.investigation_id), `investigation of ${domain}`, { table: "inbox_candidates", ref: c.id });
      if (await addIntelEdge({ src: inv, dst: dn, kind: "investigates", basis: "deterministic", sourceTable: "inbox_candidates", sourceRef: String(c.id) })) edges++;
    }
  }
  // Advance only past rows from seconds that are over: a candidate updated in place during the current
  // second keeps its old rowid, so it would otherwise sort behind the cursor and be missed. Rows from the
  // current second are simply re-read next time (every write here is idempotent).
  const nowSec = String((await db.prepare("SELECT CURRENT_TIMESTAMP t").first<Row>())?.t ?? "");
  const settled = cands.filter(c => String(c.updated_at) < nowSec);
  if (settled.length) await setState("intel_cursor:inbox_candidates", `${settled[settled.length - 1].updated_at}|${settled[settled.length - 1].rid}`);

  // 2. Module observations inside investigations: wallets a module saw on the site.
  const ieCursor = Number(await getState("intel_cursor:investigation_entities", "0"));
  const ies = (await db.prepare("SELECT ie.rowid rid,ie.id,ie.investigation_id,ie.source_module,e.entity_type,e.canonical_key,c.canonical_domain FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id JOIN inbox_candidates c ON c.investigation_id=ie.investigation_id WHERE ie.rowid>? AND e.entity_type='wallet' AND ie.source_module IN ('site_investigator','crypto_wallet_logger','wallet_investigator') ORDER BY ie.rowid LIMIT ?").bind(ieCursor, limit).all<Row>()).results;
  for (const r of ies) {
    const dn = await upsertNode("domain", String(r.canonical_domain)); touched.add(dn);
    const wn = await upsertNode("wallet", String(r.canonical_key).replace(/^[a-z0-9_]+:(?=\w{20,})/, "").toLowerCase(), "", { table: "investigation_entities", ref: r.id }); touched.add(wn);
    if (await addIntelEdge({ src: dn, dst: wn, kind: "displays_wallet", basis: "observed", sourceTable: "investigation_entities", sourceRef: String(r.id) })) edges++;
  }
  const maxIe = ies.length ? Number(ies[ies.length - 1].rid) : 0;
  if (maxIe) await setState("intel_cursor:investigation_entities", maxIe);

  // 3. Module-recorded site relationships.
  const relCursor = Number(await getState("intel_cursor:relationships", "0"));
  const rels = (await db.prepare("SELECT r.rowid rid,r.id,s.canonical_key src,t.canonical_key dst,s.entity_type st,t.entity_type tt FROM relationships r JOIN entities s ON s.id=r.source_entity_id JOIN entities t ON t.id=r.target_entity_id WHERE r.rowid>? ORDER BY r.rowid LIMIT ?").bind(relCursor, limit).all<Row>()).results;
  for (const r of rels) {
    if (r.st !== "site" || r.tt !== "site") continue;
    const a = await upsertNode("domain", String(r.src).toLowerCase()), b = await upsertNode("domain", String(r.dst).toLowerCase()); touched.add(a); touched.add(b);
    if (await addIntelEdge({ src: a, dst: b, kind: "related_site", basis: "observed", sourceTable: "relationships", sourceRef: String(r.id) })) edges++;
  }
  if (rels.length) await setState("intel_cursor:relationships", Number(rels[rels.length - 1].rid));

  // 4. Evidence that supports a domain (module observations of deposit/wallet pages).
  const evCursor = Number(await getState("intel_cursor:evidence", "0"));
  const evs = (await db.prepare("SELECT e.rowid rid,e.id,e.evidence_type,c.canonical_domain FROM evidence e JOIN inbox_candidates c ON c.investigation_id=e.investigation_id WHERE e.rowid>? AND e.source_module IN ('site_investigator','crypto_wallet_logger','wallet_investigator') AND e.evidence_type IN ('wallet_display','deposit_page','page_text','screenshot') ORDER BY e.rowid LIMIT ?").bind(evCursor, limit).all<Row>()).results;
  for (const r of evs) {
    const dn = await upsertNode("domain", String(r.canonical_domain));
    const en = await upsertNode("evidence", String(r.id), String(r.evidence_type), { table: "evidence", ref: r.id });
    if (await addIntelEdge({ src: en, dst: dn, kind: "supports", basis: "observed", sourceTable: "evidence", sourceRef: String(r.id) })) edges++;
  }
  if (evs.length) await setState("intel_cursor:evidence", Number(evs[evs.length - 1].rid));

  // 5. Campaign membership.
  const cmCursor = Number(await getState("intel_cursor:campaign_members", "0"));
  const cms = (await db.prepare("SELECT rowid rid,id,campaign_id,domain FROM campaign_members WHERE rowid>? ORDER BY rowid LIMIT ?").bind(cmCursor, limit).all<Row>()).results;
  for (const m of cms) {
    const dn = await upsertNode("domain", String(m.domain)), cn = await upsertNode("campaign", String(m.campaign_id));
    if (await addIntelEdge({ src: dn, dst: cn, kind: "member_of", basis: "deterministic", sourceTable: "campaign_members", sourceRef: String(m.id) })) edges++;
  }
  if (cms.length) await setState("intel_cursor:campaign_members", Number(cms[cms.length - 1].rid));

  // 6. Hypotheses (reasoning) linked to the nodes they are about: never edges.
  const hCursor = Number(await getState("intel_cursor:hypotheses", "0"));
  const hs = (await db.prepare("SELECT rowid rid,id,test_target FROM hypotheses WHERE rowid>? ORDER BY rowid LIMIT ?").bind(hCursor, limit).all<Row>()).results;
  for (const h of hs) {
    const t = String(h.test_target); const i = t.indexOf(":"); const kind = t.slice(0, i), value = t.slice(i + 1);
    const map = kind === "kit" ? ["template", `kit:${value}`] : KEY_NODE[kind] ? [KEY_NODE[kind][0], kind === "wallet" ? value.toLowerCase() : value] : null;
    if (!map) continue;
    const node = await db.prepare("SELECT id FROM intel_nodes WHERE node_type=? AND node_key=?").bind(map[0], map[1]).first<Row>();
    if (node) await db.prepare("INSERT OR IGNORE INTO intel_reasoning_links (id,reasoning_type,reasoning_ref,node_id) VALUES (?,?,?,?)").bind(crypto.randomUUID(), "hypothesis", h.id, node.id).run();
  }
  if (hs.length) await setState("intel_cursor:hypotheses", Number(hs[hs.length - 1].rid));

  // Degrees, generic flags and relationship strength for touched nodes.
  for (const n of touched) await refreshNode(n);
  return { candidates: cands.length, module_wallets: ies.length, relationships: rels.length, evidence: evs.length, memberships: cms.length, new_edges: edges };
}

async function refreshNode(id: string) {
  const db = getD1();
  const node = await db.prepare("SELECT node_type,generic FROM intel_nodes WHERE id=?").bind(id).first<Row>();
  if (!node) return;
  const deg = Number((await db.prepare("SELECT COUNT(DISTINCT CASE WHEN src_node=? THEN dst_node ELSE src_node END) n FROM intel_edges WHERE (src_node=? OR dst_node=?) AND active=1").bind(id, id, id).first<Row>())?.n ?? 0);
  const generic = ["ip", "nameserver", "asn", "technology", "certificate"].includes(String(node.node_type)) && deg > GENERIC_DEGREE ? 1 : 0;
  await db.prepare("UPDATE intel_nodes SET degree=?,generic=? WHERE id=?").bind(deg, generic, id).run();
  if (generic !== Number(node.generic)) {
    const { recordConfidence } = await import("./confidence");
    await recordConfidence({ subjectType: "intel_node", subjectId: id, dimension: "relationship_strength", value: generic ? 0.05 : 0.5, reason: generic ? `shared by ${deg} domains: generic hosting, links nothing` : "no longer generic", basis: "deterministic" });
  }
  // Strength of each of the node's relationships: independent sources combine, inactive links halve.
  const pairs = (await db.prepare("SELECT src_node,dst_node,kind,GROUP_CONCAT(DISTINCT source_table) tables,MAX(active) active FROM intel_edges WHERE src_node=? OR dst_node=? GROUP BY src_node,dst_node,kind").bind(id, id).all<Row>()).results;
  for (const p of pairs) {
    const tables = String(p.tables ?? "").split(",").filter(Boolean);
    let s = 1 - tables.reduce((acc, t) => acc * (1 - (SOURCE_WEIGHT[t] ?? 0.5)), 1);
    if (!Number(p.active)) s *= 0.5;
    if (generic) s *= 0.1;
    await db.prepare("UPDATE intel_edges SET strength=? WHERE src_node=? AND dst_node=? AND kind=?").bind(r3(clamp(s)), p.src_node, p.dst_node, p.kind).run();
  }
}

/** A later observation shows a link no longer holds (the site moved hosting, changed certificate). History is kept. */
export async function deactivateFacetEdges(domain: string, facet: string, oldValue: unknown) {
  const db = getD1();
  const type = facet === "ip" ? "ip" : facet === "nameservers" ? "nameserver" : facet === "certificate" ? "certificate" : null;
  if (!type) return 0;
  const dn = await db.prepare("SELECT id FROM intel_nodes WHERE node_type='domain' AND node_key=?").bind(domain).first<Row>();
  if (!dn) return 0;
  let n = 0;
  for (const v of Array.isArray(oldValue) ? oldValue.map(String) : []) {
    const r = await db.prepare("UPDATE intel_edges SET active=0 WHERE src_node=? AND dst_node=(SELECT id FROM intel_nodes WHERE node_type=? AND node_key=?)").bind(dn.id, type, v).run();
    n += r.meta?.changes ?? 0;
  }
  await refreshNode(String(dn.id));
  return n;
}

export type GraphQuery = { types?: string[]; kinds?: string[]; minStrength?: number; sinceDays?: number; campaignId?: string; focus?: string; depth?: number; limit?: number; includeGeneric?: boolean; includeInactive?: boolean };

/**
 * A readable subgraph, never the whole hairball: a focus node's neighbourhood
 * (depth 1-2) or the most connected non-generic structure, filtered by entity
 * type, relationship kind, minimum strength, recency and campaign.
 */
export async function graphQuery(q: GraphQuery) {
  const db = getD1(); const limit = Math.min(Math.max(q.limit ?? 120, 10), 300);
  const conds = ["1=1"], binds: unknown[] = [];
  if (!q.includeInactive) conds.push("e.active=1");
  if (q.minStrength) { conds.push("e.strength>=?"); binds.push(q.minStrength); }
  if (q.kinds?.length) { conds.push(`e.kind IN (${q.kinds.map(() => "?").join(",")})`); binds.push(...q.kinds); }
  if (q.sinceDays) { conds.push("e.last_seen_at>=datetime('now', ?)"); binds.push(`-${Math.floor(q.sinceDays)} days`); }
  let seeds: string[] = [];
  if (q.focus) {
    const i = q.focus.indexOf(":"); const f = await db.prepare("SELECT id FROM intel_nodes WHERE (node_type=? AND node_key=?) OR id=?").bind(q.focus.slice(0, i), q.focus.slice(i + 1), q.focus).first<Row>();
    if (f) seeds = [String(f.id)];
  } else if (q.campaignId) {
    seeds = (await db.prepare("SELECT n.id FROM campaign_members m JOIN intel_nodes n ON n.node_type='domain' AND n.node_key=m.domain WHERE m.campaign_id=?").bind(q.campaignId).all<Row>()).results.map(r => String(r.id));
  } else {
    seeds = (await db.prepare("SELECT id FROM intel_nodes WHERE generic=0 AND node_type NOT IN ('evidence','investigation') ORDER BY degree DESC LIMIT 12").all<Row>()).results.map(r => String(r.id));
  }
  const nodes = new Set(seeds); let frontier = [...seeds]; const edges = new Map<string, Row>();
  for (let d = 0; d < Math.min(q.depth ?? (q.focus ? 2 : 1), 3) && frontier.length && nodes.size < limit; d++) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += 40) {
      const chunk = frontier.slice(i, i + 40);
      const ph = chunk.map(() => "?").join(",");
      const rows = (await db.prepare(`SELECT e.*,sn.generic sg,dn.generic dg FROM intel_edges e JOIN intel_nodes sn ON sn.id=e.src_node JOIN intel_nodes dn ON dn.id=e.dst_node WHERE (e.src_node IN (${ph}) OR e.dst_node IN (${ph})) AND ${conds.join(" AND ")} LIMIT 600`).bind(...chunk, ...chunk, ...binds).all<Row>()).results;
      for (const e of rows) {
        if (!q.includeGeneric && (Number(e.sg) || Number(e.dg))) continue;
        for (const n of [String(e.src_node), String(e.dst_node)]) if (!nodes.has(n) && nodes.size < limit) { nodes.add(n); next.push(n); }
        if (nodes.has(String(e.src_node)) && nodes.has(String(e.dst_node))) edges.set(String(e.id), e);
      }
    }
    frontier = next;
  }
  const ids = [...nodes];
  const nodeRows: Row[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    nodeRows.push(...(await db.prepare(`SELECT id,node_type,node_key,label,generic,degree,first_seen_at,last_seen_at FROM intel_nodes WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<Row>()).results);
  }
  const typed = q.types?.length ? nodeRows.filter(n => q.types!.includes(String(n.node_type)) || seeds.includes(String(n.id))) : nodeRows;
  const keep = new Set(typed.map(n => String(n.id)));
  const reasoning = (await db.prepare(`SELECT l.node_id,h.id,h.statement,h.status,h.confidence FROM intel_reasoning_links l JOIN hypotheses h ON h.id=l.reasoning_ref WHERE l.reasoning_type='hypothesis'`).all<Row>()).results.filter(r => keep.has(String(r.node_id)));
  return {
    nodes: typed.map(n => ({ id: n.id, type: n.node_type, key: n.node_key, label: n.label, degree: Number(n.degree), generic: Number(n.generic) === 1, last_seen_at: n.last_seen_at })),
    edges: [...edges.values()].filter(e => keep.has(String(e.src_node)) && keep.has(String(e.dst_node))).map(e => ({ id: e.id, from: e.src_node, to: e.dst_node, kind: e.kind, basis: e.basis, strength: Number(e.strength), active: Number(e.active) === 1, provenance: `${e.source_table}:${e.source_ref}`, last_seen_at: e.last_seen_at })),
    reasoning: reasoning.map(r => ({ node_id: r.node_id, hypothesis_id: r.id, statement: r.statement, status: r.status, confidence: Number(r.confidence), note: "reasoning, not evidence" })),
    truncated: nodes.size >= limit,
    note: "Edges are observed or deterministic links, each citing its source row. Shared infrastructure, templates or wallets are reasons to look together; none of them establishes common ownership.",
  };
}

/** Everything the platform knows about one node: links with provenance, evidence, history, campaigns, reasoning. */
export async function nodeDetail(id: string) {
  const db = getD1();
  const n = await db.prepare("SELECT * FROM intel_nodes WHERE id=?").bind(id).first<Row>();
  if (!n) return null;
  const edges = (await db.prepare("SELECT e.*,CASE WHEN e.src_node=? THEN d.node_type ELSE s.node_type END other_type,CASE WHEN e.src_node=? THEN d.node_key ELSE s.node_key END other_key FROM intel_edges e JOIN intel_nodes s ON s.id=e.src_node JOIN intel_nodes d ON d.id=e.dst_node WHERE e.src_node=? OR e.dst_node=? ORDER BY e.strength DESC LIMIT 100").bind(id, id, id, id).all<Row>()).results;
  const out: Row = { node: { ...n, provenance: parse(n.provenance, {}) }, links: edges.map(e => ({ kind: e.kind, other: `${e.other_type}:${e.other_key}`, basis: e.basis, strength: Number(e.strength), active: Number(e.active) === 1, provenance: `${e.source_table}:${e.source_ref}`, first_seen_at: e.first_seen_at, last_seen_at: e.last_seen_at })) };
  if (n.node_type === "domain") {
    const { history } = await import("./temporal");
    out.history = await history("domain", String(n.node_key));
    const cand = await db.prepare("SELECT id,investigation_id,score,headline,status FROM inbox_candidates WHERE canonical_domain=?").bind(n.node_key).first<Row>();
    out.candidate = cand;
    if (cand?.investigation_id) out.evidence = (await db.prepare("SELECT id,evidence_type,title,source_module,captured_at FROM evidence WHERE investigation_id=? ORDER BY captured_at DESC LIMIT 30").bind(cand.investigation_id).all<Row>()).results;
    out.campaigns = (await db.prepare("SELECT c.id,c.title,c.status,m.state FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE m.domain=?").bind(n.node_key).all<Row>()).results;
    out.gaps = (await db.prepare("SELECT gap_kind,missing,status,resolution FROM evidence_gaps WHERE subject_key=?").bind(n.node_key).all<Row>()).results;
  }
  out.reasoning = (await db.prepare("SELECT h.id,h.statement,h.status,h.confidence FROM intel_reasoning_links l JOIN hypotheses h ON h.id=l.reasoning_ref WHERE l.node_id=?").bind(id).all<Row>()).results;
  out.confidence = (await db.prepare("SELECT dimension,value,previous,reason,basis,at FROM confidence_records WHERE subject_id=? ORDER BY at DESC LIMIT 20").bind(id).all<Row>()).results;
  return out;
}

/** Wallets observed on two or more domains (observed edges only). */
export async function multiSiteWallets(limit = 50) {
  return (await getD1().prepare("SELECT w.node_key wallet,COUNT(DISTINCT e.src_node) sites,GROUP_CONCAT(DISTINCT d.node_key) domains FROM intel_edges e JOIN intel_nodes w ON w.id=e.dst_node AND w.node_type='wallet' JOIN intel_nodes d ON d.id=e.src_node AND d.node_type='domain' WHERE e.kind='displays_wallet' AND e.active=1 GROUP BY w.id HAVING sites>=2 ORDER BY sites DESC LIMIT ?").bind(limit).all<Row>()).results
    .map(r => ({ wallet: String(r.wallet), sites: Number(r.sites), domains: String(r.domains).split(",") }));
}
