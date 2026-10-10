# Platform v5 · Autonomous Investigation Operations — Implementation Report

> Naming: the repository already contains `V5.md` and migration `0004_v5*` from the original
> "v5 additive contract". To avoid clobbering them, this release is **Platform v5 · Operations**:
> migration `0011_operations_v5.sql`, docs `V5_OPERATIONS_*.md`, code under `lib/ops/`.

v4 decided what was worth investigating *inside one campaign a person started*. v5 runs the whole
system continuously:

**Observe → Discover → Prioritize → Campaign → Investigate → Correlate → Learn → Monitor → Revisit**

The v4 rule is unchanged everywhere and is enforced in code, not in prompts:

> AI proposes → deterministic policy validates → specialized modules execute → evidence records reality → outcomes improve future decisions.

## What was preserved

| v4 property | Where it lives in v5 |
| --- | --- |
| Deterministic authority, typed capability registry | Unchanged `lib/agent/capabilities.ts`. All v5 work is a closed set of 15 typed **work-item kinds** (`lib/ops/workitems.ts`), and the executor maps each kind onto existing machinery only (`lib/ops/executor.ts`). |
| Provenance | Every graph edge, campaign edge, experience row, gap and change cites an existing source row. `addIntelEdge` refuses AI basis, unlisted tables and missing rows. |
| Campaign intelligence, hypotheses, Reviewer | v4 campaigns run unchanged as `campaign_step` work. Their Reviewer now also consults platform budgets. |
| Adaptive Site Finder learning | Unchanged; v5 adds continuous cycles on top (`app/v2/continuous.py`). |
| Budgets and human checkpoints | Campaign budgets unchanged; v5 adds global, module and provider daily budgets. Checkpoints are v3's, surfaced in one Human Tasks queue. |
| Restart/recovery, duplicate/loop prevention | Leases, fingerprints and adoption of orphaned jobs and runs (`lib/ops/health.ts`, `lib/ops/scheduler.ts`). |
| Module contracts | No frozen module changed (see the test report). Site Finder is the only module changed, and only additively. |

## Architecture (new code: `lib/ops/*`, `lib/ai/router.ts`, `app/api/v1/ops/*`, `components/ops/*`)

### 1. Global intelligence layer — `lib/ops/intel.ts`
- **One graph across all investigations and campaigns.**
  - Nodes: domains, wallets, IPs, name servers, certificates, templates/kits, favicons, public identifiers, investigations, campaigns, evidence.
  - It is built incrementally, with cursors, from rows the platform already trusts: Site Finder candidates, module-observed wallets, module relationships, evidence and campaign membership.
- **Strength and generic nodes.**
  - Edge strength combines independent sources: 1 − Π(1 − wᵢ). A link that is no longer observed has its strength halved.
  - An infrastructure node shared by more than 25 domains is marked **generic** (a CDN or big host) and links nothing.
- **Hypotheses stay separate.** They attach through `intel_reasoning_links` and are never edges, so AI reasoning is kept apart from evidence.
- **Correlation is not ownership.** Edge names describe what was seen (`hosted_on`, `displays_wallet`, …), and every API response and UI panel repeats that shared infrastructure is not proof of common ownership.
- **Candidate cursor fix.** The Site Finder candidate cursor only advances past seconds that have ended. Candidates are updated in place, and a same-second update would otherwise be missed. This was found by the formation test.

### 2. Site Finder v5 continuous discovery — `integrations/site-finder-v07/app/v2/continuous.py`
- **Cycles.** Each cycle is persisted (`v5_cycles`), leased and restart-safe. An interrupted cycle is marked `interrupted`. Candidates are keyed by domain, so nothing is repeated.
- **Source rotation.**
  - Sources are chosen by Thompson-sampled strategy value, learned from downstream outcomes.
  - Every source is forced back in at least every 4 cycles.
  - A source that finds nothing new cools down exponentially.
- **Budgets.** A per-day request ledger. A cycle that would exceed it stops before making any request.
- **Novelty and ecosystem saturation.**
  - Each cycle counts new unique domains, new ecosystems, previously unseen infrastructure and re-sightings of known domains.
  - Deliveries pass through an **ecosystem veto**: a cluster that already delivered 3 sites and never proved useful is not delivered again.
- **Aging and rediscovery.** Undecided candidates older than 14 days stop counting as supply. An aged candidate seen again is re-probed.
- **Change detection (the "infra watch").**
  - Delivered and useful sites are re-resolved by DNS on a backoff schedule.
  - A real change (resolves or stops resolving, a new IP, new name servers) is recorded and re-sent to the platform with a new idempotent batch id.
  - An unchanged check only moves `last_checked`.
- **Platform-requested cycles.** The platform's `DISCOVER_SITES` job with `mode: "continuous"` runs a cycle. The standalone autopilot runs cycles too (`V5_CONTINUOUS=0` restores plain v2 rounds). Campaign-derived pivots use the v4 contextual pivot engine unchanged.
- **Platform fix.** `lib/ingestion.ts` no longer re-publishes the `site.triaged` event of an earlier batch. Before, a watch re-delivery (same triage evidence, new batch) raised `EVENT_ID_CONFLICT` and failed the batch. A retry of the *same* batch behaves exactly as before.

### 3. Global opportunity queue — `lib/ops/workitems.ts`
- **Kinds.** `investigate_candidate`, `revisit_changed_site`, `revisit_incomplete`, `inspect_infrastructure`, `analyze_wallet`, `expand_campaign`, `test_hypothesis`, `compare_clusters`, `draft_report`, `review_contradiction`, `campaign_step`, `form_campaign`, `merge_campaigns`, `split_campaign`, `discovery_cycle`.
- **Priority.** A pure weighted sum of named factors:
  - positive: information gain, novelty, evidence strength, campaign relevance, accessibility, previous outcomes, open gaps, freshness;
  - negative: cost, duplicate probability, saturation.

  Items also track their age (starvation boost) and the gaps they target.
- **Fingerprints.**
  - Proposals are idempotent: re-proposing re-scores the item.
  - Finished work reopens only when the caller says the world changed.
  - Near-certain duplicates (`dup_prob` ≥ 0.85) are suppressed.
- **Candidate relevance.** Candidate factors are computed from observable state:
  - sibling investigations in the same cluster;
  - a dead-site facet;
  - learned priors;
  - relevance to sites where a module actually observed a wallet, through shared non-generic infrastructure (the v5 counterpart of v4's `proven_link`).

### 4. Autonomous scheduler — `lib/ops/scheduler.ts` (replaces `tickDueCampaigns` in `worker.ts`)
- **One tick** runs under a single global lease: recover → reconcile → refresh (team roles) → generate → select → review → start.
- **Selection.**
  - Items are ordered by deterministic priority, plus a bounded starvation boost, multiplied by a bounded experiment weight.
  - About 10% of starts are exploration: the best item from a context with little history.
  - It enforces a global concurrency limit and per-module slots.
  - Pause states are respected: operations pause, discovery pause, and pausing low-priority discovery only.
- **The Reviewer's pre-start check** decides one of:
  - **cancel**: a person skipped the site, the item's gap is closed, or its campaign was stopped or merged;
  - **defer, with a reason and a time**: the same target is busy, the revisit cooldown has not passed, or the budget is reached;
  - **allow**.
- **Claiming and charging.**
  - Items are claimed atomically.
  - Budget is charged only when module work actually starts, once per attempt, with an idempotent ledger reference.
  - Retries use exponential backoff. At the attempt limit the item becomes `failed`: it is kept, surfaced once and can be retried by the operator.
- **What runs now, waits, needs a human or is revisited later** is visible per item in `work_item_events` and in the UI.

### 5. Temporal intelligence — `lib/ops/temporal.ts`, `lib/ops/reactions.ts`
- **The chain.** Entity → facet observation → timestamp → change → resulting opportunity.
- **First observation.** Stored as the current value; it is not a change.
- **Same value again.** Only `last_seen_at` and the observation count move. **It is not new evidence and creates nothing.**
- **Different value.** A snapshot and a typed change are recorded:
  - site disappeared or returned;
  - infrastructure or certificate changed;
  - deposit page appeared or disappeared;
  - wallet changed;
  - new related domain;
  - cluster inactive.
- **Reactions to a change.**
  - Revisits (cooldown, with an exception for highly significant changes).
  - Passive pivots on new infrastructure.
  - Cancelling work on a vanished site.
  - Deactivating graph links that no longer hold.
  - Reopening quiet campaigns.
  - Flagging a changed fact that a report depended on.
  - A useful-discovery notification.
- **Disagreement is not a change.** A different *source* reporting a different value on an exclusive facet at nearly the same time (configurable window, default 1 h) is recorded as a **contradiction**, not a change.

### 6–7. AI Investigation Team v2 and hierarchical planning — `lib/ops/team.ts`
- **Roles are chosen per tick from state:**
  - Resource Manager (always);
  - Discovery Strategist (supply is low or shared infrastructure exists);
  - Graph Analyst (new edges);
  - Evidence Analyst (new evidence or stale gaps);
  - Hypothesis Analyst (live hypotheses);
  - Campaign Planner (running campaigns);
  - Report Analyst (finished investigations);
  - Reviewer (always, in the scheduler).
- **Typed artifacts, no commands.** Each role returns one zod-validated artifact into `ops_artifacts`. Roles never call each other. Only the scheduler turns artifacts into work, through `proposeWork`.
- **Where models may help:**
  - the Discovery Strategist may ask a model to *reorder* offered pivots (validated as a subset);
  - the Graph Analyst may forward a model's grouping only if `validateGrouping` proves every cited edge exists, is active, is not generic and connects every proposed domain (off by default: `ai_graph_groupings`).
- **Planning levels.**
  - Global: the allocation and discovery plan of each tick.
  - Campaign: goals in `campaign_meta.goal`, revised when the campaign's state changes.
  - Investigation: the v3 investigator's plan.

  Every level re-plans from evidence on every loop.

### 8. Evidence gap engine — `lib/ops/gaps.ts`
- **Gaps are first-class and derived deterministically:**
  - `no_site_observation`;
  - `no_deposit_destination`;
  - `wallet_not_analyzed`;
  - `infrastructure_unknown`;
  - `stale_observation`.
- **Content.** Each gap records what is known, what is missing and the safe actions that could fill it (for example "Wallet Investigator reads public chain data").
- **Gaps drive work.** Each gap proposes its safe action as a work item. Investigation gaps respect the auto-investigate floor, so a gap is never a way around the operator's threshold.
- **Endings.** A gap ends as `resolved`, `unresolved` (the rechecks were exhausted), `inaccessible` (dead site or a declined human step) or `irrelevant` (a person skipped the site, or its campaign set it aside as a near-duplicate).
- **Closing stops work.** A gap that closes cancels its queued work, and the Reviewer refuses to start work for a closed gap.

### 9. Confidence calibration — `lib/ops/confidence.ts`
- **Dimensions.** Observation reliability, relationship strength, hypothesis confidence, discovery confidence, entity resolution and AI uncertainty.
- **Audit trail.** Every change records its reason, basis and previous value.
- **AI limits.** `recordConfidence` throws `AI_CANNOT_SET_CONFIDENCE` if the basis is AI and the dimension is anything other than `ai_uncertainty`.

### 10. Deterministic contradiction detection — `lib/ops/contradictions.ts`
- **What is detected:**
  - providers disagreeing;
  - status observations that conflict;
  - a supported hypothesis whose sites a person marked "not a scam";
  - an AI inference citing evidence that has since changed;
  - a fact that changed after a report was prepared;
  - one wallet recorded on incompatible networks.
- **What happens.** Each contradiction is fingerprinted, creates a `review_contradiction` item that waits for a human, and notifies when important. The resolution is recorded.

### 11. Learning engine v3 — `lib/ops/learning.ts`
- **Ledger.** It builds on v4's experience ledger: context → decision (work kind) → action → cost → result → usefulness.
- **Provenance.** `source_ref` is the work item's event id, so every row cites a real event.
- **What it learns.** Human-need prediction, revisit value and campaign stopping.
- **Safeguards.** Decay and the prior bounds are kept. AI self-evaluation carries zero weight.

### 12. Strategy experiments — `lib/ops/experiments.ts`
- **Arms.** Only registered strategies, and both arms must be in the experiment's domain.
- **Bounds.** Population ≤ 500, a budget cap, and stop conditions (minimum sample per arm, maximum days).
- **Result.** Useful results per unit of cost with a 95% confidence interval.
- **What a strategy can do.** It can only reweight the *ordering* of work the platform would do anyway, by ±20%. It cannot create work or touch policy.

### 13. Automatic campaign formation — `lib/ops/formation.ts`
- **Support required.**
  - A group needs a shared wallet, a shared kit, or at least two independent infrastructure types (for example the same IP *and* the same name servers).
  - At least 3 sites not already covered by an active campaign.
- **Scope.** Auto-formed campaigns contain exactly the validated group. They do not run open-ended association, which in testing made auto campaigns grow into each other.
- **Merge.** Merges need a shared wallet or two supported cross links, and wait while the absorbed campaign has work executing.
- **Split.** A split happens when links deactivate and the sites fall into unconnected groups.
- **Inactive and reopen.** A campaign goes inactive when all its sites are gone and reopens on a significant change.
- **History is preserved.**
  - Members and edges are *copied* with their original `source_table` and `source_ref`.
  - Absorbed and split-off rows are kept and marked.
  - `campaign_lineage` records `formed`, `merged_into`, `absorbed`, `split_from`, `split_off`, `inactive` and `reopened`.

### 14. Simulation / dry run — `lib/ops/simulation.ts`
- **Inputs.** Current state (queued work plus the candidates it would generate) or a synthetic fixture.
- **Method.** It uses the same pure priority, budget and learned-prior functions as the live scheduler.
- **Output.** Actions, implied jobs, budget use, predicted checkpoints and the stopping point, with its reason.
- **Guard.** Everything runs inside `withoutExecution` (`lib/ops/guard.ts`, AsyncLocalStorage), in which every executor on the platform throws `ExecutionBlocked`:
  - `enqueueJob`, `startRun`, `createCampaign`;
  - campaign execution and graph edges;
  - hypotheses and work items.

### 15. Model routing — `lib/ai/router.ts`
- **Tiers by task:**
  - fast: extraction, classification, command parsing;
  - standard: planning and evidence analysis;
  - deep: graph, hypothesis and campaign decisions.
- **Providers.** Anthropic, OpenAI, Google and local models are tried in order (`AI_PROVIDER` then `AI_FALLBACK_PROVIDERS`). A provider failing ≥60% of its last 12 calls is tripped.
- **Budgets.** Global and per-provider limits on calls, tokens and estimated cost.
- **Telemetry.** Every call records provider, model, tier, latency, tokens, cost, status and later usefulness.
- **When no model is used.** If there is no provider, no budget or no healthy provider, the caller runs its deterministic path.
- **Scope.** The v4 campaign roles now call through the router.

### 16. AI decision replay — `lib/ops/decisions.ts`
- **What is stored for each model-assisted decision:**
  - the visible state (exact system and prompt text, the offered options);
  - evidence refs and the capability schema;
  - model, proposal and policy decision;
  - the resulting work item or job and its result.
- **Replay.** `replayDecision` asks another provider or tier the same question inside `withoutExecution` and applies the same pure validator. The replay is recorded as `is_replay` and is not charged to budgets.

### 17. Operator Workspace UI — `components/ops/*`, restyled `platform-shell.tsx`
- **Style.** A calmer neutral theme: flat surfaces, hairline borders, one accent, and status colour only where it means something.
- **Navigation.** Operations (home, `/`), Campaigns, Investigations, Discovery, Intelligence and Human Tasks (with a count badge). Legacy pages sit under a collapsed **Advanced**. The inbox moved to `/inbox` and is also embedded in Discovery.
- **Operations** shows:
  - system state and what is running or next, each with its reason;
  - campaigns with goals, recent discoveries and findings;
  - budgets, AI activity and throughput.

  **System telemetry** (health, routing, learning, scheduler, experiments, simulations, decisions) stays collapsed until opened.
- **Campaign Workspace** is the v4 campaign view (summary, findings, entities, hypotheses, relationships, budget, tasks) plus the goal, evidence gaps, the campaign queue, a timeline (lineage, observed changes, finished work, contradictions) and AI team activity.
- **Intelligence.**
  - An interactive graph with filters: entity-type chips, relationship, minimum strength, recency, campaign and focus.
  - Generic hosting is hidden, the view is capped at 90 nodes, and the layout is deterministic.
  - Clicking a node opens its links with provenance, evidence, campaigns, change history and hypotheses (labelled "reasoning, not evidence"). A list of wallets shown on more than one site sits alongside.
- **Human Tasks.** Login, CAPTCHA, MFA, email verification, analyst review, contradictions and report approvals in one queue. Each task says what is needed, what the platform will not do and how work resumes.
- **Command bar** (⌘K) and a **notifications** bell in the top bar.
- **Screenshots** are in `docs/screenshots/v5_*.png`. They were rendered from real read-model output of a benchmark run and the acceptance suite.

### 18. Command interface — `lib/ops/commands.ts`
- **A closed set of typed intents, each with a fixed effect:**
  - *read*: status, why was X investigated, missing evidence, multi-site wallets, compare campaigns;
  - *queue*: find more candidates, revisit a site, analyse a wallet. These create work items only, never jobs;
  - *control*: bounded pause and resume settings.
- **Compilation.** A deterministic grammar compiles most commands. Otherwise the fast model tier translates the text into the same strict schema. A model-compiled command that changes anything is **shown back for confirmation**, and a confirmation is re-validated from scratch.
- **Refusals.** There is no intent for credentials, payments, budgets or evidence edits, so such requests are refused.
- **Logging.** Every command is logged with its compiled form and the policy applied.

### 19. Notifications — `lib/ops/notifications.ts`
- **Kinds.** Human action needed, useful discovery, campaign completed, important contradiction, budget nearly exhausted, report ready, module/provider unhealthy.
- **Deduplication.** A dedupe key per open notification increments a counter instead of adding rows. Routine work never notifies.

### 20. Operational reliability — `lib/ops/health.ts`
- **Monitored:** queue depth, job latency, failures and retries; module, provider and AI health; scheduler age; database round-trip; stale investigations; stuck campaigns.
- **Automatic recovery:**
  - adopt orphaned jobs and runs (never create them twice);
  - requeue with backoff;
  - clear expired leases.
- **Failed work** is kept, visible and retryable.
- **State changes** are recorded per component, and an unhealthy module or provider notifies once.

### 21. Safety boundaries
- **Unchanged from v4.** v5 adds no capability that touches a site. Every job still carries `AUTOMATION_POLICY`. Human-required authentication is still a checkpoint, and the UI states what the platform will not do.
- **Structural enforcement.** Safety is enforced structurally — typed kinds, strict schemas, a closed intent set, source-row checks and the execution guard — not by lists of forbidden phrases.

## Other platform changes
- **Global budgets bound campaigns.** v4 campaign work now also draws on the platform's daily budgets: the campaign Reviewer consults them, and execution charges them. The global limits therefore bound *all* autonomous work. Runs a person starts from the inbox are not charged.
- **Hooks.**
  - `inbox.upsertFromFinder` records Site Finder's passive facets.
  - `agent/hooks.onInvestigationActivity` derives module facets and re-evaluates gaps.

  Both log failures instead of failing ingestion.
- **Changed behaviour.** `worker.ts` runs `schedulerTick()` in place of `tickDueCampaigns()`. Due campaigns are stepped as `campaign_step` work, so pausing operations also pauses campaign steps.

## Known limitations
- **Global budgets are per UTC day** (`budget_ledger.day`). Campaign budgets remain per campaign.
- **Human-started runs are unbounded globally.** Inbox-started v3 runs are not charged to global budgets.
- **Global module-job budget.** It counts only scheduler-started module jobs; module jobs inside v3/v4 runs are bounded by the run and campaign budgets.
- **Site Finder change detection is DNS-only** (resolution, IP, name servers). Page-level changes are detected by platform revisits and module evidence.
- **Graph limits.** The intelligence graph view is capped at 150 nodes per query. Very large graphs are navigated by focus and filters rather than shown whole.
- **Environment.** `startup:modules` still fails here only because `fastapi` cannot be installed in this environment. No code on that path changed.
