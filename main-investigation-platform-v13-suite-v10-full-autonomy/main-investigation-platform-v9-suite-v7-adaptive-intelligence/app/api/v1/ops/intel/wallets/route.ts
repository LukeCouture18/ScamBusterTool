import { z } from "zod";
import { apiError } from "@/lib/platform";
import { multiSiteWallets } from "@/lib/ops/intel";
/** Wallets observed on more than one site. Shared wallets are a relationship, not proof of common ownership. */
export async function GET() { try { return Response.json({ wallets: await multiSiteWallets(100), note: "A wallet shown on several sites is a reason to look at them together, not proof they share an owner." }); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_WALLETS_ERROR", error instanceof Error ? error.message : "Unavailable"); } }
