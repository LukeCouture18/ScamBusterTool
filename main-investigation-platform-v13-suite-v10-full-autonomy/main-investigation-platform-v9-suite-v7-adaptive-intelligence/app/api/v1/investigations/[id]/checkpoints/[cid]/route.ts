import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { resolveCheckpoint } from "@/lib/agent/checkpoints";
const schema = z.object({ action: z.enum(["done", "cancel"]) }).strict();
/**
 * Resolve a human checkpoint. "done" marks an analyst_review complete (barriers
 * resolve on their own from new evidence, but this also lets you confirm one);
 * "cancel" stops the investigation instead of resuming into the same wall.
 * The platform never performs the human step itself.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string; cid: string }> }) {
  try {
    const { cid } = await context.params; const body = schema.parse(await readJsonBody(request, 2048));
    const result = await resolveCheckpoint(cid, body.action === "cancel" ? "cancelled" : "analyst_confirmed");
    if (!result) return apiError(404, "NOT_FOUND", "Open checkpoint not found.");
    return Response.json({ checkpoint_id: cid, resolution: result });
  } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "action must be 'done' or 'cancel'.", error.issues); return apiError(500, "CHECKPOINT_ERROR", error instanceof Error ? error.message : "Unable to resolve"); }
}
