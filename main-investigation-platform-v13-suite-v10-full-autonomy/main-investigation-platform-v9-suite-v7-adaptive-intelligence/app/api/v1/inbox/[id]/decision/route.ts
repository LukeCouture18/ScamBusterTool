import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { decide, SKIP_REASONS } from "@/lib/inbox";

const schema = z.object({ decision: z.enum(["useful", "skip"]), reason: z.enum(SKIP_REASONS).optional() }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; const body = schema.parse(await readJsonBody(request, 4096)); return Response.json(await decide(id, body.decision, body.reason ?? null)); }
  catch (error) {
    if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Decision must be 'useful' or 'skip'.", error.issues);
    if (error instanceof Error && error.message === "INBOX_CANDIDATE_NOT_FOUND") return apiError(404, "NOT_FOUND", "Inbox candidate not found.");
    return apiError(500, "INBOX_DECISION_ERROR", error instanceof Error ? error.message : "Unable to record decision");
  }
}
