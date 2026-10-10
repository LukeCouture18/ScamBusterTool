import { z } from "zod";
import { apiError, authError, authorizeModule, enforceRateLimit, getD1, readJsonBody } from "@/lib/platform";

/**
 * Site Finder reports its hunts (module key `site_finder`): bounded lines of inquiry with a plain
 * title, state, what they found and why they stopped. Main displays them in Site Finder · Hunts.
 * Idempotent: a hunt's row is replaced by its latest report.
 */
const hunt = z.object({
  id: z.string().min(1).max(200), kind: z.string().max(40), title: z.string().max(300), state: z.enum(["active", "parked", "exhausted", "done"]),
  operation: z.string().max(200).nullish(), found: z.number().int().min(0).max(1e6).default(0), useful: z.number().int().min(0).max(1e6).default(0),
  leads: z.number().int().min(0).max(1e7).default(0), searches: z.number().int().min(0).max(1e7).default(0),
  open_pivots: z.number().int().min(0).max(1e6).default(0), followed_pivots: z.number().int().min(0).max(1e6).default(0),
  stop_reason: z.string().max(400).default(""), value: z.number().min(-1e6).max(1e6).default(0),
}).passthrough();
const schema = z.object({ hunts: z.array(hunt).max(200) }).strict();

export async function POST(request: Request) {
  try {
    await authorizeModule(request, "site_finder"); await enforceRateLimit("site_finder", 120);
    const body = schema.parse(await readJsonBody(request, 400_000));
    const db = getD1();
    const stmts = body.hunts.map(h => db.prepare(`INSERT INTO finder_hunts (id,kind,title,state,operation,found,useful,leads,searches,open_pivots,followed_pivots,stop_reason,value,reported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,state=excluded.state,
      operation=excluded.operation,found=excluded.found,useful=excluded.useful,leads=excluded.leads,searches=excluded.searches,open_pivots=excluded.open_pivots,
      followed_pivots=excluded.followed_pivots,stop_reason=excluded.stop_reason,value=excluded.value,reported_at=CURRENT_TIMESTAMP`)
      .bind(h.id, h.kind, h.title, h.state, h.operation ?? null, h.found, h.useful, h.leads, h.searches, h.open_pivots, h.followed_pivots, h.stop_reason, h.value));
    if (stmts.length) await db.batch(stmts);
    return Response.json({ accepted: stmts.length }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid hunts report.", error.issues);
    return authError(error) ?? apiError(500, "FINDER_HUNTS_ERROR", error instanceof Error ? error.message : "Unable to store hunts");
  }
}
