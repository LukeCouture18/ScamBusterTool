import { apiError } from "@/lib/platform";
import { markOpened } from "@/lib/inbox";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; return (await markOpened(id)) ? Response.json({ ok: true }) : apiError(404, "NOT_FOUND", "Inbox candidate not found."); }
  catch (error) { return apiError(500, "INBOX_ERROR", error instanceof Error ? error.message : "Unable to record"); }
}
