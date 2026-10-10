# Shared integration clients

Both clients implement API-key authentication, optional private-Site bypass authentication, exponential retry with jitter, capability registration, heartbeats, event publication, compatibility ingestion, job claiming, progress/result reporting, and investigation context retrieval.

TypeScript: `sdk/typescript/src/client.ts`  
Python: `sdk/python/main_investigation_client.py`

Keep module keys separate. Each standalone program configures its own module name, module API key, platform base URL, and—when calling the private hosted Site—Sites bypass token. Without these values the standalone program continues to operate independently.

Claimed jobs now include pipeline stage, priority, dependency, freshness, approval, trigger explanation, and `automation_policy` metadata. Every module must enforce that policy: use only credentials explicitly configured for the specific target, never guess credentials or bypass CAPTCHA/MFA, and never execute a financial transaction. Heartbeat with `current_job_id` while working so the platform can extend the lease and distinguish a slow job from a disconnected worker.

For v4 modules, call `register` once at startup, heartbeat while running, and publish stable, idempotent event IDs. A module may still use `ingest`; the compatibility adapter persists its records and emits the corresponding v4 events automatically. Site Investigator and CryptoWalletLogger may both publish `wallet.validated`, which routes directly to any healthy module advertising `wallet:analyze`.

## v5

The TypeScript and Python clients support `pendingEvents`/`pending_events`, `acknowledgeEvent`/`acknowledge_event`, `submitMetrics`/`submit_metrics`, and `getMetrics`/`get_metrics`. Register `supported_event_types` to opt into durable feedback. See `V5.md` at the project root for routing and migration details.

## v6 canonical contract

`contracts/v6.json` is the portable machine-readable contract; `typescript/src/contracts.ts` is the server and TypeScript event catalog. Module teams can run `node --test tests/v6-contract.test.mjs` from the platform source before shipping. Use event/schema `3.0` for new modules. The platform accepts older event `1.0`/`2.0` and ingest `1.0`/`1.1` during migration. Use module API keys for the module endpoints. The operator-only plan/report/approval endpoints require the private application's sign-in gate; do not expose them as public APIs.

## v6 feedback webhook (optional)

Register `metadata.feedback_webhook_url` using an HTTPS origin present in the platform's `FEEDBACK_WEBHOOK_ALLOWLIST`. Verify the `X-Platform-Signature` HMAC SHA-256 against the raw request bytes using the provisioned `FEEDBACK_SIGNING_KEY`, deduplicate on `X-Platform-Delivery-Id`, then acknowledge with `POST /api/v1/modules/{module}/events/{delivery_id}`. A 2xx webhook response means delivered, not acknowledged: the platform retries until acknowledgement or five attempts and surfaces exhaustion for review. Existing polling remains compatible.

For synthetic localhost testing only, set `FEEDBACK_ALLOW_LOOPBACK_HTTP=true` and allowlist the exact `http://127.0.0.1:<port>` origin. Outside that explicit test setting, webhooks require an allowlisted HTTPS origin. The bundled test creates an ephemeral loopback server and contains no real investigation evidence.

CryptoWalletLogger v0.8 uses its original `1.0.0` envelope; configure its endpoint as `/api/v1/compat/logger`. Site Finder v0.7 continues schema 1.1 ingestion; when its public triage includes a corresponding evidence record, the platform emits a v6 promotion. Site Investigator v0.1 is paired with `integrations/site_investigator_bridge.py`.
