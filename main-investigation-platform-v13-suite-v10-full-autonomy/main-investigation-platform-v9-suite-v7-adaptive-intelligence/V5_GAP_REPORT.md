# v5 foundation audit (source and runtime paths)

| Requirement | Finding in supplied v5 | v6 action |
| --- | --- | --- |
| Non-routing triage | Native `site.triaged` stored, but old `site.discovered` flow and uncalled orchestration rules disagree; triage has no evidence reference validation | Make a single planner evaluate explicit promotion and checked entity/evidence references |
| Event bus | Durable store and replay exist; fanout inbox is pull/ack, not server push; subscriber checkpoint is only a pending row | Retain durable poll/ack and describe it accurately; fix event ID ownership; add scoped cursor semantics where viable |
| Capability routing | Hardcoded preferred worker fallback allows jobs for unregistered modules; status health is only a ranking hint | Resolve eligible registered capabilities; leave decision pending with explicit reason when none is online |
| Jobs | Atomic claim and retry exist, but enqueue, budget check, and decision explanation are separate operations; manual API can bypass planning | Gate planned jobs through budget reservations and record decisions; add job ownership checks and approval record |
| Entity resolution | Global canonical entities and investigation links exist, but `unknown:` EVM wallet keys can split identity; cross-investigation overlap is not surfaced | Preserve network-specific identity and add cross-investigation observations; do not infer ownership |
| Evidence | Versions are immutable, yet current projections can change; quality/verification is not calculated and relationship evidence refs can arrive late | Add resolved and quality views with immutable inputs, validate graph edges and evidence provenance |
| Feedback/metrics | Registered subscriptions poll inbox; technique metrics are self-reported, not attributed to downstream yields | Add objective downstream yield records and keep raw module metrics separately |
| Form Submitter | Registered capability and report events exist; `report.ready` self-asserted flags can queue preparation; no report snapshot or verified outcome gate | Require durable analyst approval and frozen evidence snapshot; distinguish unknown/attempted outcome |
| Reliability | Migration and unit tests pass, no live v5 end-to-end validation; event processing has multi-step partial failure paths | Add database backed integration/failure tests and validate migration chain |
| UI | Integration status and orchestration exist; no full investigation workspace or plan/graph/monitoring views | Add practical case views with plan, graph, review, monitoring and evidence links where backed by data |

This audit refers to the exact v5 ZIP used as input. A v6 feature is reported as working only after a test exercises its write/read/control path.

## Cross-module audit using supplied source (2026-09-20)

| Source | Real integration gap | Corrective path |
| --- | --- | --- |
| Site Finder v0.7 | Sends v4/v5 schema 1.1 candidate batches; its old contract expects ingest to route `site.discovered`. v6 deliberately keeps discoveries passive. It supplied no public triage evidence unless a relationship was in the batch. | Bundled v0.7 copy now includes a public triage evidence record. v6 ingests it first, then emits an explicit v6 `site.triaged` with the persisted evidence ID and a bounded downstream request. The synthetic route-level test claims the job. |
| Site Finder feedback | Its context feedback attribution read `entities` without checking their contributing module, so its own wallet could be credited as downstream yield. | Bundled copy attributes entities using immutable `observation_versions` and excludes its own source. Added HMAC-verified, idempotent feedback receiver with acknowledgement; polling remains available. |
| Site Investigator v0.1 | Has local SQLite and an event outbox, but no Main Platform transport or job worker. Its `_page` SQL had 11 placeholders for a ten-column table. | Bundled copy fixes the SQL. A separate bridge claims a platform job, invokes its existing public investigator, translates actual SQLite rows, sends them through canonical ingest, and completes or retries the job. Synthetic worker and route tests pass. |
| CryptoWalletLogger v0.8 | Emits `1.0.0` camelCase events, including `deposit_option.observed` outside the canonical event catalog. Queue silently discarded oldest pending entries after 5,000; timestamp changed idempotency IDs for otherwise identical sightings. | Compatibility route maps the native wire shape to v6 ingestion, preserving passive status; bundled extension removes silent truncation, requests unlimited local storage, and excludes volatile timestamps from event IDs. Verified two-source wallet resolution and replay. |
