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

## v5 additive contract

See [V5.md](V5.md) for v5 event routing, non-routing triage, subscriptions, metrics, reporting prerequisites, and migration instructions. v4 API/event clients remain accepted. The event contract version for new clients is `2.0`.

## v2 investigation inbox

The primary UI (`/`) is an inbox: NEXT SITE → OPEN SITE → SKIP / USEFUL → next. Detailed evidence, scoring components and discovery paths stay behind **Details** and on the investigation pages. The full v6 dashboard moved to `/overview`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/inbox` | Waiting count, the "in progress" list (candidates you marked USEFUL and how far evidence collection has got) and running precision. |
| GET | `/api/v1/inbox/next` | The single next candidate, leased for `lease_minutes` so two tabs never show the same one. Card fields only: `id, domain, url, headline, category, related_count, score`. Also tops up supply. |
| GET | `/api/v1/inbox/{id}` | Advanced view: score components, signals, discovery strategies, fetch facts, related (hidden) domains, public deposit addresses, jobs and timeline. |
| POST | `/api/v1/inbox/{id}/opened` | Records that you opened the site. |
| POST | `/api/v1/inbox/{id}/decision` | `{decision: "useful"|"skip", reason?: "dead_or_parked"|"not_a_scam"|"duplicate"|"not_crypto"|"not_useful"}`. USEFUL publishes a platform-originated `site.triaged` (promoted, `request_downstream=true`) so the planner routes `INVESTIGATE_SITE` through its normal budget/capability/freshness checks, and queues `FIND_RELATED_SITES` for Site Finder. SKIP publishes a non-routing `dismissed` triage, cancels not-yet-started jobs for that site, and hides waiting candidates from the same cluster. Idempotent. |
| GET | `/api/v1/inbox/decisions?module=site_finder&after=&limit=` | Module-authenticated (`X-API-Key`). Decisions in order with `next_cursor`; Site Finder uses it to steer discovery. |
| POST | `/api/v1/inbox/supply` | Queues `DISCOVER_SITES` for Site Finder when fewer than `target_depth` candidates are waiting (also run by the scheduled trigger, on NEXT and on every decision). Capped per day. |
| GET/PATCH | `/api/v1/inbox/settings` | `target_depth`, `min_score`, `investigate_on_useful`, `find_related_on_useful`, `discovery_http_budget`, `max_discovery_jobs_per_day`, `lease_minutes`. |

Inbox delivery happens during ordinary Site Finder ingestion: a schema 3.0 `sites[]` record with `triage.outcome = "promoted"` and an `inbox` passthrough block (version `"2"`) becomes an inbox candidate. The platform deduplicates by registrable domain, suppresses a candidate whose cluster already has a shown member unless it carries a new deposit address, suppresses candidates related to one you skipped, and suppresses sites that already have evidence from another module. Migration `0008_inbox_v2` adds `inbox_candidates`, `inbox_decisions` and `inbox_settings`; nothing existing changes.

## v3 AI investigator

An AI layer above the deterministic platform. It plans one approved action at a
time through typed capabilities, executes it via the existing module job path,
evaluates the result, pauses for human-only steps, and stops within budgets.
Model output is untrusted structured input, validated by deterministic policy
before anything happens; the AI never writes evidence or a module database, and
never handles credentials, logins, CAPTCHA/MFA, or funds. It runs a
deterministic planner unless `AI_PROVIDER` is configured (Anthropic, OpenAI,
Google, or any OpenAI-compatible local server).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/investigations/{id}/agent` | Simple view: status/phase, one-line headline, plain-language activity stream, and any open human step. |
| GET | `/api/v1/investigations/{id}/agent/advanced` | Full audit: every step and rejection, budgets, model calls, AI inferences (opinion, with citations, never evidence), analyst conclusions, knowledge-class counts, provenance note. |
| POST | `/api/v1/investigations/{id}/agent/start` | Start (or resume) the single active run and take one step. Auto-started on inbox USEFUL when `auto_start_on_useful`. |
| POST | `/api/v1/investigations/{id}/agent/stop` | Stop the run; in-flight module jobs finish, the loop does not resume. |
| POST | `/api/v1/investigations/{id}/agent/conclusion` | `{conclusion, cited_evidence?}` — record a human analyst conclusion (its own knowledge class; citations validated against this investigation's evidence). |
| POST | `/api/v1/investigations/{id}/checkpoints/{cid}` | `{action: "done"|"cancel"}`. Barriers also resolve automatically when new evidence shows the human step happened; `cancel` stops the run. |
| GET/PATCH | `/api/v1/agent/settings` | `enabled`, `auto_start_on_useful`, and budgets: `max_actions`, `max_duration_seconds`, `max_discovery_expansions`, `max_module_calls`, `max_model_calls`, `max_model_tokens`, `max_retries`, `max_low_value_steps`. |
| GET | `/api/v1/finder/outcomes?module=site_finder&after=&limit=` | Module-authenticated (`X-API-Key`). Downstream outcomes (meaningful/wallet evidence, dead site, auth barrier, duplicate, completed, low evidence) with `next_cursor`, each with `basis` in `observed`/`deterministic`/`human`. Site Finder v3 folds these into its discovery allocation. An AI inference never appears here. |

Migration `0009_ai_investigator_v3` adds `agent_runs`, `agent_steps`,
`agent_model_calls`, `human_checkpoints`, `agent_inferences`,
`analyst_conclusions`, `memory_facts`, `finder_outcomes` and `agent_settings`;
nothing existing changes. Capabilities the AI may use:
`site.investigate`, `wallet.analyze`, `discovery.find_related`,
`discovery.request`, `infrastructure.analyze`, `sites.compare`,
`evidence.inspect`, `memory.search`, `report.request_draft`, `human.request`,
`investigation.conclude`.

## v4 campaigns

A campaign coordinates many investigations around a seed site. It associates sites through observable links, ranks every piece of safe work with a deterministic priority engine, tests hypotheses with bounded Site Finder pivots, and has a Reviewer challenge each action. It then runs the v3 investigator or a typed pivot job.

Model help is optional and untrusted:

- the planner may choose among near-tied opportunities, by id only;
- a strategist may propose hypotheses, which are validated against existing edges;
- a reviewer may add rejections.

Campaign graph edges are written only from observed or deterministic rows, with provenance. The AI cannot create one, and a hypothesis never becomes an edge.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/campaigns` | Campaign list: status, what it is doing, member count. |
| POST | `/api/v1/campaigns` | `{seed_domain, title?, auto_associate?, budgets?}`. Starts a campaign around an inbox site and runs its first tick. Returns `201 {id,status,doing}`, or `404 SEED_NOT_FOUND` if the site is not in the inbox. |
| GET | `/api/v1/campaigns/{id}` | Simple view: `status`, `doing`, `why`, `progress`, `findings`, `human_tasks`, `next_up`, `budget`, `headline_numbers`, `can`. |
| POST | `/api/v1/campaigns/{id}/control` | `{action: "pause"\|"resume"\|"stop"}`. Pause and stop also pause or stop the campaign's own v3 runs; stop cancels its queued pivots. |
| PATCH | `/api/v1/campaigns/{id}/budget` | Any of `max_investigations`, `max_parallel`, `max_discovery_requests`, `max_module_jobs`, `max_model_calls`, `max_model_tokens`, `max_duration_seconds`. Out-of-range values return `400`. Raising a spent budget resumes a BUDGET_EXHAUSTED campaign. |
| GET | `/api/v1/campaigns/{id}/tasks` | Everything that needs a person: open checkpoints in member investigations and report approvals. |
| GET | `/api/v1/campaigns/{id}/graph` | `nodes`, and `edges` each with `kind`, `basis` and `provenance` (`table:row`). Hypotheses are returned as a separate overlay, plus an ownership disclaimer. |
| GET | `/api/v1/campaigns/{id}/advanced` | Economics (cost per useful investigation, useful evidence per action), the opportunity queue with every factor, role traces (typed artifacts), hypothesis histories, costs, experience statistics, provenance counts and raw jobs. |

**Settings.** `/api/v1/agent/settings` also accepts two booleans:

- `campaign_model_strategist` (default `true`);
- `campaign_model_reviewer` (default `false`).

**Site Finder pivot jobs.** A `FIND_RELATED_SITES` job whose payload carries `pivot: {kind, value}` is a campaign hypothesis test.

- `kind` is one of `ip`, `ns`, `san`, `favicon`, `favtmpl`, `service`, `wallet`, `kit`.
- The payload also carries `campaign_id`, `hypothesis_id`, `opportunity_id`, `context`, `exclude`, `requested` and `automation_policy`.
- Site Finder v4 answers with `{new_candidates, shared, saturated, arms, effort}`.
- The platform re-verifies every claimed site against its own records before any hypothesis confidence changes.
- Jobs without `pivot` behave as before.

Migration `0010_campaigns_v4` adds these tables and changes nothing existing: `campaigns`, `campaign_members`, `campaign_edges`, `opportunities`, `hypotheses`, `campaign_artifacts`, `experience` and `campaign_costs`.


## v5 · Operations (`/api/v1/ops/*`)

Operator routes (same protection as the other operator routes). Every action goes through typed work items, the scheduler's Reviewer, budgets and module policies; none starts module work directly.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/ops/overview` | Operations home: state, running/next work with reasons, campaigns, discoveries, findings, human tasks, throughput, budgets, AI activity |
| GET / POST | `/ops/queue?status=&kind=&campaign=` | Global opportunity queue; POST `{id, action: "retry"\|"cancel"}` |
| GET | `/ops/work/:id` | One work item with its event history |
| POST | `/ops/control` | `{scheduler?: "pause"\|"resume", discovery?: "pause"\|"resume"\|"pause_low_priority"}` |
| POST | `/ops/tick` | Run one scheduler tick now (the cron trigger does this continuously) |
| GET | `/ops/intel/graph?types=&kinds=&min_strength=&since_days=&campaign=&focus=type:key&depth=&limit=` | Bounded, filtered subgraph; every edge carries basis and provenance |
| GET | `/ops/intel/node/:id` | Node links with provenance, history, evidence, campaigns, gaps, reasoning links, confidence history |
| GET | `/ops/intel/wallets` | Wallets observed on more than one site |
| GET | `/ops/history?type=domain&key=` | Facets, snapshots and changes of one entity |
| GET | `/ops/gaps?investigation=&campaign=&status=` | Evidence gaps |
| GET | `/ops/tasks` | Unified Human Tasks (checkpoints, reviews, contradictions, report approvals) |
| POST | `/ops/contradictions/:id` | `{resolution: "resolved"\|"dismissed", note}` |
| GET / POST | `/ops/notifications` | List; POST `{id, status: "read"\|"dismissed"}` |
| POST | `/ops/commands` | `{text, confirm?}` → typed intent; model-compiled changes return `needs_confirmation` |
| GET | `/ops/decisions/:id` | AI decision record (visible state, schema, proposal, policy, model calls, replays) |
| POST | `/ops/decisions/:id/replay` | `{provider?, tier?}` developer replay; executes nothing, not charged to budgets |
| GET / POST | `/ops/simulations` | Dry run `{name, source: "history"\|"fixture", ticks, fixture?}`; executes nothing |
| GET / POST | `/ops/experiments`, POST `/ops/experiments/:id` | Bounded strategy experiments; `{action: "stop"}` |
| GET / POST | `/ops/budgets` | Daily limits `{scope: "global"\|"module:<name>"\|"provider:<name>", kind, max}` |
| GET | `/ops/campaigns/:id` | Campaign workspace: goal, gaps, queue, timeline, contradictions, activity |
| GET | `/ops/investigations`, `/ops/discovery`, `/ops/advanced` | Investigations list, discovery view, advanced telemetry |

Site Finder: `DISCOVER_SITES` jobs with `payload.mode = "continuous"` run a v5 continuous-discovery cycle. Inbox blocks may carry `site_status` and `nameservers` from Site Finder's change watch; re-deliveries use a new batch id per watch revision.


## Main suite v6 operation intelligence

Apply additive migration `0017_operation_intelligence.sql` after all existing migrations. Hunter inference remains in Operation Hunter; Main stores evidence references and operation memory.

- `GET /api/v1/operations/{id}/intelligence?view=site|wallet|infrastructure|timeline&cursor={relationship_id}&limit=100`: bounded briefing, hypotheses, challenges, timeline, source investigations, reports, overlapping-operation review candidates, and historical boundary lineage. IDs accept either Main's UUID or Hunter's external ID. `limit` must be an integer from 1 to 200.
- `GET /api/v1/operations/{id}/intelligence/connections/{relationship_id}`: authoritative relationship, original evidence, collection provenance and applicable wallet validation status.
- `GET /api/v1/operations/{id}/intelligence/evidence/{evidence_id}`: source evidence referenced by this operation's graph or hypotheses; unrelated evidence returns 404.
- `POST /api/v1/operations/{id}/intelligence`: evaluate a bounded portfolio slice under the existing pause flag, leases and resource policy. Does not bypass module availability or report approval.
- `POST /api/v1/operations/{id}/decisions`: propose with `{action:"propose",kind:"associate"|"exclude"|"split"|"consolidate",entity_ids:[...],reason:"...",target_operation_id?:"..."}`. Consolidation requires a target. Returns the exact review hash and boundary revisions. Confirm with `{action:"confirm",decision_id:"...",review_hash:"..."}`. Stale revisions/hashes return 409. Proposals do not mutate boundaries.

Observed reuse, transactions, templates and infrastructure do not establish ownership. Graph context nodes are not inferred members. Source site reports retain exact `content_sha256` approval. Split/consolidation preserves source records and history links. Default hunt policy is eight reservations per operation, four active operation hunts across the portfolio and 24 new operation hunts per UTC day, in addition to v5's resource allowances.

Run `npm run test:operation-intelligence`; set `HUNTER_DIR` to the sibling Hunter directory if needed. Python is resolved through `MIP_PYTHON` or the existing portable interpreter resolver. Production smoke: build, configure the normal module credentials and `.dev.vars`, then run `tests/operation-production-browser.py` with Playwright installed. The smoke test uses synthetic source records and a local worker only.
