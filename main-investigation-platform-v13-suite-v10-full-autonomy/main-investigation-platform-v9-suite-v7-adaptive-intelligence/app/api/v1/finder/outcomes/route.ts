import { apiError, assertModule, authError, authorizeModule, enforceRateLimit, getD1 } from "@/lib/platform";
/**
 * Module-authenticated feed of downstream outcomes for Site Finder's v3
 * learning loop: not just useful/skip, but meaningful/wallet evidence, dead
 * sites, auth barriers, duplicates and completed investigations. Every row's
 * `basis` is observed, deterministic or human — never AI inference.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const targetModule = url.searchParams.get("module") ?? "site_finder";
    if (!assertModule(targetModule) || targetModule === "platform") return apiError(400, "UNKNOWN_MODULE", "Unknown module.");
    await authorizeModule(request, targetModule); await enforceRateLimit(targetModule);
    const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 200)));
    const rows = await getD1().prepare("SELECT seq,canonical_domain,finder_candidate_id,outcome,basis,detail,created_at FROM finder_outcomes WHERE seq>? ORDER BY seq LIMIT ?").bind(after, limit).all<Record<string, unknown>>();
    const outcomes = rows.results.map(r => ({ seq: Number(r.seq), domain: String(r.canonical_domain), finder_candidate_id: r.finder_candidate_id ? String(r.finder_candidate_id) : null, outcome: String(r.outcome), basis: String(r.basis), detail: (() => { try { return JSON.parse(String(r.detail)); } catch { return {}; } })(), at: String(r.created_at) }));
    return Response.json({ outcomes, next_cursor: String(outcomes.length ? outcomes[outcomes.length - 1].seq : after) });
  } catch (error) { return authError(error) ?? apiError(500, "FINDER_OUTCOMES_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
