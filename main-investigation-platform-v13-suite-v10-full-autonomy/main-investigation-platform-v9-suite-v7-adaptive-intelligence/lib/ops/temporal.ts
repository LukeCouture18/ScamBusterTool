/**
 * Temporal intelligence: entity -> observation -> timestamp -> change -> opportunity.
 *
 * Every observation of a facet (a site's status, IP, name servers, certificate
 * names, whether a deposit page is visible, the wallets it shows, related
 * domains, template) goes through `observeFacet`:
 *
 *   - first time:          stored as the current value; not a change
 *   - same value again:    only `last_seen_at` / `observations` move. This is
 *                          NOT new evidence and creates nothing.
 *   - a different value:   a snapshot and a typed change are written, and a
 *                          significant change creates (or re-scores) a work item.
 *
 * If the previous value came from a different source only moments earlier, the
 * disagreement is recorded as a contradiction instead of a change: two sources
 * disagreeing is not the world changing.
 */
import { getD1 } from "../platform";
import { hash, parse, stable, iso, ts, type Row } from "./common";

// `wallets` is what modules observed on the site; `wallets_public` is what Site Finder saw on
// the public page. They are separate facets: a deeper look finding more is not a change.
export type Facet = "status" | "ip" | "nameservers" | "certificate" | "deposit_page" | "wallets" | "wallets_public" | "related" | "template" | "favicon";
export type Observation = { subjectType: string; subjectKey: string; facet: Facet; value: unknown; sourceTable: string; sourceRef: string; observedAt?: string };
export type ObserveResult = { outcome: "first" | "unchanged" | "changed" | "disagreement"; changeId?: string; changeKind?: string; contradictionId?: string };

/** Sources observing within this many seconds of each other are treated as simultaneous. */
export const DISAGREEMENT_WINDOW_S = 3600;

function changeKind(facet: Facet, from: unknown, to: unknown): { kind: string; significance: number } {
  switch (facet) {
    case "status":
      if (from === "live" && (to === "dead" || to === "gone")) return { kind: "site_disappeared", significance: 0.6 };
      if ((from === "dead" || from === "gone") && to === "live") return { kind: "site_returned", significance: 0.8 };
      return { kind: "status_changed", significance: 0.4 };
    case "ip": case "nameservers": return { kind: "infrastructure_changed", significance: 0.55 };
    case "certificate": return { kind: "certificate_changed", significance: 0.5 };
    case "deposit_page": return to ? { kind: "deposit_appeared", significance: 0.85 } : { kind: "deposit_disappeared", significance: 0.5 };
    case "wallets": case "wallets_public": {
      const a = new Set(Array.isArray(from) ? from.map(String) : []), b = Array.isArray(to) ? to.map(String) : [];
      return { kind: "wallet_changed", significance: b.some(w => !a.has(w)) ? 0.9 : 0.4 };
    }
    case "related": {
      const a = new Set(Array.isArray(from) ? from.map(String) : []), b = Array.isArray(to) ? to.map(String) : [];
      return b.some(d => !a.has(d)) ? { kind: "related_domain_appeared", significance: 0.7 } : { kind: "related_changed", significance: 0.2 };
    }
    default: return { kind: `${facet}_changed`, significance: 0.3 };
  }
}

export async function observeFacet(o: Observation): Promise<ObserveResult> {
  const db = getD1();
  const at = o.observedAt ?? iso();
  const text = stable(o.value);
  const h = await hash(text);
  const cur = await db.prepare("SELECT * FROM entity_facets WHERE subject_type=? AND subject_key=? AND facet=?").bind(o.subjectType, o.subjectKey, o.facet).first<Row>();
  if (!cur) {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO entity_facets (subject_type,subject_key,facet,value_hash,value,source_table,source_ref,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(o.subjectType, o.subjectKey, o.facet, h, text, o.sourceTable, o.sourceRef, at, at),
      db.prepare("INSERT INTO entity_snapshots (id,subject_type,subject_key,facet,value_hash,value,source_table,source_ref,observed_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), o.subjectType, o.subjectKey, o.facet, h, text, o.sourceTable, o.sourceRef, at),
    ]);
    return { outcome: "first" };
  }
  if (cur.value_hash === h) {
    // The same fact seen again: freshness, not evidence.
    await db.prepare("UPDATE entity_facets SET last_seen_at=?,observations=observations+1 WHERE subject_type=? AND subject_key=? AND facet=?").bind(at, o.subjectType, o.subjectKey, o.facet).run();
    return { outcome: "unchanged" };
  }
  const from = parse<unknown>(cur.value, null), to = parse<unknown>(text, null);
  // A different source saying something else almost simultaneously is a disagreement, not a change.
  const differentSource = String(cur.source_table) !== o.sourceTable;
  const { getNum } = await import("./common");
  const windowS = await getNum("disagreement_window_seconds", DISAGREEMENT_WINDOW_S);
  const simultaneous = windowS > 0 && Math.abs(ts(at) - ts(cur.last_seen_at)) <= windowS * 1000;
  // Only facets with one true value at a time can disagree; seeing MORE wallets or related
  // domains than another source did is additional observation, not a conflict.
  const exclusive = ["status", "ip", "nameservers", "certificate"].includes(o.facet);
  if (differentSource && simultaneous && exclusive) {
    const { recordContradiction } = await import("./contradictions");
    const c = await recordContradiction({ kind: "providers_disagree", subjectType: o.subjectType, subjectKey: o.subjectKey,
      aRef: `${cur.source_table}:${cur.source_ref}`, bRef: `${o.sourceTable}:${o.sourceRef}`, aValue: cur.value as string, bValue: text,
      detail: `${cur.source_table} and ${o.sourceTable} report different ${o.facet} for ${o.subjectKey} at nearly the same time`, importance: o.facet === "wallets" ? 0.8 : 0.5 });
    return { outcome: "disagreement", contradictionId: c.id };
  }
  const ck = changeKind(o.facet, from, to);
  const changeId = crypto.randomUUID();
  await db.batch([
    db.prepare("UPDATE entity_facets SET value_hash=?,value=?,source_table=?,source_ref=?,last_seen_at=?,observations=observations+1 WHERE subject_type=? AND subject_key=? AND facet=?").bind(h, text, o.sourceTable, o.sourceRef, at, o.subjectType, o.subjectKey, o.facet),
    db.prepare("INSERT INTO entity_snapshots (id,subject_type,subject_key,facet,value_hash,value,source_table,source_ref,observed_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), o.subjectType, o.subjectKey, o.facet, h, text, o.sourceTable, o.sourceRef, at),
    db.prepare("INSERT INTO entity_changes (id,subject_type,subject_key,facet,change_kind,from_value,to_value,significance,source_table,source_ref,detected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(changeId, o.subjectType, o.subjectKey, o.facet, ck.kind, cur.value, text, ck.significance, o.sourceTable, o.sourceRef, at),
  ]);
  const { onChange } = await import("./reactions");
  await onChange({ id: changeId, subjectType: o.subjectType, subjectKey: o.subjectKey, facet: o.facet, kind: ck.kind, significance: ck.significance, from, to, sourceTable: o.sourceTable, sourceRef: o.sourceRef });
  return { outcome: "changed", changeId, changeKind: ck.kind };
}

/** Facets derived from a Site Finder inbox candidate (its public, passive observation). */
export async function observeCandidate(c: Row) {
  const d = parse<Row>(c.details, {});
  const keys = (Array.isArray(d.keys) ? d.keys as unknown[] : []).filter((k): k is [string, string] => Array.isArray(k) && k.length === 2).map(k => [String(k[0]), String(k[1])] as [string, string]);
  const of = (t: string) => keys.filter(([k]) => k === t).map(([, v]) => v);
  const domain = String(c.canonical_domain), ref = String(c.id);
  const out: ObserveResult[] = [];
  const obs = async (facet: Facet, value: unknown) => out.push(await observeFacet({ subjectType: "domain", subjectKey: domain, facet, value, sourceTable: "inbox_candidates", sourceRef: ref }));
  if (of("ip").length) await obs("ip", of("ip"));
  const ns = of("ns").length ? of("ns") : Array.isArray(d.nameservers) ? (d.nameservers as unknown[]).map(String) : [];
  if (ns.length) await obs("nameservers", ns);
  if (of("san").length) await obs("certificate", of("san"));
  if (of("favtmpl").length) await obs("template", of("favtmpl"));
  const wallets = parse<string[]>(c.wallets, []).map(w => w.toLowerCase());
  if (wallets.length) await obs("wallets_public", wallets);
  const related = parse<string[]>(c.related_domains, []);
  if (related.length) await obs("related", related);
  if (d.site_status) await obs("status", String(d.site_status));
  return out;
}

/** Facets derived from what modules observed in an investigation (Site Investigator, CryptoWalletLogger, Wallet Investigator). */
export async function observeInvestigation(investigationId: string) {
  const db = getD1();
  const cand = await db.prepare("SELECT canonical_domain FROM inbox_candidates WHERE investigation_id=?").bind(investigationId).first<Row>();
  if (!cand) return [];
  const domain = String(cand.canonical_domain);
  const ev = (await db.prepare("SELECT id,evidence_type,source_module FROM evidence WHERE investigation_id=? AND source_module IN ('site_investigator','crypto_wallet_logger') ORDER BY rowid").bind(investigationId).all<Row>()).results;
  const out: ObserveResult[] = [];
  if (ev.length) {
    const last = String(ev[ev.length - 1].id);
    const pages = ev.filter(e => ["page_text", "screenshot", "wallet_display", "deposit_page"].includes(String(e.evidence_type)));
    const errors = ev.filter(e => /(^|_)error$/.test(String(e.evidence_type)));
    const status = pages.length ? "live" : errors.length ? "dead" : null;
    if (status) out.push(await observeFacet({ subjectType: "domain", subjectKey: domain, facet: "status", value: status, sourceTable: "evidence", sourceRef: last }));
    out.push(await observeFacet({ subjectType: "domain", subjectKey: domain, facet: "deposit_page", value: ev.some(e => ["wallet_display", "deposit_page"].includes(String(e.evidence_type))), sourceTable: "evidence", sourceRef: last }));
  }
  const failed = await db.prepare("SELECT id,last_error FROM jobs WHERE investigation_id=? AND job_type IN ('INVESTIGATE_SITE','RECHECK_SITE') AND status='failed' ORDER BY rowid DESC LIMIT 1").bind(investigationId).first<Row>();
  if (!ev.length && failed && /(dns|name or service|nxdomain|refused|timed? ?out)/i.test(String(failed.last_error ?? "")))
    out.push(await observeFacet({ subjectType: "domain", subjectKey: domain, facet: "status", value: "dead", sourceTable: "jobs", sourceRef: String(failed.id) }));
  const wallets = (await db.prepare("SELECT DISTINCT e.canonical_key,ie.id FROM investigation_entities ie JOIN entities e ON e.id=ie.entity_id WHERE ie.investigation_id=? AND e.entity_type='wallet' AND ie.source_module IN ('site_investigator','crypto_wallet_logger')").bind(investigationId).all<Row>()).results;
  if (wallets.length) out.push(await observeFacet({ subjectType: "domain", subjectKey: domain, facet: "wallets", value: wallets.map(w => String(w.canonical_key).replace(/^[a-z0-9_]+:(?=\w{20,})/, "").toLowerCase()), sourceTable: "investigation_entities", sourceRef: String(wallets[wallets.length - 1].id) }));
  return out;
}

export async function history(subjectType: string, subjectKey: string) {
  const db = getD1();
  const [facets, changes] = await Promise.all([
    db.prepare("SELECT facet,value,first_seen_at,last_seen_at,observations,source_table,source_ref FROM entity_facets WHERE subject_type=? AND subject_key=? ORDER BY facet").bind(subjectType, subjectKey).all<Row>(),
    db.prepare("SELECT * FROM entity_changes WHERE subject_type=? AND subject_key=? ORDER BY detected_at DESC LIMIT 50").bind(subjectType, subjectKey).all<Row>(),
  ]);
  return { facets: facets.results.map(f => ({ ...f, value: parse(f.value, null) })), changes: changes.results.map(c => ({ ...c, from_value: parse(c.from_value, null), to_value: parse(c.to_value, null) })) };
}
