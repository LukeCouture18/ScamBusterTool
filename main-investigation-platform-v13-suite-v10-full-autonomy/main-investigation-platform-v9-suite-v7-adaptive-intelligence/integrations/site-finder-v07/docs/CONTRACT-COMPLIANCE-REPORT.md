# Main Platform Contract Compliance Report

Contract: **Main Investigation Platform API v4** (`docs/main-platform-v4-API.md`).
Client: the platform's own `sdk/python/main_investigation_client.py`, vendored
**byte-for-byte and unmodified** at
`app/integration/v4/main_investigation_client.py`.

Site Finder defines **no endpoint, event type, field, identifier, status value
or schema rule of its own.**

## Conformance

| Contract element | Status | Notes |
|---|---|---|
| Module name `site_finder` | ✅ | from `lib/platform.ts SOURCE_MODULES` |
| Auth `X-API-Key` / `Bearer` | ✅ | via the vendored SDK |
| `OAI-Sites-Authorization` | ✅ | `MAIN_PLATFORM_SITES_TOKEN` |
| `POST /modules/{m}/register` | ✅ | capabilities `site:discover`, `site:relate`; schema `1.0` |
| `POST /modules/{m}/heartbeat` | ✅ | schema `1.1`; 409 handled as incompatible, not as an outage |
| `POST /ingest/site_finder` | ✅ | schema `1.1`; primary channel |
| `POST /events` | ✅ | envelope validated locally against `.strict()` before sending |
| `POST /modules/{m}/jobs/claim` | ✅ | 204 handled as "no work", not an error |
| `PATCH /modules/{m}/jobs/{id}` | ✅ | progress / complete / fail / needs-review |
| `GET /investigations/{id}/context` | ✅ | also the feedback channel |
| `GET /integration/status` | ✅ | surfaced in the Platform view |
| Batch idempotency (`module + batch_id`) | ✅ | batch id hashes batch *content*, so retries reuse it as API.md requires |
| Observation identity (`module + type + external_id`) | ✅ | external ids derive from facts, never timestamps |
| Entity identity (`entity_type + canonical_key`) | ✅ | `normalize_canonical_key` transcribed from `lib/domain.mjs` |
| Schema 1.1 relationship `evidence_ids` | ✅ | refused locally before sending if absent |
| `assertion_kind` | ✅ | always `derived` — Site Finder concludes links by comparing observations |
| `evidence_class` enum | ✅ | `observed_website` / `derived_observation` only |
| Retry on 429 / transient 5xx | ✅ | SDK's own policy, plus per-batch backoff on `retryDelaySeconds` |
| Record limits (1000/batch, 250 events) | ✅ | checked locally |
| Automation policy enforcement | ✅ | jobs demanding credentials, auth or financial actions return `needs-review` |

## Event types produced

Only from `lib/events.ts EVENT_TYPES`, and only indirectly — the ingestion
adapter publishes them with the entity ids it mints:

`site.discovered` · `wallet.observed` · `relationship.discovered` ·
`evidence.added`

Site Finder never publishes `site.investigated`, `wallet.validated` or
`wallet.analyzed`: those belong to modules that actually crawl or trace.

## Record types produced

`investigations`, `sites`, `related_sites`, `wallets`,
`infrastructure_indicators`, `relationships`, `evidence`, `discovery_paths`,
`findings`, `notes`, `module_activity`.

Not produced: `pages`, `deposit_pages`, `transactions`, `counterparties`,
`tokens`, `networks` — those require capabilities Site Finder does not have and
should not gain.

## Verification

`tests/test_v4_integration_e2e.py` (36 tests) runs the **real** path: the
vendored SDK makes every call with its own headers, retry policy and error
handling; only its urllib is pointed at a reference platform implementing the
v4 route handlers. There is no test-only client and no test-only wire format.

## Non-compliance

None. Five things the contract cannot express are recorded in
`CONTRACT-GAP-REPORT.md` with the in-contract workaround used for each. **No
private event, field or endpoint was invented.**
