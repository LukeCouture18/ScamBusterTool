# Operation Hunter ⇄ Main Platform v5 · Operations — integration contract (v2.0)

Module name `operation_hunter`; authentication `x-api-key` = the `operation_hunter` entry of Main's `MODULE_API_KEYS`. Main migration `0012_operation_hunter.sql` must be applied (the schema gate refuses to start without it).

**Division of labour.** Main coordinates: it decides what to reconstruct, runs site and wallet investigations through its modules, owns budgets, temporal reactions, human tasks, notifications and reports. Hunter reconstructs and pursues operations and keeps their living model. Hunter never executes work in Main; it *proposes*, and Main turns proposals into its own work items.

## Main → Hunter

| Mechanism | Detail |
|---|---|
| Work kind `reconstruct_operation` (module `operation_hunter`, budget `module_jobs`, slot limit `module_limit:operation_hunter` = 1) | Proposed by the scheduler (`auto_reconstruct`, default on, only while Hunter heartbeats) for campaigns with ≥ `reconstruct_min_sites` (2) sites and no reconstruction, and for sites where Site Investigator / CryptoWalletLogger observed a wallet; or by an operator (`POST /api/v1/operations/reconstruct {campaign_id \| domain \| operation_id}`). |
| Job `HUNT_OPERATION` → `operation_hunter` (capability `operation:reconstruct`) | Payload `{ seed:{type,value}, seeds:[…], campaign_id?, title, reason, budget, work_item_id, automation_policy }`. Hunter attaches to an operation that already contains the seed (or matches it by fingerprint) or creates one, adds all seeds, links the campaign, starts a pursuit, and completes the job with `{operation_id, operation_code, action, run_id, ui_url}`. Main's reconciliation scores it from the members Hunter later reports (≥3 → useful 1, 2 → 0.6, else 0.2). |
| Module events (`GET …/modules/operation_hunter/events`, ack `POST …/events/{delivery}`) | `site.discovered`, `site.triaged`, `site.investigated`, `wallet.*`, `evidence.added`, `relationship.discovered`, `investigation.updated`: enrich operations containing the entity; new sites are checked for reappearance. |
| Inbox decisions (`GET /api/v1/inbox/decisions?module=operation_hunter`) | Decisions on Hunter-sent sites feed strategy learning; a SKIP with reason `not_a_scam` / `not_crypto` on a site Hunter counts as a member becomes a `not_member` verdict (membership calibration). |

## Hunter → Main

| Call | Detail |
|---|---|
| `POST /api/v1/modules/operation_hunter/register`, `…/heartbeat` | capabilities `operation:hunt`, `operation:reconstruct`, `operation:reappearance`, `operation:monitor`, `operation:model`. |
| `POST /api/v1/ingest/operation_hunter` (schema 3.0) | Sent before each sync when the operation has a Main investigation. Operations with ≥2 member sites and no linked investigation get one (`investigations` record, external id `hunter-op:<id>`, description carries the attribution boundary; `autoInvestigation`, default on). Records: member `sites` (confidence = membership probability, provenance lists the reasons), operation `wallets`, infrastructure indicators, evidence (`hunter:<id>`, SHA-256), relationships with `evidence_ids`, top findings. Batch id `hunter:<op>:r<revision>` (idempotent). |
| `POST /api/v1/operations/sync` (schema 2.0) | `operation` (headline, narrative, confidence, depth, stats, pursuit, `top_findings` with why / uncertainty / does-not-prove / next, `campaign_id`, `ui_url`), `model` (status active/rotating/dormant/dark, reason, counts, forecast, competing explanations with discriminating test, unknowns, version, last change, next leads), `members` (sites with role, probability, lifecycle state and strongest reason; operation wallets with role), `proposals`, `changes`, `contradictions`. Idempotent: the same snapshot twice changes nothing. |
| `proposals[]` | `investigate_site` (member sites that are live/unknown, only once the operation has a Main investigation) → an existing candidate gets `investigate_candidate` work; an unknown site becomes an inbox candidate (`source_module = operation_hunter`, cluster `hunter:<op>`, in the operation's investigation, disclaimer in `details`) plus work; a site a person skipped is refused. `analyze_wallet` (collection / splitter / treasury) → `analyze_wallet` work on the wallet entity. Anything else is recorded as not actionable. Outcomes are stored in `hunter_proposals` and shown in the campaign's Operation tab. |
| `changes[]` | Current `status` (live / dead / suspended), `ip` and `nameservers` of member sites observed since the last delivered sync → Main `observeFacet` (source `hunter_operations`). |
| `contradictions[]` | Open contradictions with severity ≥ 0.6 → Main `recordContradiction` (kind `hunter_<kind>`) → a human task. |
| `POST /api/v1/operations/{hunter op id}/requests` | Analyst "send to Main" / delegated site check: handled exactly like an `investigate_site` proposal. |
| `GET /api/v1/search`, `GET /api/v1/investigations/{id}/context` | `MAIN_LOOKUP` pivot and event enrichment. |

Delivery goes through Hunter's durable SQLite outbox (coalesced per operation, exponential backoff, dead-letter after 12 attempts); Hunter keeps working while Main is unreachable. Demo operations are synced only when "Also sync demo operations" is on, are marked `is_demo`, and never create work in Main.

## Main read models and UI

- `GET /api/v1/operations`, `GET /api/v1/operations/{id}` — reconstructions, members (with why), proposals and what Main did with each.
- Operations home: **Reconstructed operations** card (state, counts, next wave, strongest discoveries, links to the campaign and to Hunter).
- Campaign workspace: **Operation** tab (model summary, competing explanations, discoveries, inferred members, proposals → platform outcome) with **Reconstruct with Operation Hunter** when none exists.

Every surface repeats that membership is Hunter's inference and that shared infrastructure, kits or wallets are not proof of common ownership.
