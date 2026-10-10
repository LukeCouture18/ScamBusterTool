import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { runCommand } from "@/lib/ops/commands";
const schema = z.object({ text: z.string().min(1).max(500), confirm: z.unknown().optional() }).strict();
/**
 * Natural-language command. It compiles into one typed intent with a fixed
 * effect (read / queue work / pause-resume) and goes through the same work
 * items, Reviewer, budgets and policies as everything else.
 */
export async function POST(request: Request) {
  try { const b = schema.parse(await readJsonBody(request, 4096)); return Response.json(await runCommand(b.text, { confirm: b.confirm })); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_COMMAND_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
