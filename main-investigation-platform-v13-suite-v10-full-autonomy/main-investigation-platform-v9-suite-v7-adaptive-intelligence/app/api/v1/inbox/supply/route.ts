import { apiError } from "@/lib/platform";
import { maintainSupply } from "@/lib/inbox";

/** Queues DISCOVER_SITES for Site Finder when the inbox is below its target depth (also run by the scheduled trigger). */
export async function POST() {
  try { return Response.json(await maintainSupply()); }
  catch (error) { return apiError(500, "INBOX_SUPPLY_ERROR", error instanceof Error ? error.message : "Unable to plan discovery"); }
}
