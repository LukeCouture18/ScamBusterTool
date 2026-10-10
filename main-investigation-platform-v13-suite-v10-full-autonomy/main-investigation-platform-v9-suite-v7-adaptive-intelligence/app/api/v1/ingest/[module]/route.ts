import { ZodError } from "zod";
import { ingest, parseIngestRequest } from "@/lib/ingestion";
import { onWalletInvestigatorBatch } from "@/lib/wallet-pipeline";
import { apiError, assertModule, authError, authorizeModule, enforceRateLimit, readJsonBody, writeAudit } from "@/lib/platform";

export async function POST(request: Request, context: { params: Promise<{ module: string }> }) {
  try {
    const { module } = await context.params;
    if (!assertModule(module)) return apiError(404, "UNKNOWN_MODULE", "Use site_finder, site_investigator, crypto_wallet_logger, or wallet_investigator.");
    await authorizeModule(request, module); await enforceRateLimit(module);
    const { payload, rejected } = parseIngestRequest(await readJsonBody(request));
    // v4: an address Wallet Investigator did not confirm (invalid, network ambiguous, unsupported, unable to validate)
    // is not a wallet. Its result is recorded on the wallet candidate, but it does not become a wallet entity in the graph.
    const v4Unconfirmed = (r: unknown) => { const w = r as { classification?: unknown; provenance?: { pipeline?: unknown } }; return w?.provenance?.pipeline === "wallet-v4" && w.classification !== "valid"; };
    const original = payload as { records?: Record<string, unknown[]>; origin_job_id?: string };
    const wallets = original.records?.wallets ?? [];
    const graphPayload = module === "wallet_investigator" && wallets.some(v4Unconfirmed) ? { ...payload, records: { ...payload.records, wallets: wallets.filter(r => !v4Unconfirmed(r)) } } as typeof payload : payload;
    const hasRecords = Object.values((graphPayload as { records?: Record<string, unknown[]> }).records ?? {}).some(v => Array.isArray(v) && v.length > 0);
    const result = hasRecords || rejected.length ? await ingest(module, graphPayload, rejected) : { status: "accepted", accepted: 0, error_count: 0, note: "validation recorded on the wallet candidate; no graph records" };
    // v4: Wallet Investigator's validation/analysis of a Logger wallet moves that wallet along its pipeline.
    if (module === "wallet_investigator" && result.status !== "failed") await onWalletInvestigatorBatch(original);
    await writeAudit(crypto.randomUUID(), module, "batch.ingest", "ingestion_batch", payload.batch_id ?? "unknown", result.status ?? "unknown", result);
    return Response.json(result, { status: result.status === "failed" ? 422 : ('replayed' in result && result.replayed) ? 200 : 202 });
  } catch (error) {
    if (error instanceof ZodError) return apiError(400, "VALIDATION_ERROR", "The ingestion payload is invalid.", error.issues);
    const handled = authError(error); if (handled) return handled;
    return apiError(500, "INGESTION_ERROR", error instanceof Error ? error.message : "Unexpected ingestion error");
  }
}

export async function OPTIONS() { return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type,x-api-key,authorization", "Access-Control-Allow-Methods": "POST,OPTIONS" } }); }
