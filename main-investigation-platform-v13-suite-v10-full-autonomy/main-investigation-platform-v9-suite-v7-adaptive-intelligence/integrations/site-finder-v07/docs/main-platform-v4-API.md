# Main Investigation Platform API v4

Base path: `/api/v1`. JSON requests use `Content-Type: application/json`. The recommended ingestion schema is `1.1`; `1.0` remains accepted for existing connectors.

## Authentication

Each module has a distinct key configured in `MODULE_API_KEYS`. Send that module's key as `X-API-Key` or `Authorization: Bearer <key>`. Requests fail closed when a module key is absent. Unattended clients calling a private Sites deployment must also send `OAI-Sites-Authorization: Bearer <Sites bypass token>` to pass the deployment sign-in gate.

## Module workflow

Every tool can use the v4 event workflow while the v3-compatible ingestion workflow remains available:

1. `POST /api/v1/modules/{module}/register` with capabilities and accepted event types.
2. `POST /api/v1/modules/{module}/heartbeat` while the worker is available.
3. Publish native results to `POST /api/v1/events`, or use `POST /api/v1/ingest/{module}`.
4. `POST /api/v1/modules/{module}/jobs/claim` and report progress/results with the job endpoint.

Job types are `INVESTIGATE_SITE`, `LOG_WALLET_ACTIVITY`, `ANALYZE_WALLET`, `FIND_RELATED_SITES`, and `RECHECK_TARGET`. Statuses are `pending`, `running`, `retrying`, `needs-review`, `completed`, and `failed`. Failed work retries with capped exponential backoff. Active work is deduplicated by job type, investigation, target entity, and target module; claiming uses an atomic lease so two workers cannot claim the same job.

## Endpoints

- `POST /api/v1/events` (publish up to 250 idempotent events)
- `GET /api/v1/events` (event activity, filters, and dead-letter count)
- `POST /api/v1/events/{id}/replay` (operator replay)
- `POST /api/v1/modules/{module}/register` (capability discovery)
- `POST /api/v1/ingest/site_finder`
- `POST /api/v1/ingest/site_investigator`
- `POST /api/v1/ingest/crypto_wallet_logger`
- `POST /api/v1/ingest/wallet_investigator`
- `POST /api/v1/modules/{module}/heartbeat`
- `POST /api/v1/modules/{module}/jobs/claim`
- `PATCH /api/v1/modules/{module}/jobs/{id}`
- `POST /api/v1/jobs` (create or deduplicate work)
- `GET /api/v1/investigations/{id}/context` (hydrate a worker with shared context)
- `POST /api/v1/evidence/upload` (multipart, 25 MB maximum)
- `GET /api/v1/dashboard`
- `GET /api/v1/integration/status`

## Ingestion envelope

```json
{
  "schema_version": "1.1",
  "batch_id": "si-run-2026-09-18-001",
  "sent_at": "2026-09-18T14:30:00Z",
  "origin_job_id": "optional-claimed-job-uuid",
  "records": {
    "investigations": [], "sites": [], "related_sites": [],
    "pages": [], "deposit_pages": [], "wallets": [], "deposit_options": [],
    "transactions": [], "counterparties": [], "tokens": [], "networks": [],
    "infrastructure_indicators": [], "relationships": [], "evidence": [],
    "discovery_paths": [], "findings": [], "notes": [], "module_activity": []
  }
}
```

All records require a stable `external_id`. Common optional fields are `investigation_id`, `canonical_key`, `display_name`, `confidence` (0–1), `classification`, `observed_at`, and `provenance`. Unknown fields are preserved in the source observation. Wallet, token, transaction, and counterparty identity is network-scoped. Site identity normalizes to the hostname; page identity normalizes URLs.

Schema 1.1 relationships require `evidence_ids`. A relationship includes `relationship_type`, `from`, `to`, `assertion_kind` (`observed`, `blockchain_fact`, or `derived`), and supporting evidence IDs. Evidence includes `evidence_type`, `evidence_class`, `observation_scope`, `context_text`, and `title`. Uploaded binaries may be referenced using the returned stable evidence ID and URI.

## Deduplication, merges, and failures

`source_module + record_type + external_id` identifies one source observation. Resubmitting it updates only that module's observation. `entity_type + canonical_key` identifies the shared entity enriched by all modules. Evidence versions are immutable, and one module cannot overwrite another module's evidence. `source_module + batch_id` makes a complete batch idempotent.

Top-level envelope errors reject the request. Record errors are isolated: valid records are committed, bad records enter the dead-letter queue, and the response is `partial`. Responses report received, inserted, updated, duplicate, and error counts. Standard errors use `{"error":{"code","message","details"},"request_id"}`. Clients should retry `429` and transient `5xx` responses with exponential backoff and reuse the same batch ID.

## SDKs

Ready-to-copy clients are included in `sdk/typescript` and `sdk/python`. Both support registration, heartbeat, event publishing, compatibility ingestion, job claiming, progress/results, investigation context, and retry/backoff.

## Event-driven routing

The durable event schema is `1.0`. Every event has a stable `event_id`, `event_type`, `correlation_id`, optional `causation_event_id`, investigation/entity references, source module, UTC occurrence time, provenance, payload, and hop count. Supported events are `site.discovered`, `site.investigated`, `wallet.observed`, `wallet.validated`, `wallet.analyzed`, `evidence.added`, and `relationship.discovered`.

Events are persisted before processing. Reusing an event ID is idempotent. Processing attempts, exponential backoff, delivery state, dead letters, and replay counters survive restarts. Capability routing selects a healthy registered worker when available and otherwise leaves durable work queued for the expected module. A `wallet.validated` event from Site Investigator or CryptoWalletLogger routes directly to `wallet:analyze`; CryptoWalletLogger is not a prerequisite.

Every automatic job records its triggering event and correlation ID. The Orchestration page exposes the event stream and a **Why Triggered?** view. Raw observations, immutable observation versions, evidence versions, blockchain facts, derived observations, and analyst notes remain separate. Conflicts create review items rather than overwriting original observations.

## Investigation Orchestrator

The platform now routes validated discoveries through the durable pipeline `Site Finder → Site Investigator → CryptoWalletLogger → Wallet Investigator`. Jobs remain in D1 across platform and module restarts. A worker claims only work assigned to its module, whose approval requirement is satisfied, whose dependencies are complete, and whose pipeline is running.

- `GET /api/v1/orchestration` — pipelines, stages, scheduled jobs, timeline, alerts, review queue, profiles, and rules
- `PATCH /api/v1/orchestration/pipelines/{id}` — `pause`, `resume`, or `cancel`
- `PATCH /api/v1/orchestration/jobs/{id}` — `pause`, `resume`, `cancel`, `approve`, `reject`, or `retry`
- `PATCH /api/v1/orchestration/reviews/{id}` — `resolve` or `dismiss`
- `GET|PATCH /api/v1/orchestration/config` — inspect or update thresholds, priorities, approvals, and freshness windows
- `GET /api/v1/search?q=...&investigation_id=...` — unified entity search across canonical data and original observations

Investigations may include `profile_id` with `quick-triage`, `standard-investigation`, or `deep-investigation`. If omitted, low priority selects Quick Triage, high priority selects Deep Investigation, and other work uses Standard Investigation.

Each queued job includes `trigger_reason`, the matched rule, pipeline/stage IDs, dependency state, and the automation safety policy. Automatic jobs never authorize credential guessing, brute-force activity, CAPTCHA/MFA bypass, or financial transactions. A module may use only credentials explicitly supplied for that specific target through its existing authorized configuration.

Completed analyses establish a freshness window. Matching discoveries inside that window produce a timeline explanation instead of duplicate work. Expired worker leases are recovered on the next claim and either retried or moved to review after the attempt limit.
