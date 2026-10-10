import { z } from "zod";
import { apiError, assertModule, authError, authorizeModule, enforceRateLimit, readJsonBody } from "@/lib/platform";
import { setModuleDestination } from "@/lib/wallet-pipeline";

/**
 * v4: the submitting module (Form Submitter) reports where an approved report would be submitted.
 * Reports bind their approval to this destination; when it changes, unsubmitted reports need a new approval.
 */
const schema = z.object({ kind: z.string().min(1).max(40), form_id: z.string().max(200).optional(), form_url: z.string().max(2048).optional(), version_hash: z.string().max(200).optional(), title: z.string().max(300).optional() }).strict();
export async function POST(request: Request, context: { params: Promise<{ module: string }> }) {
  try {
    const { module } = await context.params;
    if (!assertModule(module) || module !== "form_submitter") return apiError(404, "UNKNOWN_MODULE", "Only the submitting module reports a destination.");
    await authorizeModule(request, module); await enforceRateLimit(module);
    const result = await setModuleDestination(module, schema.parse(await readJsonBody(request, 16384)));
    return Response.json({ accepted: true, ...result });
  } catch (error) {
    if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid destination.", error.issues);
    return authError(error) ?? apiError(500, "DESTINATION_ERROR", error instanceof Error ? error.message : "Unable to record destination");
  }
}
