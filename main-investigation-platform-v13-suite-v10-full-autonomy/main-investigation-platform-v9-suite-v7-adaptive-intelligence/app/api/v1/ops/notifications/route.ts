import { z } from "zod";
import { apiError, readJsonBody } from "@/lib/platform";
import { listNotifications, markNotification } from "@/lib/ops/notifications";
export async function GET(request: Request) {
  try { const s = new URL(request.url).searchParams.get("status") ?? "open"; return Response.json({ notifications: await listNotifications(z.enum(["open", "read", "dismissed"]).parse(s)) }); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_NOTIFICATIONS_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
const schema = z.object({ id: z.string().min(8).max(64), status: z.enum(["read", "dismissed"]) }).strict();
export async function POST(request: Request) {
  try { const b = schema.parse(await readJsonBody(request, 512)); await markNotification(b.id, b.status); return Response.json({ ok: true }); } catch (error) { if (error instanceof z.ZodError) return apiError(400, "VALIDATION_ERROR", "Invalid request.", error.issues); return apiError(500, "OPS_NOTIFICATION_ERROR", error instanceof Error ? error.message : "Unavailable"); }
}
