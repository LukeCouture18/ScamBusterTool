# Main Platform v7 — Adaptive Investigation Intelligence

Package: `main-investigation-platform-v9-suite-v7-adaptive-intelligence.zip` (Main + Operation Hunter 2.0, same folder layout as v6).

Status labels used throughout:

- **VERIFIED**: implemented and exercised by a passing automated check in this environment.
- **IMPLEMENTED BUT PARTIALLY VERIFIED**: implemented; only part of it could be exercised, or only in simulation.
- **ENVIRONMENT-BLOCKED**: could not be run here. It is **not** counted as passing.
- **NOT IMPLEMENTED**
- **FAILED**

## 0. Summary

v7 builds on v6; nothing was rebuilt. The v6 operation model, hypotheses, contradictions, temporal intelligence, graph, hidden discovery, bounded hunts, lineage, analyst boundaries, the v5 Director, migrations 0001–0017, the five specialists, Needs You, `content_sha256`, `wallet.observation 2.0.0` and the five-tool shell are unchanged. With `adaptive_enabled = 0` in `ops_state`, Main runs exactly the v6 operation policy.

What v7 adds:

- A typed **evidence-gap** model and a typed **test** model.
- An explainable **information-value** decision for each operation, persisted once for each observable state.
- An **actual-cost ledger**.
- **Causal outcome attribution** and **outcome-specific learning**. Learning only affects prioritization and is never treated as evidence.
- **Bounded dynamic budgets**, **saturation and parking with wake conditions**, and a **portfolio scheduler** with starvation protection.
- A **decision-explanation UI** with an Advanced efficiency view.
- Benchmarks of decision quality: counterfactual regret, a harder simulated corpus, and a real-module A/B on the v6 hidden benchmark.

Every v7 test still runs through an existing specialist work kind, or as a local read inside Main.

Headline results:

| Gate | Result | Status |
|---|---|---|
| v7 acceptance (23 checks, 3 consecutive runs) | 23/23 | VERIFIED |
| v7 SIGKILL matrix (11 phases × before/after = 22 real SIGKILLs) | 22/22 exactly-once | VERIFIED |
| v6 operation acceptance / crash with the v7 engine active | 19/19, 18/18 | VERIFIED |
| Real-module hidden benchmark A/B (v6 policy vs v7, same harness) | same recall (3/3 hidden, 2 wallets); 546 → 401 requests (−26.6%); 182 → 133.7 requests per useful discovery | VERIFIED (local harness; stand-in Python HTTP libs, see §16) |
| Decision benchmark (42 states, counterfactual rollouts) | optimal-choice 0.52–0.55 vs v6 0.048; mean regret 0.43–0.45 vs 2.08 (two runs) | VERIFIED as simulation |
| Harder hidden corpus (5 seeds) | 20.0 vs 15.4 hidden sites; mean regret 0.862 vs 1.801; also spends more requests (see §11) | IMPLEMENTED BUT PARTIALLY VERIFIED (simulation) |
| Large state (10k entities / 50.1k relationships / 5k evidence / 300 inv / 25 ops + v7 history) | 8-operation decision tick 1.3–1.9 s vs v6 policy 1.0–1.2 s on the same state (two runs) | VERIFIED (local SQLite) |
| UI (desktop + 375 px) | 6/6 checks | VERIFIED in SSR/hydration harness; production worker browser ENVIRONMENT-BLOCKED |
| Full regression (`run-tests.mjs all`) | 15 of 18 groups pass; the 3 remaining groups fail identically on unmodified v6 here, or need packages that cannot be installed here (§16) | VERIFIED except ENVIRONMENT-BLOCKED steps |
| Production build, eslint, Node 24, Windows | not runnable here | ENVIRONMENT-BLOCKED |

## 1. Evidence-gap ontology — VERIFIED

`lib/adaptive/ontology.ts` defines the 22 requested families:

SITE_IDENTITY, SITE_REPLACEMENT, PAYMENT_INTERFACE, DEPOSIT_WALLET, WALLET_NETWORK, WALLET_VALIDATION, BLOCKCHAIN_ACTIVITY, WALLET_REUSE, WALLET_ROTATION, PUBLIC_ARTIFACT_REUSE, CONTACT_REUSE, INFRASTRUCTURE_SPECIFICITY, TEMPLATE_SPECIFICITY, DEPLOYMENT_TIMING, OPERATION_MEMBERSHIP, HYPOTHESIS_DISCRIMINATION, CONTRADICTION_RESOLUTION, RELATED_SITE, REPLACEMENT_SITE, CAMPAIGN_WAVE, REPORT_EVIDENCE, REPORT_DESTINATION.

There is also a 23rd family, `HUMAN_BARRIER`. It covers knowledge that only a person can unlock (login, CAPTCHA/MFA, analyst network choice), and no autonomous test is ever generated for it.

`deriveGaps()` (`lib/adaptive/derive.ts`) is pure and derives gaps from the observable operation snapshot.

`adaptive_gaps` persists every field the spec asks for: type, subject, current knowledge, missing knowledge, why it matters, supporting and contradicting evidence, uncertainty, possible tests, dependencies, status, exhaustion condition and revisit condition.

Each status change and resolution is written to `adaptive_gap_history` with lineage.

Status values are: open / in_progress / waiting_evidence / waiting_human / waiting_provider / temporarily_low_value / exhausted / resolved. Gap dependencies are explicit; for example, REPORT_EVIDENCE depends on BLOCKCHAIN_ACTIVITY and WALLET_VALIDATION.

Acceptance checks: "ontology … every requested gap family and test family is defined with its required fields" and "typed gaps persist …".

## 2. Test ontology — VERIFIED

There are 10 test families, each mapped to an **existing** specialist and work kind. No new execution paths exist.

| Test | Specialist | Existing work kind | Safety class |
|---|---|---|---|
| PUBLIC_SITE_INSPECTION | Site Investigator | revisit_incomplete | public_passive |
| LIKELY_WALLET_PAGE_INSPECTION | Site Investigator | revisit_incomplete (with `focus`) | public_passive |
| WALLET_VALIDATION | Wallet Investigator | existing wallet pipeline | local_read |
| BLOCKCHAIN_REFRESH | Wallet Investigator | analyze_wallet | read_only_chain |
| RELATED_SITE_HUNT | Site Finder | find_related_sites | public_passive |
| PUBLIC_ARTIFACT_SEARCH | Site Finder | find_related_sites (structured objective) | public_passive |
| REPLACEMENT_SITE_HUNT | Site Finder | find_related_sites (structured objective) | public_passive |
| HUNTER_HYPOTHESIS_TEST | Operation Hunter | reconstruct_operation (structured question) | analytical |
| TEMPORAL_RECHECK | Site Investigator | revisit_changed_site | public_passive |
| CORRELATION_REVIEW | Main (local SQL) | none (inline, zero network) | local_read |

Each test specification records:

- the gaps it can answer
- expected outputs
- prerequisites
- resource bounds (http/dns/certificate/rdap/provider calls/jobs/effort)
- safety class
- success and failure criteria

## 3. Information-value model — VERIFIED (components persisted); weights are a design choice, not fitted

The model lives in `lib/adaptive/value.ts`. For each candidate test:

- **Core benefit** = Σ weight × component. The weights are uncertainty_reduction 0.28, hypothesis_discrimination 0.25, report_readiness 0.20, evidence_independence 0.14 and downstream_opportunity 0.13.
- **Context modifiers** scale that benefit within bounded ranges:
  - novelty
  - historical_yield (only after ≥ 3 observations)
  - operation_coverage
  - time_sensitivity
- **Adjusted benefit** = benefit × (1 − saturation) × (1 − duplication).
- **Utility** = adjusted × (1 + 0.5 × report_readiness) / (0.35 + costNorm). costNorm(u) = u / (u + 60) over expected cost units.
- **Competing hypotheses**: expected information gain uses binary entropy over Operation Hunter's ACH questions. Diagnosticity tables separate linkage questions (whether sites share one operator) from activity questions. A test that cannot split the live hypotheses gets near-zero discrimination value. The acceptance check "discriminating wallet evidence outranks generic template similarity" covers this.
- **Persistence**: every component of up to 12 candidates is stored in `adaptive_decision_components`. Decisions are idempotent per `state_hash` (a UNIQUE key), so an unchanged state never creates a second decision.
- **Exploration**: bounded at a 15% deterministic draw. It is only allowed between candidates above the benefit floor, and it never displaces urgent work (a report blocker, or a time-sensitive disappearing site).

## 4. Marginal-value model — VERIFIED

Marginal value uses the v6 independence-key semantics.

- **Duplicate units**: a test whose only input is a unit already represented by a known independence key gets duplication ≈ 1. The acceptance check "110 copies of a known template unit add no independent value" covers this.
- **Input novelty**: seeds and artifacts already sent to Site Finder by *any* component (v6 hunts, Director, earlier v7 tests) count as spent. A hunt's discovery power is 1 − Π(1 − pᵢ) over fresh inputs only.
- **Breadth of an artifact** affects that power: contact/analytics 1.0, wallet 0.6, title 0.4. Template variants are discounted ×0.4.
- **Stale Hunter analysis**: when no new evidence has arrived since Hunter last ran, its power is discounted ×0.25 and duplication is set to 0.5.

## 5. Causal outcome attribution — VERIFIED

Attribution runs in `attributeOutcomes()` / `creditOnce()` (`lib/adaptive/engine.ts`) after the v6 projection.

- **Provenance credit**: an outcome whose lineage includes the test's job gets credit 1.0. If a derived claim has more than one contributing test, the credit is split (0.7 to the direct contributor, 0.3 shared).
- **Temporal-only coincidence**: when another job of the operation ran in the same window, the change is recorded as `temporal_only` with credit 0. Operation-wide gains are not credited to whatever test happened to be running.
- **No double credit**: `adaptive_outcomes` has a unique key per (test, outcome subject, kind), so replays and SIGKILL restarts cannot credit twice. Outcomes with no lineage earn nothing.
- **Downstream credit**: a validated site, validated wallet or report-ready evidence is credited back to the test that discovered the subject, once.

## 6. Outcome-specific learning — VERIFIED

`familyLearning()` (`lib/adaptive/snapshot.ts`) builds per-family yield, dead rate and duplicate rate from attributed outcomes. Bounds:

- 30-day decay, at most 50 observations per family
- the mean cost uses only fully measured tests
- it affects prioritization only after ≥ 3 observations

Learning is never written to evidence, claims, reports or the graph. The acceptance check verifies that no learning row is visible to evidence or report readers. The UI states this caveat: "Learning only changes which test Main tries first; it is never evidence."

## 7. Actual-cost ledger — VERIFIED

`adaptive_costs` keeps **reserved** values, written at reservation, separate from **consumed** values, written at finish. Each row has a `source` and a `measured` flag. What is measured:

- jobs, retries and wall time
- worker time, from `job_events`
- Site Finder http/dns/certificate/rdap, from Finder's own budget meter. One line was added to `platform_bridge.py`: `"meter": summary.get("budget")`.
- local CORRELATION_REVIEW: zero network, source `main_local`

Dimensions a specialist does not report stay **NULL**. This applies to Site Investigator / Wallet Investigator / Hunter request counts and to bytes. Nothing is estimated into the consumed column.

**Cost per useful outcome** is shown only when ≥ 3 fully measured tests exist for the family. Otherwise it is marked "insufficient observations".

## 8. Portfolio scheduler — VERIFIED

The scheduler is `portfolioOrder()` (`lib/adaptive/policy.ts`), called from `portfolioStart()`.

- Operations are ordered by best current utility, plus a starvation boost of 0.02 per hour waiting, capped at 0.3.
- **Fairness**: at most 3 consecutive starts and at most 50% of recent starts for one operation while others are eligible.
- The v6 caps still apply above it: 4 active operation hunts, 24 per day, 2 starts per evaluation, and at most one external v7 test in flight per operation.
- Decisions are recorded in `adaptive_portfolio`.
- At investigation level, `director-bridge.ts` arbitrates the v5 Director's order with the same value/cost ranking. Every arbitration is recorded and explained.

Acceptance: "portfolio: utility first, starvation boost, and no operation may monopolize"; "ten concurrent evaluations start at most one external test per operation".

## 9. Dynamic budgets — VERIFIED

The base allowance is 8 operation tests and the hard ceiling is the base plus a maximum bonus of 4. The floor is 2.

- **Earning**: an operation earns +1 when at least 2 of its last 4 tests were useful and independent.
- **Losing**: it loses 1 after 3 consecutive dead or duplicate tests.

Each adjustment is written exactly once per test to `adaptive_budget_adjustments`, with its reason; this survives SIGKILL. The global `adaptive_bonus_cap` cannot be exceeded.

## 10. Saturation, parking and wake conditions — VERIFIED

Saturation is recorded at test, gap, branch, operation and portfolio level in `adaptive_saturation`. It distinguishes:

- temporarily low value
- exhausted
- waiting for evidence
- waiting for a human
- waiting for a provider

**Parking**: an operation whose best test is below the floors is parked in `adaptive_parking` with explicit wake conditions: new evidence, new site, new wallet, a provider restored, a human answer, a time-based recheck, or a budget refill. An operation watermark lets an unchanged parked operation be skipped without re-deriving gaps; this is measured in §14.

Acceptance: "parking: … unchanged evaluations are skipped; new evidence wakes it". Crash matrix: parking and reawakening survive SIGKILL before and after.

## 11. Decision benchmark and counterfactual/regret results — VERIFIED as simulation

**Method** (`bench-adaptive/`, `tests/adaptive-decision-benchmark.mjs`):

- In each state, every available alternative is executed in a *cloned* hidden world.
- The same v7 exploitation policy then continues for 3 ticks for every alternative, and the result is scored against fixture truth: +1 hidden site, +0.8 validated true wallet, +0.6 linkage discriminated, +0.6 contradiction resolved, +1 report ready, −0.3 wrong-operation proposal, −0.004 per request.
- **Regret** = best alternative's value − chosen value.
- Fixture truth lives only under `bench-adaptive/`. An acceptance check confirms that no production module imports it.

**42 states, 10 situation types.** Two full runs are shown. They differ slightly because a few rollouts are not perfectly deterministic. Run 2 is the packaged `decision-benchmark.json`.

| Policy | Optimal-choice rate (run 1 / run 2) | Mean regret (run 1 / run 2) |
|---|---|---|
| v7 (exploitation only) | 0.524 / 0.524 | 0.435 / 0.425 |
| v7 (production, bounded exploration) | 0.500 / 0.548 | 0.449 / 0.432 |
| cheapest safe test | 0.405 / 0.381 | 0.936 / 0.939 |
| random eligible | 0.262 / 0.262 | 0.978 / 0.981 |
| v6 operation policy / v5 Director order | 0.048 / 0.048 | 2.081 / 2.077 |

**By type, v7 optimal choices (run 2):**

- novel exploration 5/5
- expensive-high-value vs cheap-low-value 4/5 (cheapest 0/5)
- new contradiction vs confirmation 4/5 (run 1: 1/5)
- generic template vs discriminating wallet 3/5
- two competing operations 3/5
- time-sensitive disappearing site 2/5 (run 1: 3/5)
- report blocker vs low-value correlation 1/1
- provider retry vs unrelated expansion 1/1

v6 picks the best action in only 2 of the 42 states.

**Weak types:**

- **useful vs saturated Finder branch: 0/5**
- **replacement hunt vs exhausted artifact: 0/5**

In both weak types v7 has lower regret than v6, but it does not pick the best action. Its replacement-hunt and fresh-branch value is under-estimated relative to the rollout. This is reported as a known limitation (§18), not tuned away.

## 12. Hidden operation results

### 12a. Real-module A/B on the v6 hidden benchmark — VERIFIED (local harness)

`tests/adaptive-hidden.mjs` runs the v6 hidden benchmark twice in the same harness: same seed site, same real Main/Finder/SI/WI/Hunter modules, 24 rounds, queues drained. One arm uses the v6 policy and the other uses v7. Raw results are in `verification/adaptive-v7/hidden-discovery-{v6,v7}.json`.

| | v6 policy | v7 |
|---|---|---|
| Hidden sites discovered (not injected) | 3/3 | 3/3 |
| Target sites investigated | 4 | 4 |
| Validated target wallets | 2 | 2 |
| Transport requests | 546 | **401** |
| Jobs | 35 | 30 |
| Requests per useful discovery | 182 | **133.7 (−26.6%)** |
| Bounded operation hunts proposed | 11 | 3 |
| Request plateau reached at round | 13 | 7 |
| Unsupported ownership claims / duplicate active jobs | 0 / 0 | 0 / 0 |

At the round where both arms had complete discovery (round 5), v6 had spent 329 requests and v7 305.

An unmodified v6 tree rerun here measured 355 requests; the v6 report gave 353. That figure is a shorter run that stops at discovery and is not directly comparable with the 24-round arm above.

Neither arm reached full queue quiescence. Both left the same stuck queued work items (investigate_candidate, revisit_changed_site), which are unrelated to the operation policy.

### 12b. Harder hidden multi-operation corpus — IMPLEMENTED BUT PARTIALLY VERIFIED (simulation)

`tests/adaptive-hard-corpus.mjs` simulates several independent operations at once, each starting from one seed. The corpus includes:

- a shared unrelated kit and a shared CDN
- wallet reuse and wallet rotation
- replacement sites and a new deployment wave
- an operation split with a late contradiction
- provider outage and recovery
- dead branches and multi-hop chains
- decoy wallets on transaction-history pages and common counterparties

Specialists are synthetic; hidden subjects appear only when a simulated specialist reveals them, and an assertion checks this. Results over 5 seeds × 16 ticks, means:

| | v6 | v7 | v7 exploit-only | random |
|---|---|---|---|---|
| Hidden sites found (of 25.4) | 15.4 | 20.0 | 21.0 | 19.6 |
| Validated true wallets | 8.0 | 9.4 | 10.0 | 9.6 |
| Replacements / wave sites | 0 / 0 | 0.8 / 2.6 | 1.4 / 2.6 | 1.4 / 2.2 |
| Linkage discriminated | 0 | 3.8 | 3.8 | 3.8 |
| Contradictions resolved | 0 | 0 | 0 | 0.2 |
| Reports ready | 14 | 24.8 | 25.8 | 24.2 |
| Wrong-operation proposals | 0 | 2.6 | 2.8 | 2.4 |
| Requests | 804 | 1235 | 1270 | 1287 |
| Requests per hidden site | 52.3 | 62.0 | 61.0 | 66.8 |
| Mean regret | 1.801 | 0.862 | 0.549 | 0.770 |
| Max wait ticks (starvation) | 10 | 4 | 4 | 8 |
| Exploration starts / useful | 0 | 7 / 7 | 0 | 0 |

Hidden sites found at **equal spend** (300 / 500 / 700 / 900 requests):

- v6: 6.0 / 10.0 / 14.2 / 15.4
- v7: 9.2 / 14.2 / 16.6 / 19.2
- v7 exploit-only: 10.6 / 15.6 / 18.2 / 20.4

How to read these numbers:

- v7 finds more at every spend level.
- When unconstrained, v7 also spends more and has a higher requests-per-site ratio than v6, because it keeps working after v6 has stopped.
- When left to run, a **random eligible-test** policy over v7's candidate set ends close to v7 (19.6 sites), and its per-decision regret is lower than v7 with exploration. At equal spend it is clearly worse: 6.4 / 8.6 / 10.0 / 15.0 sites at 300 / 500 / 700 / 900 requests. Much of v7's final-count gain over v6 comes from the richer, safe candidate set. Ranking mainly buys efficiency.
- v7 makes 2.6 wrong-operation *proposals* per run. These come from template searches that surface kit-sharing decoys. They are candidates for investigation, never relationships or ownership claims.
- Contradiction resolution is weak for every policy.
- The equal-budget runs stop at the tick after the budget is crossed, so v7 overshoots its 600 budget (751 requests) more than v6 does (629). Use the curve figures above for comparisons at equal spend.

## 13. Request-efficiency results

**Real modules**: −26.6% requests per useful discovery and −145 requests over 24 rounds at equal recall (§12a). **VERIFIED.**

The causes are measurable in the decision log:

- Finder seeds and artifacts already searched are not sent again (input-novelty model).
- Stale Hunter re-analysis is down-weighted.
- Saturated operations park instead of re-hunting.

**Simulation**: v7 finds more at equal spend (§12b). Total spend is higher when it is not constrained. **IMPLEMENTED BUT PARTIALLY VERIFIED.**

Per-specialist request counts are only exact for Site Finder (metered). See §7.

## 14. Crash/restart results — VERIFIED

`tests/adaptive-crash.mjs` sends a real `SIGKILL` to the worker process before and after each of the 11 new phases:

1. gap creation
2. test planning (candidate components)
3. decision selection
4. resource reservation
5. specialist handoff
6. cost accounting
7. outcome attribution
8. learning update
9. budget adjustment
10. parking
11. reawakening

That is 22 kills, and all 22 pass. After restart each case verifies:

- no duplicate decision, test, hunt or work item
- no lost reservation
- costs, credits and budget adjustments applied exactly once
- recovery of reserved-but-not-handed-off tests

The v6 crash matrix (18/18) still passes with v7 enabled. Event storm (50 events plus replay), provider flapping, and pause are covered in v7 acceptance.

## 15. Large-state performance — VERIFIED (local file-backed SQLite)

The fixture had:

- 10,000 entities, 50,100 relationships, 5,000 evidence rows, 300 investigations, 25 operations
- v7 history: 10k decisions, 144k decision components, 10k tests, 100k cost rows, 30k outcomes, 20k lineage rows, 5k gaps, 20k gap-history rows

| Operation | Latency |
|---|---|
| Adaptive portfolio decision tick, 8 operations | 1,296–1,861 ms (run 2: 1,383–1,703 ms) |
| Unchanged parked tick | 1,126–1,256 ms (shared projection work dominates) |
| v6 policy tick, same state | 983–1,071 ms (run 2: 956–1,222 ms) |
| Director projection tick | 1,486–1,752 ms |
| Operation decision view | 16 ms |
| Operation view + efficiency | 57–97 ms |
| Portfolio efficiency | 508 ms |
| Briefing + graph first page | 14.5 ms |

Memory and storage:

- Peak RSS: 232–236 MB.
- Database size: 88 MB with the fixture and history loaded, 156 MB after the run. Growth during the run was 68 MB, mostly projection/lineage.

The efficiency view was 3.9 s before it was rewritten as set-based SQL.

This measurement is not a remote Cloudflare D1 service-level measurement.

## 16. Full regressions

Command: `PYTHONPATH=tests/lib/py-standin node scripts/run-tests.mjs all` (Node 22).

Two passes were needed.

**Pass 1: one full run of every group.** It ended with 12 PASS and 6 FAIL:

- **migration-matrix, suite (21-page UI click-through + restart smoke), loops, integration:v6, v2, v3, v4, v5, joined:v61, five-modules (31/31), site-finder, director**: PASS.
- **joined:hunter**: FAIL. The test pinned the migration list at 0017, so this one was caused by v7. The pin was extended with the additive `0018_adaptive_intelligence.sql`.
- **operation-intelligence**: FAIL at the hidden step. That step was launched without the `sql.js` stand-in import that sibling steps use. The import is now added for that step only.
- **adaptive-intelligence**: FAIL at check 9 (attribution). The check assumed a second Finder test starts within two evaluations, but exploration order depends on the random operation id. The check now allows up to 6 bounded evaluations.
- **unit, startup:modules, wallet-pipeline**: FAIL. These are pre-existing or environment-blocked; see below.

**Pass 2: the groups fixed above, rerun:**

| Group | Result |
|---|---|
| joined:hunter | PASS |
| operation-intelligence: v6 acceptance 19/19, v6 crash 18/18, benchmark, stress, hidden, UI, SI v6 fixes | PASS |
| adaptive-intelligence: acceptance 23/23, crash 22/22, stress, UI, decision benchmark, hard corpus, hidden A/B v6 + v7 | PASS |

The acceptance file alone also passed 6 consecutive runs after the fix.

**Pre-existing or environment-blocked failures. None is counted as passing:**

| Group / step | Cause | Status |
|---|---|---|
| unit: `wallet-db-lifecycle` "damaged file" case (other 37 unit tests pass) | sql.js stand-in cannot run SQLite's integrity check; **fails identically on unmodified v6 here** | ENVIRONMENT-BLOCKED |
| startup:modules step 2: Site Investigator startup | `fastapi` not installed; PyPI blocked | ENVIRONMENT-BLOCKED |
| startup:modules steps 3–4: Wallet / Form startup (run separately) | `express` not installed; npm registry blocked | ENVIRONMENT-BLOCKED |
| wallet-pipeline step 6: wallet browser end-to-end (steps 1–5 pass: Logger tests, Logger extension, WI validation, WI platform worker, wallet pipeline e2e) | wallet DB on the sql.js stand-in is reset by the failed integrity check, so the report never becomes ready; **fails identically on unmodified v6 here** | ENVIRONMENT-BLOCKED |

Pre-existing environment-dependent failures. Each was reproduced against the **unmodified v6 tree** in this environment, so they are not regressions:

- `tests/wallet-db-lifecycle.test.mjs` "damaged file" case. The environment has no real `sql.js`; v6's test-only `tests/lib/sqljs-standin` cannot run SQLite's integrity check (`integrity check: undefined`). The other 37 unit tests pass.
- Operation Hunter `tests/main-joined.test.ts`, 1 of 45. This was environment-skipped in the v6 report and fails identically on pristine v6 here.

Other environment notes:

- **Stand-in Python libraries**: `httpx` and `dnspython` cannot be installed here (PyPI is blocked). Python modules that import them used minimal test-only stand-ins in `tests/lib/py-standin`. They are documented there and are never imported by production code. Results that depend on them are local-harness results.

## 17. Production verification

| Gate | Status |
|---|---|
| Fresh install (migrations 0001–0018 on an empty DB) | VERIFIED (harness) |
| Populated v6 → v7 migration, replay, rollback leaves prior data | VERIFIED (acceptance check 23) |
| Used-state restart | VERIFIED (crash matrix, v6 + v7) |
| Event storm, provider flapping | VERIFIED |
| Large-state stress | VERIFIED (local) |
| `npm ci` / production build (`vinext build`) / eslint | **ENVIRONMENT-BLOCKED**: npm registry returns 403; dependencies were linked from a local tool cache for tests only |
| Production worker in a browser | **ENVIRONMENT-BLOCKED**: depends on the build. The UI was verified in the SSR/hydration harness with Playwright Chromium (`verification/adaptive-v7/ui/*.png`) |
| Node 22 | VERIFIED (all results above) |
| Node 24 | **ENVIRONMENT-BLOCKED**: nodejs.org is blocked |
| Windows | **ENVIRONMENT-BLOCKED**: no Windows shell was available. v7 adds no shell, path or process code beyond what v6 already hardened |
| Native SQLite extension / real `sql.js` | **ENVIRONMENT-BLOCKED**: v6 stand-in used |

## 18. Known limitations

1. **Unmeasured costs**: Site Investigator, Wallet Investigator and Hunter do not report request or provider counts. Those ledger columns stay NULL, so cost per useful outcome is exact only for Finder tests and local reviews.
2. **Weak benchmark types**: v7 under-values "fresh branch vs saturated branch" and "replacement hunt vs exhausted artifact" (0/5 optimal in each).
3. **Contradiction resolution**: v7 does not yet resolve contradictions in the corpus (0 for v6 and v7).
4. **Random reaches a similar final count** in the harder simulated corpus when unconstrained. v7's ranking advantage shows at equal spend and in the decision benchmark (≈0.52–0.55 vs 0.262 optimal).
10. **Benchmark variation**: the decision benchmark varies slightly between runs (§11). Both runs are reported.
5. **Higher unconstrained spend**: v7 spends more requests than v6 when unconstrained in simulation, while being more efficient at equal spend. In real modules it spends fewer.
6. **Wrong-operation proposals**: template searches can propose kit-sharing decoys as candidates (2.6 per simulated run). They remain candidates and are never relationships.
7. **Stale parking reason**: if a provider goes down while an operation is already parked for low value, the displayed reason stays "low value" until the next wake.
8. **Context weights are hand-set**: modifier ranges and core weights are documented design choices with rationale, not fitted parameters.
9. **Queue quiescence**: the hidden benchmark never reaches it in either arm, because of pre-existing stuck queued work items.

## 19. Safety and evidence discipline — VERIFIED

The safety boundary is preserved verbatim:

> Autonomous tests must remain: public/passive discovery, normal user-authorized browsing, read-only blockchain analysis, authorized reporting after explicit approval. Never add: credential guessing, brute force, credential stuffing/spraying, verification bypass, exploitation, session theft, financial transactions, private-key/seed handling.

Every v7 test has one of four safety classes: public_passive, read_only_chain, local_read or analytical. Every test executes through an existing work kind, and an acceptance check enforces both.

Other guarantees:

- Reporting still requires explicit approval in Needs You.
- Wallet ownership is never inferred from transactions. Correlation reviews produce observations for review, never ownership.
- Finder objectives are observations only.
- Hunter remains the inference authority: Main sends structured questions, and Hunter's answers come back through its existing integration.
- Learning, costs and decisions are prioritization metadata and never enter evidence, claims or reports.

## 20. Wallet Logger 1.0 integration notes

Wallet Logger 1.0 remains an independent branch.

- v7 does not recreate its credential vault or its standalone flow UI.
- v7 never ingests passwords, vault keys, provider credentials or session secrets. No v7 table has a column for them, and v7 reads only the existing `wallet.observation 2.0.0` contract.
- Logger compatibility is preserved: no Logger-facing contract, path or schema changed.
- CryptoWalletLogger, Wallet Investigator, Site Investigator, Form Submitter and the Launcher were not modified.
- The Launcher contract paths are unchanged: `sdk/contracts/v6.json`, `integrations/`, `scripts/start-production.mjs`.

## Appendix — files

- **New**:
  - `lib/adaptive/{ontology,derive,value,policy,snapshot,engine,director-rank,director-bridge,view}.ts`
  - `drizzle/0018_adaptive_intelligence.sql`
  - three API routes (`/api/v1/operations/[id]/adaptive`, `/api/v1/investigations/[id]/adaptive`, `/api/v1/adaptive/efficiency`)
  - `bench-adaptive/*`
  - `tests/adaptive-*.mjs`, `tests/adaptive-ui.py`
  - `tests/lib/py-standin/*`
  - `verification/adaptive-v7/*`
- **Modified** (additive):
  - `lib/schema-ready.ts`
  - `lib/ops/intelligence.ts`: the v7 path, plus the v6 path when disabled
  - `lib/ops/executor.ts`: structured objective and focus
  - `lib/ops/hunter.ts`: structured question
  - `lib/director/director.ts`: arbitration hook
  - `components/ops/operation-intelligence.tsx`: decision card and Advanced view
  - `integrations/site-finder-v07/app/v2/platform_bridge.py`: one line, the meter passthrough
  - `scripts/run-tests.mjs`, `package.json`: the `adaptive-intelligence` group, plus the sql.js stand-in import for the v6 hidden step
  - `tests/joined-finder-main-hunter.mjs`: the pinned migration list now includes 0018
  - `tests/adaptive-intelligence.mjs`: check 9 now allows up to 6 bounded evaluations (the fix from regression pass 1)
- Operation Hunter 2.0 is unchanged.
