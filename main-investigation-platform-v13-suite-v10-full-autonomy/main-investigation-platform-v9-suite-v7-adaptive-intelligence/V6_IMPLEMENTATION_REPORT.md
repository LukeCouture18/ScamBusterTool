# Main Investigation Platform v6 implementation report

Base: the supplied `main-investigation-platform-v5.zip`. This is an additive source upgrade. It is not a deployed release.

## Verified functional paths

| Area | Runtime path implemented | Verification |
| --- | --- | --- |
| Site triage | Discovery stays passive; v6 promoted triage with an explicit downstream request and stored evidence enters the planner | SQLite integration test observes no job for observation/dismissal and one job for evidence-backed promotion; unsupported promotion is blocked |
| Planner | Event → decision with explanation → capability selection → budget reservation → deduplicated job | Integration test checks decisions, offline defer/reconnect, and budget exhaustion |
| State | Derives state from jobs, reviews, report candidates, monitoring and investigation status; records every changed state | Integration test checks investigating state; transition table migrates |
| Profiles and budgets | Four profile defaults; limits for jobs, wallets, related sites, depth, reported API calls/runtime | Integration test checks job budget; settings exposed through case plan endpoint |
| Approval | Deep related-site jobs await a separate gate; operator approval records decision and unlocks job | Job control and approval table wired; full browser identity attribution still outstanding |
| Expansion | Relationship event creates review candidate; approval requires two evidence items from independent source modules, checks depth/budget, and queues work | Route-level SQLite integration test approves a candidate backed by two different source modules |
| Resolution | Independently stored observation versions yield current classification/network/token view with supporting and conflicting IDs | Integration test uses conflicting values and checks resolved support |
| Evidence | Evidence insert updates a separate quality evaluation; immutable versions retained | SQL migration and write path implemented; quality is a heuristic, not a verification verdict |
| Cross-case | One global entity observed in two investigations creates an overlap without merging cases | Integration test verifies overlap; analysts can record link/separate decision |
| Monitoring | Per-entity target, due recheck, content-hash deduplicated snapshots and persisted added/removed observation, evidence and relationship version diffs | Integration test checks baseline, due tick, new observation/evidence diffs and no duplicate alert; local scheduler test checks authenticated localhost calls |
| Reports | Frozen evidence snapshot + analyst approval + form preparation job; only a reported verified receipt backed by a Form Submitter evidence item marks success | Integration test checks blocked unapproved route, candidate POST/PATCH approval, and unknown vs evidence-backed verified outcome |
| SDK | TypeScript and Python clients can read plans, graph, resolution, monitoring, reports, subscriptions, and metrics | TypeScript compilation, Python syntax, and SDK contract test |
| Migration | `0005_v6_planning.sql` is additive after v5 migration | SQLite v5→v6 retention test and local D1 migration apply |

## API additions

- `GET|PATCH /api/v1/investigations/{id}/plan`
- `GET /api/v1/investigations/{id}/graph`, `/resolve?entity_id=...`, `/timeline`, `/monitoring`, `/report`
- `POST /api/v1/investigations/{id}/monitoring`, `/report`, `/expansion`
- `PATCH /api/v1/investigations/{id}/report` (analyst approval)
- `POST /api/v1/monitoring/tick`
- `POST /api/v1/compat/logger` (native CryptoWalletLogger event adapter)
- `GET|POST /api/v1/investigation-links`
- Existing v4/v5 registration, native events, ingestion, claims, subscriptions, and metrics remain available.

## Important remaining limitations

- The v6 prompt asks for a complete intelligent platform. The package implements its core planning and evidence controls, but **is not a fully completed v6 release**. The local Worker could not be started in this environment (`uv_interface_addresses`), so no HTTP end-to-end or hosted acceptance test passed. SQLite integration directly exercises bundled production logic and SQL, but does not prove Cloudflare runtime behavior.
- Event feedback now supports signed allowlisted webhook push with durable pull/ack fallback; localhost synthetic delivery passes. Subscription fanout and planner decisions are still not one atomic transaction. Planned job insertion and budget charge are batched atomically, while a crash between event and later side effects may still need recovery.
- API-call and runtime usage are reported by modules through ingestion activity. Costs from external providers are not independently measured. A tested standalone local scheduler is included; an operator still has to run it as a service for unattended monitoring.
- The planner handles selected high-value transitions. It does not automatically infer every gap across the entire investigation graph. Expansion review requires two independent evidence sources but does not rank all candidates with a calibrated expected-value model.
- The case page shows persisted investigation sections, plan, graph relationships, review, and monitoring summaries; it does not include a graphical graph canvas or full interactive investigation controls. Review and reporting actions use the existing private Site gate; the recorded actor is `authenticated-web-operator` rather than a verified individual identity.
- Existing v4/v5 native events and ingest remain accepted for compatibility. Their legacy validation constraints are weaker than new schema 3.0. Existing ingestion still commits independent records rather than one atomic all-or-nothing transaction.
- Quality scores are heuristic; a hash's presence does not prove factual correctness or source independence. There is no formal probabilistic confidence calibration, provider cost forecasting, automated backup restore, or exhaustive multi-module hosted failure test.

These gaps are intentionally disclosed; schema presence and passing unit tests do not make them complete.

The third migration adds persisted monitoring diffs. Previously stored snapshots retain their original content and acquire an empty default diff; later snapshots compare with the preceding version. Evidence and relationship updates now refresh monitored entities as well as observation updates.

## Second-pass correction (not a completion claim)

- Planned job creation, budget counters, job event, and trigger link now use one D1 batch transaction; duplicate or exhausted work does not charge a job. The integration test checks duplicate/exhausted counters.
- Verified report events now require the **exact** approved candidate and frozen snapshot hash at preparation, and a job ID claimed by the assigned Form Submitter at outcome. A wrong-job verified event leaves the report unknown. A receipt still requires real external verification by the Form Submitter; Main Platform cannot independently validate a third-party form submission.
- Lease-exhausted events now receive durable dead-letter rows. Failure/recovery integration exercises this.
- An HTTPS allowlisted, signed, retryable feedback push path is included alongside pull/ack. Module registration can set `metadata.feedback_webhook_url`; `FEEDBACK_WEBHOOK_ALLOWLIST` and `FEEDBACK_SIGNING_KEY` must be configured. Failed or unacknowledged push attempts surface in the review queue. **Outbound delivery is verified only in an isolated localhost test** using synthetic investigation data. After the initial automatic approval rejection for an untrusted HTTPS test destination, the user explicitly authorized a loopback receiver. That test validates signatures, payload, 503 retry, stable IDs, acknowledgement, idempotency, and retry exhaustion. No real investigation data or third-party endpoint was used.
- `/api/v1/health` exposes database state, event status, jobs/retries, unacknowledged feedback, schema/heartbeat, budget headroom, and dead letters. Built successfully, but its deployed HTTP response has not been exercised.

## Inputs needed for a full v6 acceptance

All five source projects are now bundled with adaptations. Site Finder, Site Investigator, CryptoWalletLogger, the supplied Wallet Investigator engine/worker, and the supplied Form Submitter validation/storage/service are exercised locally. Hosted Cloudflare deployment, real public blockchain providers, real browser/form submission, and production credentials remain untested.

Five-module validation split: real module integration tested includes canonical IDs, provenance, entity deduplication, Wallet Investigator analysis output, reporting approval/job binding, Form Submitter validation, duplicate prevention, replay and recovery paths. Synthetic external behavior tested includes deterministic blockchain fixtures and a localhost form confirmation receiver; no investigation evidence leaves the test environment. Not tested includes real public APIs, CAPTCHA/authenticated browser flows, hosted deployment, and real reporting.
