import { apiError } from "@/lib/platform";
import { stats, waitingCount, working } from "@/lib/inbox";

/** Inbox overview: how many are waiting, what is in progress, and the running precision. */
export async function GET() {
  try { return Response.json({ waiting: await waitingCount(), working: await working(), stats: await stats(), generated_at: new Date().toISOString() }); }
  catch (error) { return apiError(503, "INBOX_UNAVAILABLE", error instanceof Error ? error.message : "Inbox unavailable"); }
}
