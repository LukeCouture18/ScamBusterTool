/**
 * The campaign intelligence graph and automatic association.
 *
 * Nodes are sites, wallets, indicators (IP, nameserver, certificate SAN group,
 * favicon, chat service), kits (Site Finder's template/key clusters),
 * investigations and — as an overlay only — hypotheses.
 *
 * Every edge in `campaign_edges` has provenance: the table and row(s) that
 * prove it, and a basis of `observed` or `deterministic`. `addEdge` is the only
 * way in, and it verifies that the cited row exists before writing. There is no
 * code path from model output to this function: the AI cannot create a
 * relationship, and a hypothesis never becomes an edge.
 *
 * Edge kinds name RELATIONSHIPS. Shared hosting, certificates, templates or
 * wallets are reasons to look together; none of them means common ownership,
 * and nothing here says it does.
 */
import { getD1 } from "../platform";
import { assertExecutionAllowed } from "../ops/guard";

type Row = Record<string, unknown>;
export type NodeType = "site" | "wallet" | "indicator" | "kit" | "investigation" | "hypothesis";
export type EdgeKind = "displays_wallet" | "shares_indicator" | "same_kit" | "investigates" | "observed_relationship";
export const INDICATOR_TYPES = new Set(["ip", "ns", "san", "favicon", "favtmpl", "service", "wallet"]);
const SOURCE_TABLES = new Set(["evidence", "relationships", "inbox_candidates", "investigation_entities", "campaign_members", "jobs"]);
/** An indicator shared by more candidates than this is generic infrastructure (a CDN, a big host), not a relationship. */
export const GENERIC_THRESHOLD = 25;
export const MAX_MEMBERS = 80;

function parse<T>(value: unknown, fallback: T): T { try { return typeof value === "string" ? JSON.parse(value) as T : (value as T) ?? fallback; } catch { return fallback; } }
export function domainOf(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  try { return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, ""); } catch { return raw.replace(/^www\./, ""); }
}
export function candidateKeys(details: unknown, walletsColumn?: unknown): Array<[string, string]> {
  const d = parse<Row>(details, {});
  const keys = (Array.isArray(d.keys) ? d.keys as unknown[] : []).filter((k): k is [string, string] => Array.isArray(k) && k.length === 2).map(k => [String(k[0]), String(k[1])] as [string, string]);
  const wallets = new Set<string>([...(Array.isArray(d.wallets) ? d.wallets as unknown[] : []), ...parse<unknown[]>(walletsColumn, [])].filter((w): w is string => typeof w === "string" && w.length > 0));
  for (const w of new Set([...wallets].map(walletKey))) keys.push(["wallet", w]);
  return keys.filter(([t, v]) => INDICATOR_TYPES.has(t) && v).map(([t, v]) => [t, v.slice(0, 400)]);
}
const isSingletonKit = (key: string) => !key || key.startsWith("c:");

/**
 * The only writer of campaign edges. Rejects anything that is not observed or
 * deterministic, names an unknown source table, or cites a row that does not exist.
 */
export async function addEdge(campaignId: string, e: { srcType: NodeType; srcKey: string; dstType: NodeType; dstKey: string; kind: EdgeKind; basis: "observed" | "deterministic"; sourceTable: string; sourceRef: string }) {
  assertExecutionAllowed("campaign.addEdge");
  if (e.basis !== "observed" && e.basis !== "deterministic") throw new Error("EDGE_BASIS_NOT_ALLOWED");
  if (!SOURCE_TABLES.has(e.sourceTable)) throw new Error("EDGE_SOURCE_NOT_ALLOWED");
  if (e.srcType === "hypothesis" || e.dstType === "hypothesis") throw new Error("HYPOTHESIS_IS_NOT_A_RELATIONSHIP");
  const exists = await getD1().prepare(`SELECT 1 FROM ${e.sourceTable} WHERE id=? LIMIT 1`).bind(e.sourceRef).first();
  if (!exists) throw new Error("EDGE_SOURCE_ROW_MISSING");
  const r = await getD1().prepare("INSERT OR IGNORE INTO campaign_edges (id,campaign_id,src_type,src_key,dst_type,dst_key,kind,basis,source_table,source_ref) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), campaignId, e.srcType, e.srcKey.slice(0, 400), e.dstType, e.dstKey.slice(0, 400), e.kind, e.basis, e.sourceTable, e.sourceRef).run();
  return (r.meta?.changes ?? 0) === 1;
}

/** SQL predicate + needle that finds candidates carrying an indicator (wallets live in their own column). */
export function keyMatch(type: string, value: string): [string, string] {
  // Wallet addresses are compared case-insensitively: the entity store keeps them lower-cased.
  return type === "wallet" ? ["instr(lower(wallets), ?) > 0", JSON.stringify(value.toLowerCase())] : ["instr(details, ?) > 0", JSON.stringify([type, value])];
}
/** Canonical graph key for a wallet address (see keyMatch). */
export const walletKey = (address: string) => address.trim().toLowerCase();
async function popularity(type: string, value: string) {
  const [where, needle] = keyMatch(type, value);
  const row = await getD1().prepare(`SELECT COUNT(*) n FROM inbox_candidates WHERE ${where}`).bind(needle).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function addMember(campaignId: string, c: Row, reason: string, role = "member") {
  const domain = String(c.canonical_domain);
  const state = c.decision === "skip" || c.status === "suppressed" ? "suppressed" : c.decision === "useful" || c.progress_state === "campaign_investigating" ? "investigating" : "pending";
  const r = await getD1().prepare("INSERT OR IGNORE INTO campaign_members (id,campaign_id,investigation_id,candidate_id,domain,role,state,reason) VALUES (?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), campaignId, c.investigation_id ?? null, c.id ?? null, domain, role, state, reason.slice(0, 300)).run();
  return (r.meta?.changes ?? 0) === 1;
}

/**
 * Adds the seed and expands membership one hop along observable relationships:
 * the same Site Finder kit cluster, a shared non-generic indicator, a shared
 * wallet (from Finder's public observation or a module's), or a relationship a
 * module recorded. Writes an edge, with provenance, for each reason.
 */
export const MAX_HOPS_PER_PASS = 3;
export async function associate(campaignId: string) {
  const db = getD1();
  let added = 0;
  const processed = new Set<string>();
  // Bounded breadth-first expansion: at most MAX_HOPS_PER_PASS hops per call and MAX_MEMBERS overall.
  for (let hop = 0; hop < MAX_HOPS_PER_PASS; hop++) {
    const members = (await db.prepare("SELECT domain FROM campaign_members WHERE campaign_id=? ORDER BY created_at, rowid").bind(campaignId).all<{ domain: string }>()).results.map(m => m.domain).filter(d => !processed.has(d));
    if (!members.length) break;
    for (const d of members) processed.add(d);
    added += await associateFrom(campaignId, members);
  }
  return added;
}

async function associateFrom(campaignId: string, members: string[]) {
  const db = getD1();
  let added = 0;
  for (const domain of members) {
    const c = await db.prepare("SELECT * FROM inbox_candidates WHERE canonical_domain=?").bind(domain).first<Row>();
    if (!c) continue;
    const cid = String(c.id);
    // Edges from this member's own observable facts.
    if (!isSingletonKit(String(c.cluster_key ?? ""))) await addEdge(campaignId, { srcType: "site", srcKey: domain, dstType: "kit", dstKey: String(c.cluster_key), kind: "same_kit", basis: "deterministic", sourceTable: "inbox_candidates", sourceRef: cid });
    const keys = candidateKeys(c.details, c.wallets);
    const generic = new Set<string>();
    for (const [t, v] of keys) {
      if (await popularity(t, v) > GENERIC_THRESHOLD) { generic.add(`${t}:${v}`); continue; }
      await addEdge(campaignId, { srcType: "site", srcKey: domain, dstType: t === "wallet" ? "wallet" : "indicator", dstKey: t === "wallet" ? v : `${t}:${v}`, kind: t === "wallet" ? "displays_wallet" : "shares_indicator", basis: "observed", sourceTable: "inbox_candidates", sourceRef: cid });
    }
    if (c.investigation_id) {
      const inv = String(c.investigation_id);
      const mem = await db.prepare("SELECT id FROM campaign_members WHERE campaign_id=? AND domain=?").bind(campaignId, domain).first<{ id: string }>();
      if (mem) await addEdge(campaignId, { srcType: "investigation", srcKey: inv, dstType: "site", dstKey: domain, kind: "investigates", basis: "deterministic", sourceTable: "campaign_members", sourceRef: mem.id });
      await db.prepare("UPDATE campaign_members SET investigation_id=COALESCE(investigation_id,?) WHERE campaign_id=? AND domain=?").bind(inv, campaignId, domain).run();
      // Wallets a module observed in this investigation (Site Investigator, CryptoWalletLogger, Wallet Investigator).
      const wallets = await db.prepare("SELECT ie.id,e.canonical_key FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='wallet' AND ie.source_module IN ('site_investigator','crypto_wallet_logger','wallet_investigator')").bind(inv).all<{ id: string; canonical_key: string }>();
      for (const w of wallets.results) await addEdge(campaignId, { srcType: "site", srcKey: domain, dstType: "wallet", dstKey: walletKey(String(w.canonical_key).replace(/^[a-z0-9_]+:(?=\w{20,})/, "")), kind: "displays_wallet", basis: "observed", sourceTable: "investigation_entities", sourceRef: String(w.id) });
      // Module-recorded site-to-site relationships.
      const rels = await db.prepare("SELECT r.id,e.canonical_key FROM relationships r JOIN entities e ON e.id=r.target_entity_id WHERE r.investigation_id=? AND e.entity_type='site'").bind(inv).all<{ id: string; canonical_key: string }>();
      for (const r of rels.results) await addEdge(campaignId, { srcType: "site", srcKey: domain, dstType: "site", dstKey: domainOf(r.canonical_key), kind: "observed_relationship", basis: "observed", sourceTable: "relationships", sourceRef: String(r.id) });
    }
    // Expand: other candidates sharing the kit or a non-generic indicator.
    const count = Number((await db.prepare("SELECT COUNT(*) n FROM campaign_members WHERE campaign_id=?").bind(campaignId).first<{ n: number }>())?.n ?? 0);
    if (count >= MAX_MEMBERS) continue;
    const found = new Map<string, { row: Row; reason: string }>();
    if (!isSingletonKit(String(c.cluster_key ?? ""))) {
      for (const o of (await db.prepare("SELECT * FROM inbox_candidates WHERE cluster_key=? AND canonical_domain<>? LIMIT 40").bind(c.cluster_key, domain).all<Row>()).results)
        found.set(String(o.canonical_domain), { row: o, reason: `same kit as ${domain} (Site Finder template/key cluster)` });
    }
    for (const [t, v] of keys) {
      if (generic.has(`${t}:${v}`)) continue;
      const [where, needle] = keyMatch(t, v);
      for (const o of (await db.prepare(`SELECT * FROM inbox_candidates WHERE ${where} AND canonical_domain<>? LIMIT 25`).bind(needle, domain).all<Row>()).results)
        if (!found.has(String(o.canonical_domain))) found.set(String(o.canonical_domain), { row: o, reason: `shares ${t === "wallet" ? "a wallet" : t} with ${domain}` });
    }
    for (const { row, reason } of found.values()) {
      if (Number((await db.prepare("SELECT COUNT(*) n FROM campaign_members WHERE campaign_id=?").bind(campaignId).first<{ n: number }>())?.n ?? 0) >= MAX_MEMBERS) break;
      if (await addMember(campaignId, row, reason)) added++;
    }
  }
  return added;
}

export async function seedCampaign(campaignId: string, seedDomain: string) {
  const c = await getD1().prepare("SELECT * FROM inbox_candidates WHERE canonical_domain=?").bind(domainOf(seedDomain)).first<Row>();
  if (!c) throw new Error("SEED_NOT_FOUND");
  await addMember(campaignId, c, "campaign seed", "seed");
  return c;
}

export type GraphSummary = {
  nodes: number; edges: number;
  by_kind: Record<string, number>;
  repeated_indicators: Array<{ key: string; type: string; sites: string[]; edge_ids: string[] }>;
  recurring_wallets: Array<{ wallet: string; sites: string[]; edge_ids: string[] }>;
  kits: Array<{ kit: string; sites: string[]; edge_ids: string[] }>;
  convergence: Array<{ a: string; b: string; shared_kinds: string[] }>;
  unexplored_hubs: Array<{ key: string; degree: number }>;
  isolated_claims: Array<{ hypothesis_id: string; statement: string; missing_refs: string[] }>;
};

/** Loads the graph and computes the structured summary the roles (and a model) consume. */
export async function graphSummary(campaignId: string): Promise<{ summary: GraphSummary; edges: Row[] }> {
  const db = getD1();
  const edges = (await db.prepare("SELECT * FROM campaign_edges WHERE campaign_id=?").bind(campaignId).all<Row>()).results;
  const byDst = new Map<string, { type: string; sites: Set<string>; ids: string[] }>();
  const bySite = new Map<string, Set<string>>();
  const byKind: Record<string, number> = {};
  for (const e of edges) {
    byKind[String(e.kind)] = (byKind[String(e.kind)] ?? 0) + 1;
    if (e.src_type !== "site") continue;
    const k = `${e.dst_type}|${e.dst_key}`;
    const g = byDst.get(k) ?? { type: String(e.dst_type), sites: new Set<string>(), ids: [] };
    g.sites.add(String(e.src_key)); g.ids.push(String(e.id)); byDst.set(k, g);
    const s = bySite.get(String(e.src_key)) ?? new Set<string>(); s.add(`${e.kind}:${e.dst_type}|${e.dst_key}`); bySite.set(String(e.src_key), s);
  }
  const pivoted = new Set((await db.prepare("SELECT test_target FROM hypotheses WHERE campaign_id=? AND status<>'proposed'").bind(campaignId).all<{ test_target: string }>()).results.map(r => r.test_target));
  const repeated: GraphSummary["repeated_indicators"] = [], wallets: GraphSummary["recurring_wallets"] = [], kits: GraphSummary["kits"] = [], hubs: GraphSummary["unexplored_hubs"] = [];
  for (const [k, g] of byDst) {
    const key = k.split("|").slice(1).join("|");
    if (g.sites.size >= 2 && g.type === "indicator") repeated.push({ key, type: key.split(":")[0], sites: [...g.sites], edge_ids: g.ids });
    if (g.sites.size >= 2 && g.type === "wallet") wallets.push({ wallet: key, sites: [...g.sites], edge_ids: g.ids });
    if (g.type === "kit") kits.push({ kit: key, sites: [...g.sites], edge_ids: g.ids });
    const target = g.type === "kit" ? `kit:${key}` : g.type === "wallet" ? `wallet:${key}` : key;
    if (g.sites.size >= 2 && !pivoted.has(target)) hubs.push({ key: target, degree: g.sites.size });
  }
  // Convergence: two sites linked through two or more independent observable facts
  // (e.g. the same kit AND the same wallet). Divergence is the complement the
  // Reviewer uses: same kit but no other shared fact.
  const convergence: GraphSummary["convergence"] = [];
  const sites = [...bySite.keys()].slice(0, 80);
  for (let i = 0; i < sites.length && convergence.length < 20; i++) for (let j = i + 1; j < sites.length && convergence.length < 20; j++) {
    const b = bySite.get(sites[j])!;
    const shared = [...bySite.get(sites[i])!].filter(x => b.has(x));
    if (shared.length >= 2) convergence.push({ a: sites[i], b: sites[j], shared_kinds: [...new Set(shared.map(x => x.split(":")[0]))] });
  }
  const hyps = (await db.prepare("SELECT id,statement,observation_refs FROM hypotheses WHERE campaign_id=? AND status IN ('proposed','testing','supported')").bind(campaignId).all<Row>()).results;
  const ids = new Set(edges.map(e => String(e.id)));
  const isolated = hyps.map(h => ({ hypothesis_id: String(h.id), statement: String(h.statement), missing_refs: parse<string[]>(h.observation_refs, []).filter(r => !ids.has(r)) }))
    .filter(h => h.missing_refs.length || false);
  return { summary: { nodes: new Set(edges.flatMap(e => [`${e.src_type}|${e.src_key}`, `${e.dst_type}|${e.dst_key}`])).size, edges: edges.length, by_kind: byKind,
    repeated_indicators: repeated.sort((x, y) => y.sites.length - x.sites.length).slice(0, 15), recurring_wallets: wallets.slice(0, 15), kits: kits.filter(k => k.sites.length >= 1).slice(0, 15),
    convergence, unexplored_hubs: hubs.sort((x, y) => y.degree - x.degree).slice(0, 10), isolated_claims: isolated }, edges };
}

/** The graph for the UI's graph view: nodes and provenance-bearing edges, plus hypotheses as a labelled overlay. */
export async function graphForView(campaignId: string) {
  const db = getD1();
  const edges = (await db.prepare("SELECT id,src_type,src_key,dst_type,dst_key,kind,basis,source_table,source_ref FROM campaign_edges WHERE campaign_id=? LIMIT 600").bind(campaignId).all<Row>()).results;
  const members = (await db.prepare("SELECT domain,state,investigation_id FROM campaign_members WHERE campaign_id=?").bind(campaignId).all<Row>()).results;
  const hyps = (await db.prepare("SELECT id,statement,status,confidence,test_target FROM hypotheses WHERE campaign_id=?").bind(campaignId).all<Row>()).results;
  const aside = new Set((await db.prepare("SELECT target_key FROM opportunities WHERE campaign_id=? AND kind='investigate_candidate' AND status IN ('suppressed','rejected')").bind(campaignId).all<{ target_key: string }>()).results.map(r => r.target_key));
  const nodes = new Map<string, { id: string; type: string; label: string; state?: string }>();
  for (const m of members) nodes.set(`site|${m.domain}`, { id: `site|${m.domain}`, type: "site", label: String(m.domain), state: m.state === "pending" && aside.has(String(m.domain)) ? "set_aside" : String(m.state) });
  for (const e of edges) for (const [t, k] of [[e.src_type, e.src_key], [e.dst_type, e.dst_key]]) {
    const id = `${t}|${k}`; if (!nodes.has(id)) nodes.set(id, { id, type: String(t), label: String(k).length > 28 ? `${String(k).slice(0, 26)}…` : String(k) });
  }
  return { nodes: [...nodes.values()], edges: edges.map(e => ({ id: e.id, from: `${e.src_type}|${e.src_key}`, to: `${e.dst_type}|${e.dst_key}`, kind: e.kind, basis: e.basis, provenance: `${e.source_table}:${e.source_ref}` })),
    hypotheses: hyps.map(h => ({ id: h.id, statement: h.statement, status: h.status, confidence: Number(h.confidence), about: h.test_target, note: "hypothesis — reasoning, not evidence" })),
    note: "Edges are observable relationships with provenance. None of them establishes common ownership." };
}
