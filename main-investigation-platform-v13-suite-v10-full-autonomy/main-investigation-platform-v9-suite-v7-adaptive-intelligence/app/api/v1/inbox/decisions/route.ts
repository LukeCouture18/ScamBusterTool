import { apiError, assertModule, authError, authorizeModule, enforceRateLimit } from "@/lib/platform";
import { decisionsSince } from "@/lib/inbox";

/** Module-authenticated feed of inbox decisions, for Site Finder's learning loop. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const targetModule = url.searchParams.get("module") ?? "site_finder";
    if (!assertModule(targetModule) || targetModule === "platform") return apiError(400, "UNKNOWN_MODULE", "Unknown module.");
    await authorizeModule(request, targetModule); await enforceRateLimit(targetModule);
    return Response.json(await decisionsSince(url.searchParams.get("after") ?? "", Number(url.searchParams.get("limit") ?? 100)));
  } catch (error) { return authError(error) ?? apiError(500, "INBOX_DECISIONS_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
