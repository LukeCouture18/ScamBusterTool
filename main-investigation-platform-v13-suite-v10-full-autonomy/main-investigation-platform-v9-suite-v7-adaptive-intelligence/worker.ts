import handler from "vinext/server/fetch-handler";
import { runMaintenance } from "./lib/maintenance";
import { assertSchemaReady } from "./lib/schema-ready";

// The scheduled trigger belongs to the deployed Worker. A request to a UI
// route is not required to drain persisted work.
export default {
  async fetch(request: Request, environment: { DB?: D1Database }, context: ExecutionContext) {
    if (!environment.DB) return Response.json({ error: "DATABASE_UNAVAILABLE" }, { status: 503 });
    try { await assertSchemaReady(environment.DB); }
    catch { return Response.json({ error: "SCHEMA_UPGRADE_INCOMPLETE", recovery: "Stop workers and apply or restore ordered D1 migrations before retrying." }, { status: 503 }); }
    return handler.fetch(request, environment, context);
  },
  async scheduled(_event: ScheduledController, environment: { DB?: D1Database }, _context: ExecutionContext) {
    if (!environment.DB) throw new Error("DATABASE_UNAVAILABLE");
    await assertSchemaReady(environment.DB);
    await runMaintenance();
  },
};
