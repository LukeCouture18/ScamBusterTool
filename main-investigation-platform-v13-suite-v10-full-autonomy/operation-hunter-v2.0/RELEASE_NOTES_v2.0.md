# Operation Hunter v2.0 — release notes

v1.0 reconstructed an operation from a seed. v2.0 keeps a **living model** of it, pursues it autonomously with a measured notion of progress, keeps hunting for it after the session, and works as Main Platform v5's reconstruction engine.

## New architecture

| Layer | Where | What it does |
|---|---|---|
| Temporal fact ledger | `server/model/facets.ts`, tables `facet_values`, `facet_changes` | Every observation becomes typed facet values (DNS answers and status, nameservers, registry status/registrar, hosting IP, page title/structure, certificates, money flows, members of a nameserver/IP/file/identifier) with first/last seen. New observations produce changes: appeared, changed, disappeared, resurfaced — or *contradiction* when two sources disagree at the same moment. Late observations become history, not changes. |
| Membership inference | `server/reasoning/membership.ts` | Explainable log-odds per site across evidence families (operator settings, wallets, per-deployment files, certificates, private hosting, redirects, timing/naming, negative evidence). Indicators are classified operator / vendor / infrastructure / service / commodity; planted or copied settings are detected (inconsistent carriers); a file shared under two operators' settings is tooling, not ownership; population scales hosting weight; membership must chain back to the seed through non-kit evidence (anchoring), so another kit customer's self-consistent group cannot join. Wallets join through the money pipeline; exits are recorded, never walked through. Analyst verdicts override and **calibrate** the weights (`server/reasoning/calibration.ts`). |
| Living model | `server/model/living.ts` | Site lifecycles, deployment waves and next-wave forecast (window + confidence), operation status (active / rotating / dormant / dark), infrastructure history, kit lineage, money pipeline and exits with share from the operation, other operator groups, competing explanations as an ACH matrix with the test that would separate them, persisted contradictions (planted settings, source conflicts, membership reversals, activity before re-registration, service wallets displayed), unknowns. Versioned with readable diffs (`model_versions`). |
| Pursuit v2 | `server/pursuit/*`, `server/engine/pursuit.ts` | Value-of-information allocation per unit of cost; a contextual Thompson-sampling learner over (pivot × entity × membership × indicator level) with **delayed credit** when analysis later confirms a discovery; *proxy progress* rewards what moves the reconstruction (linked sites, operator settings, money destinations, verification of real contenders, real changes) and gives nothing for volume; branches (lines of inquiry) that saturate, park and are revisited on a cooldown or when a change touches them; hypothesis-driven naming and page-title searches (CT `%` patterns, urlscan title search); archived DOM analysis; diminishing-returns stop; a daily lookup budget shared fairly across operations (`ResourceGovernor`). |
| Standing hunts | `server/pursuit/hunts.ts` | Per operation, from its reconstruction: private nameservers, naming template, per-deployment files, page titles, collection/treasury wallets. Adaptive cadence (tighter when a wave is due or the operation is rotating). New domains are verified and judged by membership; a *confirmed rotation* requires operator-level evidence. |
| Brief v2 | `server/model/modelFindings.ts`, `server/services/intel.ts` | Model findings (mid-rotation, next wave, undecided explanations, what changed) compete with the existing findings for the 3–5 slots; a one-line model strip; the 3 most valuable next lookups with why, expected progress and what they don't prove. |

## Main Platform v5 integration

Hunter is now a registered Main module with a closed job type (`HUNT_OPERATION`) and a Main work kind (`reconstruct_operation`). Main decides what to reconstruct; Hunter reconstructs, creates the operation's Main investigation, ingests members and evidence, and syncs its model, proposals, observations and contradictions; Main turns proposals into its own work under its scheduler, reviewer and budgets. See `INTEGRATION.md`. The Main side ships as a separate upgrade (migration `0012_operation_hunter.sql`).

## UI

- Brief: model strip (state, next wave, leading explanations, what is being watched), next lookups with a Run button.
- **Living model** view: status, competing explanations with an evidence matrix, sites and their lives, waves & forecast, unknowns, contradictions (resolve / dismiss / reopen), model history, standing hunts (pause / resume / run now), lines of inquiry, other operators kept apart.
- Entity drawer: membership with every factor and its weight, **Belongs / Does not belong / Clear** verdicts, indicator level and planted-setting warnings, what changed over time.
- Settings: "give each reconstructed operation its own Main investigation".

## API additions

`/api/v1/operations/:id/model`, `/model/versions`, `/model/versions/:v`, `/membership` (GET, POST `/:entityId` verdict), `/facets`, `/branches`, `/next`, `/hunts` (+ `POST /hunts/run`, `PATCH /api/v1/hunts/:id`), `/contradictions` (+ PATCH), `/api/v1/learner`, `/api/v1/governor`; the brief payload gains `intel` and `leads`; entity detail gains `membership`, `indicator`, `lifecycle`, `history`.

## Compatibility and migration

Schema 2 migration is additive (12 new tables, 3 new pivot columns). A real v1.0 database (fixture in `tests/fixtures/v1_hunter.db.gz`) opens with every operation intact and gets a living model on first analysis. All v1.0 and v0.x endpoints and views remain. Evidence, attribution, authorization and safety boundaries are unchanged: discovery is passive and public, nothing logs in, submits forms, bypasses protections or moves funds, and shared infrastructure, kits or wallets are never presented as proof of shared ownership.

## Tests

45 Hunter tests (v1.0: 35), including: living model and ACH, model versions and diffs, forecast, analyst verdicts and calibration, all new API routes, v1.0 → v2.0 database migration, adversarial ground-truth world, restart mid-pursuit (branches, learner, history and hunts persist; the same run resumes), hunts firing from persisted schedules, a 400-site performance check, and the **joined workflow with the real Main Platform v5 route handlers over HTTP**. Main gains `tests/v5-hunter.test.mjs` (6 tests); its existing suites still pass (one migration test updated to apply every later ordered migration).
