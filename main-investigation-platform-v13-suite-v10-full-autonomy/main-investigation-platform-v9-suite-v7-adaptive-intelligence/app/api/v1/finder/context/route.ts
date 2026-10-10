import { apiError, authError, authorizeModule, enforceRateLimit, getD1 } from "@/lib/platform";

/**
 * Module-authenticated feed for Site Finder's discovery memory: the sites Main and Operation
 * Hunter already hold, so Finder uses them as pivot seeds instead of spending a person's review
 * slot on them again. Incremental by `since` (an updated_at timestamp returned as `next_since`).
 *
 * Only site identities and where they are held are shared: no evidence, no conclusions. Site
 * Finder's own deliveries are left out (Finder already knows them).
 */
type Row = Record<string, unknown>;

export async function GET(request: Request) {
  try {
    await authorizeModule(request, "site_finder"); await enforceRateLimit("site_finder", 120);
    const url = new URL(request.url);
    const since = (url.searchParams.get("since") ?? "").slice(0, 40) || "1970-01-01 00:00:00";
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") ?? 1000) || 1000));
    const db = getD1();
    const rows: Array<{ domain: string; source: string; state: string; at: string }> = [];
    const add = (list: Row[], source: string, state: (r: Row) => string) => { for (const r of list) rows.push({ domain: String(r.domain).toLowerCase(), source, state: state(r), at: String(r.at) }); };
    add((await db.prepare("SELECT canonical_domain domain,source_module,decision,updated_at at FROM inbox_candidates WHERE updated_at>? AND source_module<>'site_finder' ORDER BY updated_at LIMIT ?").bind(since, limit).all<Row>()).results,
      "main", r => r.decision ? `decided:${String(r.decision)}` : `inbox:${String(r.source_module)}`);
    add((await db.prepare("SELECT e.canonical_key domain,e.updated_at at FROM entities e WHERE e.entity_type='site' AND e.updated_at>? AND NOT EXISTS (SELECT 1 FROM inbox_candidates c WHERE c.canonical_domain=e.canonical_key AND c.source_module='site_finder') ORDER BY e.updated_at LIMIT ?").bind(since, limit).all<Row>()).results,
      "main", () => "investigated");
    try {
      add((await db.prepare("SELECT m.canonical_key domain,m.role,m.updated_at at FROM hunter_operation_members m WHERE m.entity_type='site' AND m.role IN ('member','seed') AND m.updated_at>? ORDER BY m.updated_at LIMIT ?").bind(since, limit).all<Row>()).results,
        "hunter", r => `operation_${String(r.role)}`);
    } catch { /* a database without the Hunter migration has no members to share */ }
    const known = [...new Map(rows.filter(r => r.domain && r.domain.includes(".")).map(r => [r.domain, r])).values()].slice(0, limit);
    const nextSince = rows.reduce((m, r) => (r.at > m ? r.at : m), since);
    return Response.json({ known: known.map(({ domain, source, state }) => ({ domain, source, state })), next_since: nextSince, count: known.length });
  } catch (error) {
    return authError(error) ?? apiError(500, "FINDER_CONTEXT_ERROR", error instanceof Error ? error.message : "Unavailable");
  }
}
