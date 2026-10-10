import { z } from "zod";
import { apiError, getD1, json, readJsonBody } from "@/lib/platform";
import { timeline } from "@/lib/orchestrator";
const schema = z.object({ conclusion: z.string().min(3).max(2000), cited_evidence: z.array(z.string().min(1).max(240)).max(20).default([]) }).strict();
/** Record a human analyst conclusion (kept as its own knowledge class, never as evidence or AI inference). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const db = getD1(); const inv = await db.prepare("SELECT id FROM investigations WHERE id=? OR external_id=?").bind((await context.params).id, (await context.params).id).first<{ id: string }>();
    if (!inv) return apiError(404, "NOT_FOUND", "Investigation not found.");
    const body = schema.parse(await readJsonBody(request, 8192));
    if (body.cited_evidence.length) {
      const rows = await db.prepare(`SELECT id FROM evidence WHERE investigation_id=? AND id IN (${body.cited_evidence.map(() => "?").join(",")})`).bind(inv.id, ...body.cited_evidence).all<{ id: string }>();
      const known = new Set(rows.results.map(r => r.id)); const bad = body.cited_evidence.filter(id => !known.has(id));
      if (bad.length) return apiError(400, "UNKNOWN_EVIDENCE", `Cited evidence not in this investigation: ${bad.join(", ")}`);
    }
    const id = crypto.randomUUID();
    await db.prepare("INSERT INTO analyst_conclusions (id,investigation_id,conclusion,cited_evidence,author) VALUES (?,?,?,?,'analyst')").bind(id, inv.id, body.conclusion, json(body.cited_evidence)).run();
    await timeline({ investigationId: inv.id, sourceModule: "platform", eventType: "analyst.conclusion", title: "Analyst conclusion recorded", detail: body.conclusion.slice(0, 200) });
    return Response.json({ id }, { status: 201 });
  } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid conclusion.", error.issues); return apiError(500, "CONCLUSION_ERROR", error instanceof Error ? error.message : "Unable to record"); }
}
