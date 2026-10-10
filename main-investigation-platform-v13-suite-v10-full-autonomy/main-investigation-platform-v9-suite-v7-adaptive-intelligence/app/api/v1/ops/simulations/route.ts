import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { simulate } from "@/lib/ops/simulation";
import { getD1 } from "@/lib/platform";
export async function GET() { try { return Response.json({ simulations: (await getD1().prepare("SELECT id,name,source,status,result,created_at FROM simulations ORDER BY created_at DESC LIMIT 20").all()).results }); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_SIM_LIST_ERROR", error instanceof Error ? error.message : "Unavailable"); } }
/** Dry run over current state or a synthetic fixture. Every executor refuses inside a simulation. */
export async function POST(request: Request) { try { return Response.json(await simulate(await readJsonBody(request, 256 * 1024)), { status: 201 }); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_SIM_ERROR", error instanceof Error ? error.message : "Unavailable"); } }
