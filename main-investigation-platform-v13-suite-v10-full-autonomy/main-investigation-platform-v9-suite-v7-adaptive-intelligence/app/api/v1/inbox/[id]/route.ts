import { apiError } from "@/lib/platform";
import { details } from "@/lib/inbox";

/** Advanced view: evidence, scoring components, discovery path, jobs and timeline. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; const found = await details(id); return found ? Response.json(found) : apiError(404, "NOT_FOUND", "Inbox candidate not found."); }
  catch (error) { return apiError(503, "INBOX_UNAVAILABLE", error instanceof Error ? error.message : "Inbox unavailable"); }
}
