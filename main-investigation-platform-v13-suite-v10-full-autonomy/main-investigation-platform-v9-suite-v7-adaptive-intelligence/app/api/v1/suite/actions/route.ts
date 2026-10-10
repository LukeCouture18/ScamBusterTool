import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { act } from "@/lib/suite";
import { SKIP_REASONS } from "@/lib/inbox";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), domain: z.string().min(3).max(300), decision: z.enum(["useful", "skip"]), reason: z.enum(SKIP_REASONS).optional() }).strict(),
  z.object({ action: z.literal("investigate_site"), domain: z.string().min(3).max(300) }).strict(),
  z.object({ action: z.literal("find_related"), domain: z.string().min(3).max(300), reason: z.string().max(200).optional() }).strict(),
  z.object({ action: z.literal("reconstruct_operation"), domain: z.string().min(3).max(300) }).strict(),
  z.object({ action: z.literal("analyze_wallet"), wallet: z.string().min(6).max(300) }).strict(),
  z.object({ action: z.literal("prepare_report"), investigation_id: z.string().min(3).max(240) }).strict(),
]);

/**
 * The actions a person takes from the five tools. Each becomes Main's own work (inbox decision,
 * work item, reconstruction request or report candidate) under Main's scheduler, budgets,
 * approvals and deduplication. Nothing here contacts a module or a site directly.
 */
export async function POST(request: Request) {
  try {
    const body = schema.parse(await readJsonBody(request, 4096));
    const r = await act(body);
    return Response.json(r, { status: r.ok ? 202 : 409 });
  } catch (error) {
    if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid action.", error.issues);
    return apiError(500, "SUITE_ACTION_ERROR", error instanceof Error ? error.message : "Action failed");
  }
}
