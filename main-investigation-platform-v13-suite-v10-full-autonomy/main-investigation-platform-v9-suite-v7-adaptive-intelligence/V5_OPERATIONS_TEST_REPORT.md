# Platform v5 · Operations — Test Report

All suites were run in the Windows-path simulation harness: a path with spaces, `#`, `%20` and brackets, and a hostile `TMPDIR`.

| Group | Result | Notes |
| --- | --- | --- |
| unit (`npm test`) | PASS 20/20 | 17 existing tests plus 3 new v4→v5 migration tests (`tests/v5-migration.test.mjs`) |
| migration-matrix | PASS 10/10 | now includes 0011 |
| integration:v6 | PASS | |
| v2 | PASS (+29 Finder precision) | |
| v3 | PASS 7/7 | |
| v4 | PASS 10/10 scenarios + Finder v4 8/8 | |
| **v5** | **PASS 20/20 scenarios + Finder v5 8/8** | `tests/v5-operations.mjs`, `test_v5_continuous.py` |
| joined:v61 | PASS | both normal and failure-recovery paths |
| five-modules | PASS | |
| site-finder | PASS 472/472 | 464 existing plus 8 new v5 tests |
| startup:modules | FAIL (environment) | `site-investigator-startup-local.py` needs `fastapi`, which cannot be installed here. Same known limitation as v3/v4; no code on that path changed. |

Type-checking: all new server code (`lib/ops/*`, `lib/ai/router.ts`, `app/api/v1/ops/*`, the changed platform files) passes `tsc --strict`. The only remaining messages come from the test-only zod shim's missing types (`ZodError.issues` narrowing, implicit `any` in `.map` callbacks). The same messages already appear on v4 routes.

**Frozen modules.** Each frozen module was checked with `diff -rq` against the v4 delivery, which was itself identical to v6.1:
- CryptoWalletLogger, Wallet Investigator, Site Investigator and Form Submitter are identical.
- The Launcher files (`scripts/start-production.mjs`, `scripts/sites-env.mjs`, `integrations/local_scheduler.py`, `integrations/site_investigator_bridge.py`) are identical.

## v5 acceptance gate → evidence

Each scenario drives the real route handlers, scheduler, executor, engines, v3 investigator, v4 campaigns and module job lifecycle. It uses an in-memory D1, synthetic module batches derived from the real fixtures, and two scripted model providers (one of them adversarial).

| Requirement | Where | What is asserted |
| --- | --- | --- |
| Continuous discovery survives restart | C; Finder `test_cycles_survive_restart_and_never_redeliver` | **Platform:** a discovery cycle is scheduled and its job created. The worker "dies" before recording the job, and its scheduler lease expires. The next tick takes over the lease, *adopts* the existing job (exactly one `DISCOVER_SITES` job for the item), finishes and ingests the discoveries. **Finder:** an interrupted cycle is recovered, not resumed twice; 5 cycles never deliver a candidate twice; a concurrent cycle is refused. |
| No duplicate scheduled work | B, C | Two concurrent ticks: exactly one runs, the other is skipped by the lease. Re-proposing work is idempotent (one row per fingerprint). No work item ever produced two jobs or two investigator runs. |
| Prioritization changes with evidence | D | A sibling proving the same wallets raises duplicate probability (0 → 0.7) and lowers priority. Observed useless outcomes lower the learned prior (0.31 → 0.15). AI self-evaluation does not move it. |
| Temporal changes create correct opportunities | E | Hosting move → `infrastructure_changed`, the old graph link deactivated, a passive `inspect_infrastructure` item linked to the change record. Deposit page appears → revisit queued plus one useful-discovery notification. Site disappears → queued work cancelled and open gaps made inaccessible. |
| Unchanged observations create no fake evidence | E | 10 identical observations: 0 snapshots, 0 changes, 0 work items. Only `observations` and `last_seen_at` move. |
| Gaps drive actions; resolved gaps stop work | F | A wallet observed without analysis opens `wallet_not_analyzed` with its safe action. The gap proposes `analyze_wallet`, the scheduler runs it and the gap resolves. Other queued work tied to the gap is cancelled, and the Reviewer cancels any late item for a closed gap. History is kept. |
| Contradictions trigger review | G | Finder "live" vs evidence "dead" at the same moment is a *disagreement*, not a change. It becomes one `review_contradiction` item (waiting for a human) and one Human Tasks entry, even when seen twice. A resolution needs a note and is recorded. |
| Formation requires support | H | One shared IP between three sites does not form a campaign; adding shared name servers does. The proposal cites real edges. Fabricated edges or an unconnected domain are refused. Formation is idempotent. |
| Split/merge keeps provenance | H, H2 | **Merge:** a shared wallet merges two campaigns, every edge keeps its original `source_table/source_ref`, lineage is recorded on both sides and the absorbed history is kept. **Split:** a campaign whose sites form two unconnected groups splits; copied edges cite the same source rows; the original's members are kept, marked "moved"; lineage and `split_from` are recorded. |
| Concurrent campaigns without state leakage | I | Two campaigns stepped concurrently by the scheduler: members, edges and opportunities never cross, and each site is investigated at most once. |
| Model routing works; deterministic fallback works | J | `command_parse` goes to the fast tier and falls back from a failing provider to the next, with both invocations recorded. A failing provider is tripped and no longer called. At the call budget the router refuses and the caller stays deterministic. With no provider, commands and ticks work. |
| Invalid AI actions and hallucinated evidence stay blocked | K | Refused: a model-compiled out-of-schema intent, smuggled fields, AI raising observation reliability, AI-basis edges, edges citing non-existent evidence or unlisted tables, and a model grouping citing fake edges. A model-compiled change needs confirmation and was not applied. No model output ever appears as evidence. |
| Budgets are enforced | L | With a limit of `used + 1` investigations, exactly one starts and the other is *deferred* with the reason and a time. The ledger never exceeds the limit or double-charges on re-ticks. A module-scoped limit defers wallet work. One budget warning is sent. |
| Human checkpoints work | M | A login wall makes the item `waiting_human`. The task explains what is needed and what the platform will not do. One notification over several ticks. After the person's step the work resumes by itself, and the need for a person is learned. |
| Pause/resume works | N | While paused: no start, no job. After resume: starts. Paused discovery waits, not dropped. |
| Crash recovery works | C | Orphaned items adopt their existing job or run. Otherwise they are requeued with backoff and a recorded reason, and never discarded. |
| Finder learning changes allocation | Finder `test_learning_changes_allocation`, `test_rotation_…` | Credited outcomes move a source up the cycle plan (+15 selections in 60 draws) and a skipped source down. Rotation forces idle sources back; cooling sources are excluded. |
| Experiments stay bounded | O | Unregistered and cross-domain arms and unbounded populations are refused. Weights stay within [0.8, 1.2]. The population cap is respected. Experiments create no work. The experiment stops at its limit. |
| Replay cannot execute | P | Inside the guard, `enqueueJob`, `startRun`, `createCampaign`, `proposeWork` and `addIntelEdge` all throw `ExecutionBlocked`. A replay against another model is compared and validated (the hallucinated option fails), is not charged to budgets, and creates nothing. |
| Simulation cannot execute | P | Fixture simulation respects budgets, predicts checkpoints, never schedules a near-certain duplicate and names its stopping point. History simulation also runs. The counts of jobs, runs, work items, edges, campaigns and hypotheses are unchanged. |
| Commands cannot bypass policy | Q | Read, queue and control intents behave as typed. Queue commands create work items, never jobs. Credentials, payments, CAPTCHA, budget and evidence requests are refused. Forged confirmations are re-validated. Every command is logged. |
| Notifications deduplicated; failed work kept | R | Duplicate notifications are counted, not repeated, and routine work does not notify. Work whose module job keeps failing retries with backoff up to its limit (one job per attempt), ends `failed`, notifies once, shows in health, and completes after an operator retry. |
| Operator routes and read models | S | Overview, queue (validated filters), tasks, bounded graph with filters and focus (generic hosting excluded, provenance on every link), node detail, workspace, budgets (scope validated), investigations, discovery, advanced telemetry. |
| Frozen contracts compatible; v4/v3/v2/v6.1 green | table above | |
| Clean v4 → v5 migration | `tests/v5-migration.test.mjs` | 14 v4 tables byte-identical after 0011. v4 schema objects unchanged. The gate refuses an un-upgraded database. An interrupted upgrade rolls back. Dropping the v5 tables restores the exact v4 schema. |

## Bugs found by these tests and fixed

- **Low-scoring candidates were investigated anyway.** The gap engine proposed investigations for candidates below the auto-investigate floor. It now respects the floor, or a person's USEFUL decision.
- **Same-second updates were missed by the graph.** The global graph's candidate cursor skipped candidates updated in place within the same second. It now advances only past seconds that have ended.
- **Watch re-deliveries failed.** They hit `EVENT_ID_CONFLICT` on the triage event. An earlier batch's triage is no longer re-published.
- **Budget was charged for work that never started.** It was charged at claim time, even for items that ended without module work (already covered or campaign-owned). It is now charged when module work starts.
- **Auto campaigns overlapped.** Auto-formed campaigns ran open-ended association, grew into each other and then merged and split repeatedly. They are now exactly their validated group.
- **Wrong column and status names** in the first versions of the Campaign Planner and discovery views. These were found by the acceptance run and fixed.
