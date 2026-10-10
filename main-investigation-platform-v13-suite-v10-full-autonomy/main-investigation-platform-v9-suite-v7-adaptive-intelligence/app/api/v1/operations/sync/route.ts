import { z } from "zod";
import { apiError, authError, authorizeModule, enforceRateLimit, readJsonBody, writeAudit } from "@/lib/platform";
import { syncFromHunter } from "@/lib/ops/hunter";

const row = z.record(z.string(), z.unknown());
const schema = z.object({
  schema_version: z.enum(["1.0", "2.0"]),
  operation: z.object({ external_id: z.string().min(1).max(200) }).passthrough(),
  model: row.nullable().optional(),
  members: z.array(row).max(500).optional(),
  proposals: z.array(row).max(100).optional(),
  changes: z.array(row).max(500).optional(),
  contradictions: z.array(row).max(50).optional(),
}).strict();

/**
 * Operation Hunter delivers one operation snapshot (module key `operation_hunter`).
 * Idempotent; proposals become ordinary work items that Main's scheduler decides on.
 */
export async function POST(request: Request) {
  try {
    await authorizeModule(request, "operation_hunter"); await enforceRateLimit("operation_hunter", 240);
    const body = schema.parse(await readJsonBody(request));
    const result = await syncFromHunter(body as Parameters<typeof syncFromHunter>[0]);
    await writeAudit(crypto.randomUUID(), "operation_hunter", "operation.sync", "hunter_operation", result.operation_id, "ok", { proposals: result.proposals, changes: result.changes, contradictions: result.contradictions });
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid operation snapshot.", error.issues);
    return authError(error) ?? apiError(500, "OPERATION_SYNC_ERROR", error instanceof Error ? error.message : "Sync failed");
  }
}
