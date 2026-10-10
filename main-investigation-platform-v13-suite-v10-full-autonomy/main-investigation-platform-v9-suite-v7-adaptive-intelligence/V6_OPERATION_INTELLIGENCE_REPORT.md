# V6 Operation Intelligence Report

Release artifacts: `main-investigation-platform-v8-suite-v6-operation-intelligence.zip` and this report. Verification date: 2026-10-03 UTC.

## Release assessment

**IMPLEMENTED BUT PARTIALLY VERIFIED.** The supplied v5 platform has been upgraded with durable operation intelligence, bounded operation hunts, evidence clickthrough, temporal memory and analyst-reviewed boundaries. The real hidden discovery workflow passes, as do local production build/browser checks. This is not a claim that every requested certification scenario is complete. Environment-blocked checks and missing capabilities are identified below.

Status vocabulary: **VERIFIED** means the stated, scoped check actually ran successfully. **IMPLEMENTED BUT PARTIALLY VERIFIED** means implementation or substantial coverage exists with stated gaps. **ENVIRONMENT-BLOCKED** means the environment prevented execution. **NOT IMPLEMENTED** identifies absent capabilities. **FAILED** identifies an unresolved executed failure; earlier failures corrected by later reruns remain in diagnostic logs.

## Architecture and preservation

Main remains the coordination and durable evidence-memory layer. Operation Hunter remains the operation-inference authority. Wallet Investigator remains the wallet-validation and blockchain-evidence authority. Site Finder performs public discovery, Site Investigator collects public evidence, Logger remains passive, and Form Submitter retains exact report approval.

The only Hunter source change is its integration worker: sync now includes Hunter ACH hypotheses/evidence references, waves, infrastructure/kit history fields, finding evidence IDs and contradiction state. Hunter's inference engine has not been copied into Main. Existing Main migrations through 0016 and all supplied Wallet Logger files remain byte-for-byte unchanged; a source preservation manifest accompanies the package.

New implementation centers on `lib/ops/intelligence.ts`, `lib/ops/operation-decisions.ts`, additive migration `0017_operation_intelligence.sql`, `/operations/[id]`, the briefing component, and four operation API routes documented in `API.md`. The prior five-tool shell and module contracts remain available.

Measured workflow defects fixed during verification:

- Site Investigator's page INSERT supplied eleven placeholders for ten columns. It now names the ten columns explicitly, and a site with no collected public pages fails with its fetch-error evidence retained.
- Site Investigator's bridge now retains original source URLs.
- Main-bounded Finder lead generation could spend the entire DNS allowance on guessed variants before probing actual leads. A window inside the same meter reserves probe capacity; it does not create a second allowance.
- A changed public application build and materially changed page can be a new deployment lead despite reused contact/wallet data. Both mirror vetoes use that rule; this does not establish an operator change.
- Current authoritative v4 wallet completion marks the legacy analysis freshness state, preventing duplicate legacy analysis work.
- A Hunter-proposed new deployment now receives its own investigation/report boundary and resource enrollment. Correlation does not silently combine site reports.

## Operation, graph and hypothesis model

Ten additive tables store operation state/leases, authoritative entity references, authoritative relationship references, current hypotheses, immutable history, temporal facets, contradictions, logical hunts, review decisions and operation aliases. Existing entity/evidence/relationship records remain canonical. Indexes support projection endpoints, history and evidence-overlap queries.

Membership distinguishes **proposed**, **context**, **confirmed shared evidence** and **excluded**. Adjacent authoritative endpoints can appear as context. A wallet/counterparty context does not become membership or ownership. Generic infrastructure does not expand an entire CDN component. Analyst-origin boundaries survive subsequent Hunter syncs.

Edges retain their original relationship ID, assertion kind, source module, source evidence IDs, first/last observations and an explainable category. Categories distinguish infrastructure context, template similarity, public contact, certificate overlap, wallet observation, blockchain relationship and public artifact. An independence key identifies repeated copies of the same endpoint/category unit. Weak infrastructure/template categories do not count as useful independent gain for learning. Excluded endpoints are omitted from current graph views and learning counts, while historical records remain intact.

Hunter ACH questions become persistent testable explanations. Each keeps its supporting and challenging references, alternative explanations, uncertainty, what would strengthen/weaken it and a bounded next-test question. Missing source references remain explicitly unresolved. Confidence is nullable: an ACH score is not silently recast as a calibrated ownership probability. Hunter's `unlikely` verdict becomes **challenged**, not a definitive rejection.

Challenging evidence survives omission from a later snapshot. Contradictions retain their IDs, source references and history; resolution must be explicit. Snapshot replay does not erase prior challenges or duplicate identical history. Main does not replace Hunter's inference with an unsupported contradiction classifier.

## Temporal intelligence and operation memory

Current facet state has first/last observations and source provenance. Changed values append immutable history. Out-of-order older observations remain historical and cannot overwrite a newer state. An explicit dead/gone/suspended → live transition records a return. Hunter wave groupings are retained as possible, derived deployment waves. Wallet, public artifact, infrastructure and template observations remain traceable source facts or source analysis.

History, hypotheses, contradictions, failed/useful hunts, empty branches, reservations, decisions and aliases persist across restarts. Reappearance and rotation do not imply continuity of ownership. Main does not independently infer an absent site's death from silence.

## Operation Director, hunts, portfolio and events

Meaningful existing events coalesce to a durable dirty flag for relevant operations. Hunter sync also wakes its operation. A six-hour maintenance fallback recovers missed wakeups. Each evaluation claims a two-minute operation lease, projects at most 500 relationship rows using a durable cursor, and serves at most eight operations. Fair ordering uses the last serviced/evaluated time.

The first public discrimination is `find_related_sites`; after a public test, open contradictions can return to Hunter via `reconstruct_operation`. Questions and reasons come from stored hypotheses/source context. The scheduler uses the existing work-item, module-availability, pause and resource contracts. A deterministic operation/family/semantic fingerprint is durably reserved before work handoff, and unfinished handoff recovers that exact logical work.

Default bounds are eight reservations per operation, four active operation hunts across the portfolio, 24 newly reserved hunts per UTC day and at most two new operation hunts per evaluation. Operation-generated module jobs have one attempt and Finder receives its existing bounded HTTP/DNS/CT/RDAP contract. Selected investigations enter v5's shared resource ledger. Its job/request/provider/effort costs are conservative reservations, not measured actual network consumption.

Saturation parks an unchanged, already-tested gap, three empty completed hunts, or an exhausted per-operation allowance. New semantic evidence can wake reevaluation; it does not refill exhausted budgets. Pause persists without creating hunts. Outcome learning counts independent relationship gain, uses a beta prior and 30-day decay over at most 30 family outcomes, and affects priority only. Learning is never evidence.

**Limitations:** global operation bounds are hunt/day/concurrency bounds; existing resource reservations are principally investigation-scoped. A complete global actual-cost ledger for every downstream module is not implemented. Operation-specific causal learning for new validated sites/wallets, contradiction resolution and report readiness is not implemented. The two supported action families and coarse work factors are not a complete portfolio information-gain optimizer.

## Analyst briefing, maps and human boundaries

The default briefing shows contents, uncertainties, current activity/reason, source investigations/reports, hypotheses, challenges, recent changes and consequential reviews. Raw jobs/state/history remain under Advanced. Site, wallet, infrastructure and timeline views use bounded pages and a simplified graph; layout carries no ownership semantics. The UI renders at most 28 nodes and 60 map edges from a bounded response.

“Why connected” reads the original relationship/evidence, collection source/time, provenance and applicable Wallet Investigator validation status. Hypothesis supports/challenges have scoped source-evidence clickthrough. Original public URLs and source investigations are available. Unknown networks remain unresolved.

Association, exclusion, split and consolidation are explicit proposals with a reason, selection, exact review hash and source/target boundary revisions. Proposals do not mutate boundaries. Concurrent/stale reviews cannot both mutate one revision. Confirmation applies an atomic, replayable effect. Splits preserve source history/evidence and selected entities; consolidation preserves aliases. Historical lineage links lead to source operation records rather than relabeling their old hypotheses as fresh inference.

Duplicate detection proposes review candidates from at least two shared independent non-infrastructure/non-template evidence units and substantial target overlap. It never silently consolidates. This rule's real-world precision/recall is not calibrated.

Site reports still require authoritative readiness, exact `content_sha256` and explicit final approval. Operation hypotheses are not added as factual report evidence. Routine passive work runs without evidence shuttling. Login, CAPTCHA/MFA/email verification, consequential boundary decisions and final approval remain human actions.

## Independent labeled operation-memory benchmark

`tests/operation-benchmark.mjs` uses a corpus separate from the hidden discovery corpus: three labeled operations, unrelated kit/CDN overlap, two deposit wallets plus rotation/replacement, a common counterparty, an accidental association, a late challenge, a wave and disappearance/reappearance. Its authoritative graph and Hunter ACH snapshots are fixture inputs; it measures Main's projection/retention/boundary behavior, not autonomous Hunter inference accuracy.

| Measured result | Value |
| --- | ---: |
| Labeled operation records | 3 |
| True fixture evidence relationships recovered | 122 / 122 |
| False factual relationship records | 0 |
| Unsupported ownership claims | 0 |
| Stored hypotheses / challenged hypotheses | 6 / 1 |
| Definitively rejected hypotheses | 0 |
| Split correctness / reappearance | Passed / Passed |
| Human actions | 2 (proposal and confirmation) |
| Time to model and checks | 4000.88 ms |

110 duplicate weak overlaps retain one independence unit. The common counterparty is a transaction connection, not an operator assertion. Late contrary evidence challenges an earlier apparently strong explanation. Split boundaries survive replay and retain all five original evidence records.

The benchmark's false-record count does not establish perfect attribution: membership may remain proposed, and supplied fixture relations are known true observations. Full autonomous multi-operation inference accuracy and the entire requested outage/dead-branch scenario matrix remain unmeasured.

## Genuine hidden discovery benchmark

`tests/operation-hidden.mjs` starts Main with **one site and zero wallets**. Hidden target sites/wallets are not injected into Main. Public and blockchain transports are controlled fixture transports; real Director/scheduler, Finder engine/durable bridge, Site Investigator worker/collector, rendered DOM, unchanged Logger classifier, Wallet Investigator worker/validation/engine and Hunter pursuit/analyzer/integration run.

The corpus includes opaque domains, sequential public/CT pivots, wallet reuse then rotation, a changed public application build, an unrelated kit/CDN decoy, a transaction-history decoy and a dead branch. Main restarts on its used database after round five. Every hidden target has actual Site Finder observation provenance before the subsequent site investigation. Four next operation hunts are recorded in the measured run.

| Measured result | Value |
| --- | ---: |
| Initial seeds / wallets / hidden injections | 1 / 0 / 0 |
| Hidden target sites discovered | 3 |
| Target sites investigated through real SI | 4 |
| Distinct validated target deposit wallets | 2 |
| Useful multi-hop discoveries beyond the first pivot | 2 |
| Operation-generated next bounded hunts | 4 |
| Unsupported ownership claims / duplicate active jobs | 0 / 0 |
| Human actions | 0 |
| Jobs / jobs per useful hidden discovery | 25 / 8.33 |
| Instrumented public transport requests | 353 |
| Requests per useful hidden discovery | 117.67 |
| Blockchain provider calls | 3 |
| Final meaningful update time | 29191.75 ms |

Request-kind breakdown: `{"dns": 175, "http": 172, "tls": 6}`. Public HTTP, DNS and TLS fixture calls are instrumented; local control/API requests are excluded and blockchain provider calls are listed separately. Cache reuse is part of the measured workflow. The seed's declared deep investigation budget was configured before work; the run does not demonstrate that all depth fits the smaller default policy.

**IMPLEMENTED BUT PARTIALLY VERIFIED:** the unchanged Logger classifier reads actual rendered DOM, and typed observations go through the real compatibility API. Its installed native-extension lifecycle is a separate environment-blocked test. Synthetic transports do not certify internet recall, third-party provider reliability or access-controlled website behavior. The corpus does not establish a complete operation scenario benchmark.

## Adversarial and recovery evidence

The v6 acceptance suite passes 19 checks: canonical source lineage; 110 weak copies; identical Hunter replay; retained omitted challenges; explicit return/out-of-order protection; pause/resume; 50 actual events plus identical replay; ten concurrent evaluations; used-state restart; unfinished handoff; exact-hash split review; atomic/replayed split; persistent analyst exclusion; consolidation aliases; competing boundary reviews; exhausted bounds; duplicate-evidence review suggestions; and populated additive migration replay/rollback.

Inherited Director/provider and module regressions exercise invalid/ambiguous wallets, transaction-history context, provider recovery/cache bypass, stale report hash rejection, changed-network revalidation, submission uncertainty, human CAPTCHA stops, and secret-field rejection. The hidden corpus and labeled corpus add rotation, same-CDN/kit decoys, multi-hop pivots and late challenges. Coverage is substantial but is not the full cross-product of every requested adversarial scenario.

**18 actual SIGKILL cases passed.** Child processes are killed before/after operation snapshot mutation, hypothesis batch, contradiction batch, temporal facet batch, graph projection batch, hunt reservation batch, work handoff, operation split and event-driven wakeup. Recovery restarts the used SQLite state, advances only expired lease clocks, replays the real API and checks logical-work identity/evidence preservation. Split recovery parks the child hunt allowance while checking the original logical action; it does not claim that children never perform useful work.

These are real process kills around SQL statement/transaction boundaries in the D1 harness, not invented crash outcomes. Atomic D1-double batches execute without JavaScript interleaving. Dedicated process kills inside every WI wallet-correlation/provider call and external Finder/Hunter outbox-delivery phase are not all certified by this new suite. Inherited durable module tests add coverage but do not close that entire certification gap.

## Measured large-graph performance

Actual file-backed SQLite rows: 10,000 entities, 50,100 relationships, 5,000 evidence records, 300 investigations and 25 operations. All 50,100 relationships were projected through real Main API evaluations.

| Measurement | Local result |
| --- | ---: |
| Load fixture rows | 532.93 ms |
| Bounded Director/projection ticks | 430.49–1539.74 ms |
| Briefing / first graph+timeline page | 16.44 ms |
| Paginated graph query | 13.45 ms |
| Wallet view | 15.65 ms |
| Original connection evidence | 3.14 ms |
| Ten event wakeups | 325.58 ms |
| Subsequent portfolio evaluation | 656.07 ms |
| RSS before / after | 139,235,328 / 448,114,688 bytes |
| Peak process RSS | 439,052 KiB |
| Database before / after | 1,781,760 / 89,317,376 bytes |
| Database growth | 87,535,616 bytes |

Default response bounds: 100 graph edges (maximum 200 requested), 200 entity selections and 100 timeline entries. The briefing query includes the bounded timeline; a separately isolated timeline latency is not claimed. Browser layout/evidence interactions were tested at desktop and 375px on small populated operations. Large-graph numbers are local SQLite/D1-double measurements, not remote production D1 service-level claims or long-duration heap-leak certification.

## Migration, restart, build and regressions

Migration 0017 is additive/replayable and leaves earlier schema/data intact. Fresh application, populated v5 upgrade, repeated migration and transactional rollback are tested. Schema readiness requires the new operation tables. A rollback policy is to pause automation, back up the complete used database, keep 0017 tables for a code rollback where supported, or restore the full pre-upgrade backup. No automatic destructive down-migration is supplied; restoring an old backup loses subsequently acquired data. Active standard jobs/work items should be reconciled before a code rollback.

| Verification | Final status |
| --- | --- |
| Node 24 platform unit suite | VERIFIED: 37 passed, one pre-existing alternate sql.js-path skip |
| Node 22 operation acceptance | VERIFIED: 19 checks |
| Main TypeScript / production build | VERIFIED |
| Hunter server TypeScript / tests | VERIFIED: 44 passed, one integration-environment skip |
| Dedicated operation UI | VERIFIED: 7 interaction/layout checks, no page errors |
| Actual production worker/D1/browser | VERIFIED: source records, graph edge, hypothesis source, 375px layout and legacy routes |
| Full controls at first start + used-state restart smoke (12 controls/page) | VERIFIED |
| WI validation / worker | VERIFIED: 26 validation tests and worker cases |
| Wallet report pipeline in process | VERIFIED: exact hashes, approval, CAPTCHA stop and no automatic repeat after uncertain submission |
| Installed native extension/browser pipeline | ENVIRONMENT-BLOCKED |
| Windows native execution | ENVIRONMENT-BLOCKED: no Windows host |

| Broad regression group | Status |
| --- | --- |
| migration-matrix | VERIFIED |
| loops | VERIFIED |
| integration:v6 | VERIFIED |
| v2 | VERIFIED |
| v3 | VERIFIED |
| v4 | VERIFIED |
| v5 | VERIFIED |
| joined:hunter | VERIFIED |
| joined:v61 | VERIFIED |
| five-modules | VERIFIED |
| startup:modules | VERIFIED |
| site-finder | VERIFIED |
| director | VERIFIED |
| operation-intelligence | VERIFIED |

The full first pass hydrated 21 pages, enumerated 423 controls and recorded 387 clicks with zero failures. Its 34 warning entries identify changing content, absent controls after earlier actions or effect-isolation limits; details remain in the packaged sweep JSON. The restart smoke hydrated 21 pages and clicked 244 controls, with 0 warnings and zero failures.

The aggregate initial regression log retains two corrected failures: the old Hunter test expected a new correlated site to share the holding investigation (now strengthened to assert its own site/report boundary), and the all-controls sweep identified controls rendered within a collapsed boundary panel. The latter now mounts its controls when opened. A subsequent sweep found three SVG click targets obstructed by labels: accessible targets now belong to the visible circles, operation markers render above nodes and coincident markers are spaced apart; the cross-investigation graph also excludes labels from pointer hit testing. The overlap review-target action now opens its form, verified by an additional real browser interaction. Regression assertions remain active; the Hunter expectation was updated to verify the intentional per-site boundary change. Migration-test setup now applies required earlier dependencies, and the new dynamic operation page is included in the sweep. Final focused rerun logs supersede those earlier failures. The native extension fails on prohibited browser IPC (`socket()` / operation not permitted); it is not counted as passed. The used-state browser restart binds a new random localhost port. The existing in-process wallet/report workers retain the original test URL and log connection refusals while the browser smoke targets the restarted API. That smoke verifies retained UI/API state, not complete module reconnection after a changed endpoint; those background refusals are a harness limitation, not a clean whole-stack restart claim.

## Wallet Logger 1.0 and safety notes

All supplied Logger source remains unchanged and `wallet.observation` 2.0.0 remains supported. No account vault, standalone blockchain UI, password/provider credential/session-secret ingestion, private-key or seed-phrase storage was added. Existing secret-field validation remains active. Main receives permitted observations and provenance; WI remains authoritative within Main.

The new actions remain public/passive discovery or read-only analytical work. No credential guessing, brute force, credential spray, verification bypass, exploitation, session theft or financial transactions were introduced. Form approval and uncertainty protection remain intact.

## Requirement-by-requirement scope

| Requested area | Status | Scope / gap |
| --- | --- | --- |
| 1. Living operation model | VERIFIED | Scoped behavior verified by tests below. |
| 2. Evidence / relationship / hypothesis | VERIFIED | Scoped behavior verified by tests below. |
| 3. Operation hypotheses | VERIFIED | Scoped behavior verified by tests below. |
| 4. Hypothesis testing | IMPLEMENTED BUT PARTIALLY VERIFIED | Questions come from Hunter; two bounded action families execute them. No general structured test compiler. |
| 5. Contradiction engine | IMPLEMENTED BUT PARTIALLY VERIFIED | Retention, explicit resolution and late challenges verified; comprehensive independent contradiction accuracy not certified. |
| 6. Alternative explanations | VERIFIED | Scoped behavior verified by tests below. |
| 7. Operation graph | VERIFIED | Scoped behavior verified by tests below. |
| 8. Temporal operation intelligence | IMPLEMENTED BUT PARTIALLY VERIFIED | History/facets replay and temporal regressions verified; all real-world rotation interpretations remain Hunter responsibilities. |
| 9. Operation timeline | VERIFIED | Scoped behavior verified by tests below. |
| 10. Reappearance detection | VERIFIED | Scoped behavior verified by tests below. |
| 11. Operation-wide evidence gaps | IMPLEMENTED BUT PARTIALLY VERIFIED | Hunter questions/contradictions drive gaps; no complete typed gap ontology. |
| 12. Autonomous hunt generation | IMPLEMENTED BUT PARTIALLY VERIFIED | Real Finder/Hunter work flows are bounded; specialized hunt families remain limited. |
| 13. Hunt value | IMPLEMENTED BUT PARTIALLY VERIFIED | Existing work factors plus decayed family yield; no calibrated expected-information model. |
| 14. Operation saturation | VERIFIED | Scoped behavior verified by tests below. |
| 15. Portfolio intelligence | IMPLEMENTED BUT PARTIALLY VERIFIED | Fair service order, active/day caps and v5 resource policy; no complete portfolio utility optimizer. |
| 16. Campaign / deployment waves | IMPLEMENTED BUT PARTIALLY VERIFIED | Hunter waves are retained with derived semantics; no duplicate Main wave inference. |
| 17. Wallet intelligence across operations | IMPLEMENTED BUT PARTIALLY VERIFIED | Authoritative wallet/transaction projection and validation display; full temporal convergence/divergence analysis not certified. |
| 18. Evidence strength model | VERIFIED | Scoped behavior verified by tests below. |
| 19. Evidence lineage | VERIFIED | Scoped behavior verified by tests below. |
| 20. Operation briefing | VERIFIED | Scoped behavior verified by tests below. |
| 21. Operation map | VERIFIED | Scoped behavior verified by tests below. |
| 22. Why connected | VERIFIED | Scoped behavior verified by tests below. |
| 23. What would change our mind | VERIFIED | Scoped behavior verified by tests below. |
| 24. Associations and splits | VERIFIED | Scoped behavior verified by tests below. |
| 25. Duplicate operation detection | IMPLEMENTED BUT PARTIALLY VERIFIED | Evidence-overlap candidates and explicit consolidation; recall/precision over many real operations unmeasured. |
| 26. Site-specific reporting | VERIFIED | Scoped behavior verified by tests below. |
| 27. Human policy | VERIFIED | Scoped behavior verified by tests below. |
| 28. Operation memory | VERIFIED | Scoped behavior verified by tests below. |
| 29. Adaptive decision intelligence | IMPLEMENTED BUT PARTIALLY VERIFIED | Decayed beta prior over independent relationship gain; validated-site/wallet/report-specific causal learning not implemented. |
| 30. Event-driven operation intelligence | VERIFIED | Scoped behavior verified by tests below. |
| 31. Safety boundaries | VERIFIED | Scoped behavior verified by tests below. |
| 32. Operation benchmark | IMPLEMENTED BUT PARTIALLY VERIFIED | Independent labeled memory corpus plus hidden discovery corpus; not a complete independent Hunter inference accuracy benchmark. |
| 33. Hidden end-to-end benchmark | IMPLEMENTED BUT PARTIALLY VERIFIED | One-seed real module path passes; synthetic public/blockchain transports and Logger DOM classifier substitution are explicit. |
| 34. Adversarial tests | IMPLEMENTED BUT PARTIALLY VERIFIED | Focused and inherited adversarial checks pass; complete cross-product operation/provider scenarios not certified. |
| 35. Crash/restart certification | IMPLEMENTED BUT PARTIALLY VERIFIED | 18 actual SIGKILL recoveries; dedicated crashes inside WI correlation and live external Hunter/Finder delivery are not all certified. |
| 36. Performance | IMPLEMENTED BUT PARTIALLY VERIFIED | Large local SQLite/D1-double measurements; no production-scale remote D1 or long-duration browser graph profiling. |
| 37. Preserve v5 | IMPLEMENTED BUT PARTIALLY VERIFIED | Broad regressions plus corrected focused reruns; installed-extension lifecycle remains environment-blocked. |
| 38. Wallet Logger 1.0 boundary | VERIFIED | Scoped behavior verified by tests below. |
| 39. Release gate | IMPLEMENTED BUT PARTIALLY VERIFIED | Build, local production worker/browser, Node 22/24 and migration tests pass; Windows and native extension certification unavailable. |

## Absent capabilities and remaining certification gaps

**NOT IMPLEMENTED:** complete typed evidence-gap/test ontology; calibrated marginal information-gain optimization; causal outcome learning separately targeting validated sites/wallets, resolved contradictions and report readiness; a complete global actual-cost ledger for all downstream modules; automatic destructive rollback. These are not inferred from the simpler implemented policies.

**IMPLEMENTED BUT PARTIALLY VERIFIED:** full independent autonomous multi-operation inference accuracy; every requested outage/provider-flapping/rotation scenario combination; every internal wallet/external handoff crash phase; production-scale remote D1 stress, sustained memory profiling and large-graph browser performance. The tested local and synthetic scopes should not be expanded into those claims.

**ENVIRONMENT-BLOCKED:** native installed-extension browser lifecycle and Windows execution. No bypass was attempted.

**FAILED:** no unresolved product failure is intentionally waived. The final verification manifest distinguishes corrected diagnostic failures, environment-blocked groups and final passing reruns. Any incomplete final gate is explicitly listed above, rather than reported as a clean certification.

## Reproduction and package contents

Install normal dependencies/module Python requirements using the existing portable installers. Apply all migrations in order. Set legitimate module credentials in the normal local environment; no local credential file is included. Place `operation-hunter-v2.0` beside the Main directory or set `HUNTER_DIR`. Set `MIP_PYTHON` if Python resolution needs an explicit interpreter. Install Playwright browsers for UI tests.

Run `npm run test:operation-intelligence`, `node scripts/run-tests.mjs all`, `npm run build` and the production smoke script. The new operation group covers acceptance, actual kills, the labeled memory corpus, large graph, hidden workflow, briefing UI and SI page/failure regressions. Existing Finder tests include new allowance/template-variant guards. Verification JSON/logs/screenshots are under `verification/operation-v6`; prior v5 evidence remains under its original directory.

The ZIP contains the updated Main source and original sibling Hunter source with its additive integration change. Dependencies, runtime data, local credential files, generated builds and transient caches are excluded. Both requested deliverable names are preserved exactly.
