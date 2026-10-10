# Canonical integration contract — current status

## Frozen release clarification

Schema 3.0 Site Finder records use the shared `triage` representation. `request_downstream=false` is a durable observation only; an evidence-backed `promoted` outcome with `request_downstream=true` may route work. Module-result ingestion accepts either the canonical internal investigation ID carried by platform jobs or the stable external investigation ID carried by module-originated records, resolving both to one stored investigation.

All direct event publishing uses `{ source_module, events: [...] }`. Form Submitter lifecycle events and Wallet Investigator outbox events use this same envelope and preserve event, job, correlation, entity, investigation, evidence, and idempotency context.

The existing machine-readable catalog is `sdk/contracts/v6.json`; `sdk/typescript/src/contracts.ts` exposes the native event names. The active major wire schema is **3.0**, API path namespace is `/api/v1`, and legacy 1.0/2.0 events and 1.0/1.1 ingest remain accepted explicitly. This is **not frozen as v6.1**: duplicated constants remain in module packages.

Each native event has `event_id`, `event_type`, `schema_version`, optional `correlation_id`, `causation_event_id`, `investigation_id`, `entity_id`, `occurred_at`, `provenance`, `payload`, and bounded `hop_count`. Ingest has `schema_version`, `batch_id`, `sent_at`, `origin_job_id`, and typed record arrays. Module API authentication is the per-module `X-API-Key`; compatibility must be negotiated during registration. Never treat an observed EVM address or site triage as proof of wrongdoing or chain ownership. IDs and evidence provenance must survive the module boundary.

Outstanding freeze work: generate module bindings from one authoritative schema, verify evidence-reference ownership and correlation integrity, cover all five real module handlers through one joined test, establish upgrade compatibility matrix and semantic versioning, and publish a stable SDK release.

The Site Finder schema 3.0 three-module test now produces schema 3.0 ingestion-derived events. The Wallet Investigator outbox requires a positive `/api/v1/events` acceptance before its durable row becomes `DELIVERED`. The contract is **not frozen**, because module-local definitions and the legacy Finder triage adapter still coexist.
