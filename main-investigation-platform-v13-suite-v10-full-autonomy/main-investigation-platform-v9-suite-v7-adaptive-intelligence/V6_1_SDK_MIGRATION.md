# SDK migration checkpoint

## Final Site Finder status

Site Finder now emits canonical schema 3.0 passive observations and typed triage objects, receives signed push feedback, records neutral technique/campaign outcomes, and applies the persisted outcome to future allocation. The old 1.x/v4 adapter remains only for explicitly negotiated legacy input and is no longer the production Site Finder path.

The combined Site Finder distribution now imports `sdk.python.main_investigation_client` for transport and advertises ingestion, event, and registration schema 3.0. A vendored fallback is retained for standalone installations. It continues to use the existing durable local outbox and compatibility adapter for triage; do not remove either until a canonical first-class triage publish path is tested through ingestion, routing, and feedback.

Other module clients still contain local transport logic. Their retries, replay, offline queue, heartbeat, registration, and idempotency have not all been replaced by a single SDK implementation. Migration of those clients remains required before contract freeze.

The Finder reference-platform harness now accepts a schema 3.0 shared SDK client and legacy versions for its historical fixtures. The three-module platform test sends a Finder schema 3.0 batch and verifies persisted promotion/job routing; fully replacing the private triage adapter remains release blocking.
