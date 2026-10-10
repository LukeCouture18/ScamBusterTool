import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { getSettings, updateSettings } from "@/lib/inbox";

const schema = z.object({
  target_depth: z.number().int().min(1).max(200).optional(), min_score: z.number().min(0).max(1).optional(),
  investigate_on_useful: z.boolean().optional(), find_related_on_useful: z.boolean().optional(),
  discovery_http_budget: z.number().int().min(10).max(5000).optional(), max_discovery_jobs_per_day: z.number().int().min(0).max(500).optional(),
  lease_minutes: z.number().int().min(1).max(240).optional(),
}).strict();

export async function GET() { try { return Response.json(await getSettings()); } catch (error) { return apiError(503, "INBOX_UNAVAILABLE", error instanceof Error ? error.message : "Unavailable"); } }
export async function PATCH(request: Request) {
  try { return Response.json(await updateSettings(schema.parse(await readJsonBody(request, 4096)))); }
  catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid inbox settings.", error.issues); return apiError(500, "INBOX_SETTINGS_ERROR", error instanceof Error ? error.message : "Unable to save"); }
}
