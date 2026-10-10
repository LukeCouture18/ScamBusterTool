import { z } from "zod";
import { apiError, authError, authorizeModule, enforceRateLimit, getD1, readJsonBody } from "@/lib/platform";
import { proposalsForOperation } from "@/lib/ops/hunter";

const schema = z.object({
  kind: z.enum(["inbox_candidate", "site_check"]), canonical_key: z.string().min(1).max(400), reason: z.string().max(600).default(""),
  investigation_id: z.string().max(240).optional(), score: z.number().min(0).max(1).optional(), headline: z.string().max(300).optional(), evidence_external_id: z.string().max(240).optional(),
}).strict();

/**
 * Hunter asks Main to look at one site (analyst "send to inbox", or a delegated site check).
 * It is handled exactly like a Hunter proposal: known sites become investigation work, unknown ones inbox candidates.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorizeModule(request, "operation_hunter"); await enforceRateLimit("operation_hunter", 240);
    const ext = (await context.params).id;
    const b = schema.parse(await readJsonBody(request, 64 * 1024));
    const db = getD1();
    const proposals = await proposalsForOperation(ext, [{ key: `request:${b.kind}:${b.canonical_key}`, kind: "investigate_site", target_type: "domain", target_key: b.canonical_key, reason: b.reason || "requested by the analyst in Operation Hunter", value: 0.9, probability: b.score ?? 0.8 }]);
    if (!proposals) return apiError(404, "OPERATION_NOT_SYNCED", "Sync the operation before sending requests for it.");
    const op = await db.prepare("SELECT id FROM hunter_operations WHERE external_id=?").bind(ext).first<{ id: string }>();
    await db.prepare("INSERT OR IGNORE INTO hunter_requests (id,operation_id,external_operation_id,kind,canonical_key,reason,outcome) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(), op?.id ?? null, ext, b.kind, b.canonical_key, b.reason, JSON.stringify(proposals)).run();
    const result = { proposals };
    return Response.json({ accepted: true, proposals: result.proposals }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues);
    return authError(error) ?? apiError(500, "OPERATION_REQUEST_ERROR", error instanceof Error ? error.message : "Request failed");
  }
}
