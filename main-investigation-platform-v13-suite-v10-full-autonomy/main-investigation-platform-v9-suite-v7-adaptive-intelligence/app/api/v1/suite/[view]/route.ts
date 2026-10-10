import { apiError } from "@/lib/platform";
import { finder, home, hunter, logger, reports, site, wallet, walletPipeline, wallets } from "@/lib/suite";

/**
 * Read models for the unified suite: GET /api/v1/suite/{home|finder|site|wallets|wallet|logger|reports|hunter}.
 * `site` takes ?domain=, `wallet` takes ?id= (entity id, canonical key or bare address).
 */
export async function GET(request: Request, context: { params: Promise<{ view: string }> }) {
  try {
    const { view } = await context.params;
    const url = new URL(request.url);
    switch (view) {
      case "home": return Response.json(await home());
      case "finder": return Response.json(await finder());
      case "site": { const r = await site(url.searchParams.get("domain") ?? ""); return r ? Response.json(r) : apiError(404, "NOT_FOUND", "Give a site name Main knows (for example example.com)."); }
      case "wallets": return Response.json(await wallets(Number(url.searchParams.get("limit") ?? 80)));
      case "wallet": { const r = await wallet(url.searchParams.get("id") ?? ""); return r ? Response.json(r) : apiError(404, "NOT_FOUND", "Main has no record of this wallet."); }
      case "logger": return Response.json(await logger(Number(url.searchParams.get("limit") ?? 60)));
      case "reports": return Response.json(await reports());
      case "hunter": return Response.json(await hunter(url.searchParams.get("op")));
      case "wallet-pipeline": { const r = await walletPipeline(url.searchParams.get("investigation_id"), url.searchParams.get("domain")); return r ? Response.json(r) : apiError(404, "NOT_FOUND", "No investigation for this site yet. Open the site with the Logger running, or mark it useful in Site Finder."); }
      default: return apiError(404, "UNKNOWN_VIEW", "Unknown suite view.");
    }
  } catch (error) {
    return apiError(500, "SUITE_VIEW_ERROR", error instanceof Error ? error.message : "Unavailable");
  }
}
