import { apiError } from "@/lib/platform";
import { nextCandidate } from "@/lib/inbox";

/** The single next candidate (leased so two tabs don't show the same one). */
export async function GET() {
  try { return Response.json(await nextCandidate(), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return apiError(503, "INBOX_UNAVAILABLE", error instanceof Error ? error.message : "Inbox unavailable"); }
}
