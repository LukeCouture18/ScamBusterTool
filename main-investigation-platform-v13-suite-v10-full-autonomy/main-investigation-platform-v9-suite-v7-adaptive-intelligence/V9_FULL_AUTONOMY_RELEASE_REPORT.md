# Main Investigation Platform v9 — Full Autonomy Release Report

**Release date:** 2026-10-03. **Deliverable:** `main-investigation-platform-v11-suite-v9-full-autonomy.zip`.

This is the full modified source bundle, regression evidence and local startup workflow produced from the supplied v8 code. The central two-action workflow passed the rendered-browser/local-provider acceptance cases. **The complete requested success criterion is not certified:** Finder v4 did not demonstrate a major quality improvement, scientific generalization failed on the independent holdout, complete native UI unification remains partial, and source ESLint remains failing. These are implementation/quality shortcomings, not environmental blockers. Only actual installed-extension lifecycle and native Windows checks are labeled ENVIRONMENT-BLOCKED.

The report separates executed checks from implementation and from quality scores. A benchmark JSON's `ok: true` establishes successful measurement; it does not make a poor score pass. Local synthetic chain/form receipts are never described as live-provider or external-destination verification.

## Status definitions and release gate

| Status | Meaning |
| --- | --- |
| VERIFIED | The named behavior passed the described executed check, within its stated scope. |
| IMPLEMENTED BUT PARTIALLY VERIFIED | Code exists, but relevant real-world or combinatorial coverage remains incomplete. |
| ENVIRONMENT-BLOCKED | A specific execution was prevented by an observed environment restriction. |
| NOT IMPLEMENTED | The requested capability or complete form is absent. |
| FAILED | An executed assertion or quality objective was not satisfied. |

| Area | Status | Evidence / qualification |
| --- | --- | --- |
| Normal coordinated workflow | VERIFIED in local rendered fixtures | 14 cases; real Main API, passive content.js, WI worker and Form worker; synthetic provider/form transports |
| Actual installed Logger lifecycle | ENVIRONMENT-BLOCKED | Chromium persistent extension startup aborts at singleton/socket creation with EPERM; transport shim is not equivalent |
| Native Windows | ENVIRONMENT-BLOCKED | No Windows runtime available; Node 22/24 on Linux is not Windows certification |
| Finder v4 major improvement | FAILED | 518 useful discoveries versus v3 520; only small cost savings |
| Scientific independent generalization | FAILED | v9 optimum 2/36; confirmation baseline 6/36 and lower regret |
| Complete scientific world/DB simulator integration | NOT IMPLEMENTED | Four production DB scenarios added; full counterfactual world simulator still uses observable snapshots |
| Complete native UI redesign and control certification | IMPLEMENTED BUT PARTIALLY VERIFIED | Shared tokens, responsive repairs and default changes; full native dialogs/errors/populated controls not certified |
| Uniform status vocabulary everywhere | NOT IMPLEMENTED in full | Main status adapter exists; native specialist vocabularies still differ |
| Source ESLint | FAILED | 38 errors and 223 warnings in source-scoped run; TypeScript/build checks are separate |
| Migration / crash / large-state execution | VERIFIED locally | Additive 0020, populated preservation/replay, 30 SIGKILL edges, stated large-state fixture |

## Architecture and normal operator experience

Main owns investigation context, authoritative source lineage, bounded scheduling, report readiness, exact approval and durable recovery. Specialists execute their existing typed capabilities. `lib/autonomy.ts` projects the operator state and human checkpoints over the Director, wallet pipeline, scheduler, operation reasoning and report records. The projection does not itself create arbitrary specialist work. New migration `drizzle/0020_full_autonomy.sql` adds autonomy state/history/checkpoints, exact-report claims and hypothesis matches plus scoped indexes. No old migration was rewritten.

**Normal case:** enter/open a site through **Investigate Site**; Main creates or resumes its site-specific investigation. Browse normally with the configured Logger. The platform observes/classifies/deduplicates, invokes WI, preserves the response, performs bounded useful follow-up and builds the report. When Director and executable-queue checks agree it is ready, Main presents **Report ready. Submit?**, confirmed deposit addresses, networks, evidence and destination. Review, then **Approve & Submit** once. No routine copying, tool transition or specialist launch is required in the accepted fixtures.

The local launcher `npm run start:suite` starts all six services and drives the same shared maintenance implementation as the deployed Worker every 15 seconds. `lib/maintenance.ts` handles persisted events, feedback, monitoring, inbox supply, due investigation runs and the leased scheduler; `/api/v1/ops/maintenance` is its local entry. This was exercised against the actual compiled Worker. The deployed five-minute scheduled entry uses the same function. Local maintenance is bounded and the launcher avoids overlapping requests; the durable scheduler lease remains authoritative.

**Login case:** Main shows the legitimate access blocker, reason, login URL/action and what resumes afterward. The operator handles credentials, CAPTCHA, MFA and email verification in the investigated site's browser. New passive deposit evidence clears the relevant login blocker; **Continue Investigation** is also available. The benchmark's login is an ordinary fixture button, not a real third-party authentication session. No authentication bypass is performed.

**Needs You policy:** an item has four fields: what happened, why Main stopped, what the operator must do, and what Main will do afterward. Login/verification, material network ambiguity, missing destination information, exact final approval, analyst merge/split and uncertain submission are real human checkpoints. Routine provider retries and module reconnection are handled by maintenance and should not be phrased as analyst chores. This policy is implemented; complete coverage of every inherited specialist failure message is partial.

## Passive browser and automatic wallet pipeline

Logger retains `wallet.observation` **2.0.0** compatibility. Existing passive text/input/deposit/modal/tab/dynamic/Shadow DOM/QR/copy/script/visible-response detection remains. Main uses the page's site-specific investigation rather than attaching all sightings to Hunter's current context. Classification keeps deposit, withdrawal, example, history, contract, unrelated and unknown separate. Main never treats a blockchain-shaped string or Logger confidence as authoritative blockchain validity.

A relevant observation preserves page URL, domain, context, method, timestamps, source/version and upstream lineage, deduplicates the candidate, and schedules authoritative WI validation. Deterministic validation and network ambiguity remain. Only a **valid, relevant deposit** enters report readiness; example, withdrawal, history and contract contexts do not silently become confirmed deposits. EVM network hints must be explicit evidence; the code does not guess a chain.

WI performs read-only analysis. Ordinary mode no longer falls through to the inherited synthetic primary provider: synthetic fixtures require their explicit test flag. Real adapters added:

| Adapter | Scope | Bounds and limits | Verification |
| --- | --- | --- | --- |
| Blockstream Esplora | Confirmed Bitcoin UTXO/address facts | Fixed HTTPS GET endpoint; overview plus at most two 25-record pages; 10-second request deadline; 2 MB response cap; bounded inputs/outputs; always PARTIAL | Fixture response/error/malformed/dedup tests; one real public read succeeded |
| Blockscout Pro | Explicit Ethereum, Optimism, Base, Arbitrum, Polygon, BSC | Local specialist key; overview plus at most two native and two ERC20 pages; fixed HTTPS GET endpoint; finite allowlisted cursor; dedup/row validation; always PARTIAL | Three response/error/adversarial fixture tests; live keyed EVM read not verified |
| Other preserved validators | Tron, Solana, XRP/LTC/Doge and other existing validation states | Deterministic validation retained; no new live activity adapter for these networks | Live activity coverage NOT IMPLEMENTED |

The real Bitcoin attempt returned **25 records in two HTTP requests**, with `PARTIAL` coverage. This proves that particular adapter fetch, not live end-to-end reporting or comprehensive chain coverage. Provider unavailable remains explicit when an applicable real adapter/key is absent. Internal EVM transfers/NFTs, Bitcoin pending history and token/inscription protocols are outside these new adapters. Missing balances do not become confident zero-balance facts. BTC/Base58 addresses retain case-sensitive cache keys; only explicit EVM identity is normalized to lowercase.

Provider observations, deterministic normalization, derived analysis and analyst hypotheses remain separate. Balances/activity/counterparty summaries reflect only retrieved coverage. Transactions, common exchange counterparties and shared infrastructure do not establish ownership. Provider HTTP counts, adapter calls and elapsed worker cost are instrumented on successful delivery; Finder meters retain the reported source. This is practical cost coverage, not a complete independent cost ledger for every specialist/failure path.

## Report and submission lifecycle

Main builds an immutable evidence-backed candidate and plain summary when authoritative evidence is sufficient. Approval binds exact `content_sha256` and destination. Changed content invalidates an unclaimed approval; no changed report is silently submitted. A deterministic exact-hash claim prevents duplicate logical submission jobs. Recovery publishes an already approved candidate after a crash without manufacturing a new human approval.

Form Submitter rechecks destination/version, wallet list, frozen evidence resolution, required fields, exact hash and duplicate state. It records the attempt durably before the remote call. Verified receipts are stored as evidence. Lost acknowledgement/confirmation stays verification-unknown/Needs You and does **not** automatically send again. Sign-in, CAPTCHA, destination unavailable and human verification remain explicit. The accepted fixtures recorded 11 verified local receipts from 11 approved reports. External configured Google Form submission was not performed in this release verification.

## Operator states, stopping and recovery

The durable operator projection has all 13 requested states: Starting; Investigating site; Waiting for login; Looking for wallet; Validating wallet; Analyzing wallet; Checking related evidence; Building report; Ready for approval; Submitting; Submitted; Parked; Needs you. History changes only when semantics change. Submission verification-unknown is distinct from verified Submitted.

Queue inspection separates runnable, running, waiting provider, waiting human, waiting scheduled revisit, superseded, completed, failed retryable, failed final and orphaned. Future retries are parked with a due time, disconnected specialists do not look executable, and exact ready reports do not remain falsely busy. Existing WAITING_FOR_MODULE runs wake when a specialist is available and no active job remains. Scoped completed-job proof resolves stale legacy site work; it does not globally discard unrelated human work. Seven observed stale work items from the inherited hidden workflow were reconciled, and the final hidden run reached no queued/running module jobs or work.

Budget exhaustion, low marginal utility, saturation, exhausted important gaps, a future provider retry and human-only work stop or park automatically. The absence of executable work is not proof that no wallet exists on the Internet. In the acceptance no-wallet/unsafe fixtures SI is unavailable during isolated readiness evaluation: their Parked result demonstrates honest lack of executable work, not exhaustive wallet absence. The default fallback for some healthy idle no-wallet states still needs broader liveness certification.

Restart, event replay, duplicate source observations, stale queues, exact approval recovery and uncertain submission are covered by executed local tests. Browser restart closes/reopens the rendered browser context; Main restart retains the same port and file-backed database. Specialist restart/reconnect and provider outage behavior preserve existing suites and recovery paths. The 30-edge crash matrix does not certify every remote transport loss or a real in-flight external form process.

## Site Finder v4 and Hunter coordination

Finder v4 adds novelty/marginal-value ranking, category distinctions, saturated/generic/dead-branch suppression and temporal revisit handling while preserving v3 selection behind `SITE_FINDER_POLICY=v3`. The nine category model distinguishes novel useful deployment, known deployment, generic neighbor, template-only similarity, likely unrelated, dead, reappeared, possible replacement and needs investigation. Bounded per-round HTTP/DNS caches reduce repeated transport work; cache lifetime is explicitly ended after a round, including exceptional exits, so later watch/reappearance checks see changed public data.

Public certificate/DNS/domain/infrastructure/artifact/contact/wallet/temporal clues stay finite. New automatic candidates must clear a marginal-value threshold before Main considers safe public investigation. Raw discovered wallet artifacts remain candidate clues until WI validates them. The 14-case related fixture proves actual Finder discovery; its isolated approval stage retires specialist availability and does not prove a complete child-site lifecycle. The separate hidden joined workflow proves downstream public investigation and validation across newly found targets.

Hunter is consulted automatically for useful validated multi-site reconstruction. Per-site investigation context fixes the previous cross-site attachment risk. Public kit/provider overlap and copied evidence remain alternatives rather than ownership. Human approval continues to govern operation boundary changes.

### Finder v3/v4 identical hard pursuit corpus

Eight hard scenarios × seeds 101/203/307 × eight rounds, identical provider corpus, budgets and review slots; 24 runs per policy. Synthetic public transports; no Internet-discovery accuracy claim. Final metric JSONs are `finder-v3-pursuit.json` and `finder-v4-pursuit-release.json`.

| Metric | v3 | v4 |
| --- | --- | --- |
| Useful new sites (sum) | 520 | 518 |
| Requests (sum) | 75985 | 75073 |
| Precision (mean) | 0.9327 | 0.9327 |
| Multi-hop discoveries (mean/run) | 6.125 | 6.0833 |
| Useful campaigns/operations (mean/run) | 8.2083 | 8.2083 |
| Reappearances (mean/run) | 1.75 | 1.7083 |
| Requests/useful (mean of run ratios) | 168.4958 | 166.9542 |
| Dead-end queries (mean/run) | 167.6667 | 168.0833 |
| Repeated queries (mean/run) | 35.5 | 35.625 |
| False cross-operation relations | 0.0 | 0.0 |

**FAILED major improvement.** Useful yield decreased from 520 to 518 and precision stayed the same. Total requests decreased about 1.2%; mean requests/useful improved about 0.9%. These small savings do not satisfy a major upgrade. Replacement-site recall and fully independent campaign labels are not separately certified by this aggregate; dead-end/repeated-query counts are proxies, not a complete duplicate-site/dead-branch audit. This pursuit benchmark does not expose a comparable end-to-end job count.

### Final joined seven-page hidden workflow

One seed and zero initial wallets; hidden targets reach Main through real Finder, SI, passive classifier, WI and Hunter paths, with synthetic public/chain transports. Identical final source and `PYTHONHASHSEED=101` are used for the final v3/v4 pair. No hidden site/evidence injection and zero unsupported ownership claims.

| Metric | v3 | v4 |
| --- | --- | --- |
| Hidden useful sites | 3 | 3 |
| Target sites investigated | 4 | 4 |
| Validated target wallets | 2 | 2 |
| Requests | 474 | 474 |
| Jobs | 36 | 34 |
| Jobs/useful discovery | 12 | 11.333333333333334 |
| Multi-hop useful discoveries | 2 | 2 |
| Quiescent at | {'round': 15, 'requests': 474} | {'round': 13, 'requests': 474} |
| End-to-end elapsed ms | 41260.351989 | 41285.077499 |

Elapsed times are single-run, concurrent-environment observations, not a statistically certified speed improvement. Useful target discovery and wallet recall, not additional unrelated domains, define the hidden score. The JSON includes request/job/source traces and zero duplicate active jobs.

## Scientific intelligence and inherited v8 fixes

The supplied v8 report was inspected before changes. Initial carried-design, held-out and v8 acceptance runs are retained in `inherited-decision.log`, `held-out-decision.log` and `v8-acceptance.log`. The unchanged v7 baseline and preserved `v8ScientificChoice` provide direct comparators. Baseline reproduction exposed the saturation-ranking and quiescence failures; fixes were evaluated separately from broad regression assertion success.

| Inherited problem | Work and final status |
| --- | --- |
| Held-out generalization | Branch-local novelty and information preference improve the old held-out structures, but independent generalization FAILED; carried v8 design performance also regressed. |
| Fresh vs saturated branch | Removed unrelated history from branch freshness; saturated/duplicate branches are discounted; fresh artifact choice improves in the carried case. VERIFIED on these fixtures, broad generalization partial. |
| Hypothesis-specific matching | Frozen scoped/versioned baseline and planned hypotheses; different later same-site validated deposit weakens unchanged wallet, supports possible rotation, and same network weakens a network-change-only explanation. Unknown remains legitimate. VERIFIED in DB fixtures. |
| Information separation | Family-compatible question selection and bounded heuristic discrimination preference implemented. Calibrated probabilistic expected-information separation NOT IMPLEMENTED. |
| Queue quiescence | Scoped stale-work reconciliation, parked provider timing, module wake and truthful execution classes; final hidden workflow quiescent. VERIFIED locally. |
| Full simulator integration | Four real DB plan→delivery→match→revision→attribution→family-learning→next-choice scenarios. Complete hidden counterfactual simulator through the entire production DB loop NOT IMPLEMENTED. |
| Split/merge correctness | Existing operation regressions pass; cautious boundary rules require evidence and hashed human decision. Full independently scored split/merge correctness corpus NOT IMPLEMENTED. |
| Decision-learning v2 | Six of seven scientific outcome kinds exercised; operation_split_confirmed code requires a later approved boundary plus correlated authoritative wallet/contact evidence, but that seventh causal-credit loop lacks full integration certification. PARTIAL. |
| Actual specialist costs | WI provider/HTTP/elapsed meters and Finder reported cost source added; all-specialist and failed-transport actual cost accounting remains PARTIAL. |
| DB/history growth | Unchanged scientific reads no longer add history; actual projection/index growth remains large and is measured below. Total growth goal NOT SOLVED. |

Four DB integration cases precommit a plan before source delivery: changed authoritative deposit, generic provider alternative, observed replacement continuity, and failed/inconclusive public check. Each asserts exact plan hash, hypothesis-specific matches, directly attributed credits, replay idempotency, production family learning after the attribution barrier and the next actual policy choice. Six requested causal outcome categories occur across these fixtures. Replacement continuity is an explicit SI facet in this test; emission across every real discovery path is not certified. Failed checks earn no invented negative evidence. Copies sharing upstream lineage do not count as independent categories; two contacts are still one category. No ownership relationship is created by the reasoning projection.

### Decision quality: three separate partitions

| Partition | Policy | Optimal rate | Near-optimal rate | Mean regret |
| --- | --- | --- | --- | --- |
| Design (42) | v7 | 0.548 | 0.571 | 0.432 |
| Design (42) | v8 | 0.738 | 0.762 | 0.195 |
| Design (42) | v9 | 0.595 | 0.619 | 0.3 |
| Design (42) | confirmation | 0.452 | 0.452 | 0.434 |
| Old structures / new seeds (64) | v7 | 0.625 | 0.672 | 0.271 |
| Old structures / new seeds (64) | v8 | 0.578 | 0.625 | 0.261 |
| Old structures / new seeds (64) | v9 | 0.688 | 0.734 | 0.176 |
| Old structures / new seeds (64) | confirmation | 0.391 | 0.391 | 0.41 |
| New compound structures (36) | v7 | 0.0556 | 0.0833 | 2.041 |
| New compound structures (36) | v8 | 0 | 0.0278 | 1.9573 |
| New compound structures (36) | v9 | 0.0556 | 0.0833 | 1.9533 |
| New compound structures (36) | confirmation | 0.1667 | 0.1667 | 1.7057 |

**FAILED broad scientific improvement.** v9 improves old held-out optimum from v8 57.8% to 68.8%, but its carried-design score decreases from v8 73.8% to 59.5%. The independent corpus uses six new compound structures, 2–4 competing operations and six disjoint seeds, with the production policy frozen before evaluation. v9 is optimal in only 2/36 states and loses to the confirmation baseline's regret. Identifier/world-seed holdout on familiar structures is not evidence of structural generalization. No hidden truth imports are permitted in production, and Unknown/uncertainty semantics were not weakened to inflate scores.

## UI design system and audited surfaces

Shared navy tokens cover colors, typography, spacing, cards, buttons, tabs, tables, forms, borders, focus and disclosure. `scripts/sync-ui-tokens.mjs` distributes native overrides. This includes concrete interaction/layout work: Main's primary start action and five simple dashboard sections, investigation/report plain summaries, Advanced relocation, WI default Wallets, Form default Reports and hidden tests, wrapping navigation/header controls, focus-visible targets and narrow column layouts. Complete redesign of every native information hierarchy, error/empty/loading/dialog state is NOT IMPLEMENTED.

| Surface | Executed audit | Remaining coverage |
| --- | --- | --- |
| Main home / investigations / Needs You | Two full hydrated 21-page control sweeps; default and Advanced; start/report/context assertions | State-changing controls can disappear before later cold loads; their warnings remain in results |
| Main Finder / Hunts / investigation modes | Discovery reasons, chain, investigations, optional detail controls and navigation | All large populated states are not independently enumerated |
| Main wallet / reports / Logger integration | Context movement, plain flow, evidence, exact report and submission controls; narrow layouts | Native installed extension popup/options lifecycle blocked and not covered by this smoke |
| Main operation / Hunter / Advanced | Evidence connection dialog, original hypotheses, map/source evidence, large-state bounded views | Full populated native Hunter reconstruction dialog/control audit incomplete |
| Native WI | Eight tabs plus default, at 1280/1024/375; real production server | Data-dependent wallet/graph dialogs/errors not complete |
| Native Form Submitter | Five navigation views/default at three widths; configured synthetic browser settings, automatic sending disabled | Initial real-user configuration, actual destination sign-in/errors and every modal not certified |
| Native Finder | Default page at three widths, actual Flask server | Every native tab/result/dialog/loading/error state not certified |
| Native Site Investigator | Search/Create case/default at three widths, actual server | Every populated case/site/authentication dialog not certified |
| Native Hunter | Default at three widths, actual production/static server | All operation tabs and populated controls not certified |

Before restart: **21 pages, 466 enumerated controls, 430 activated, 14 already active, 2 external links**, zero reported failures. After restart: **21 pages, 450 controls, 427 activated, 13 already active, 2 external links**, zero failures. There are **35/21 warnings**: content removed by earlier mutations or effects indistinguishable from an idle update. They prevent a claim that every originally enumerated control's effect was isolated. The sweep opens nested Advanced/details before enumeration; it is not a screenshot-only check. External links are validated, not remotely exercised.

Native audit: **60 views**, no page errors and no horizontal overflow at the tested widths. Earlier real overflow failures were fixed in WI, Form, Finder and SI. Native uniform status language remains incomplete; Main maps raw RUNNING/PROCESSING/ACTIVE_JOB-like states to the common operator vocabulary but not every native specialist does. Context includes site, wallet, operation and investigation in Main's optional specialist views. The default Related sites list only includes explicit related_site entities; it is not yet a complete display of every Finder-created child investigation. Back/context tests pass their stated paths; universal native navigation context is partial.

## Autonomy benchmark and human actions

Fourteen rendered sites, actual passive `content.js` with a Chrome message transport shim, real Main routes and real WI/Form workers. Provider responses and authorized form receipt transport are fixtures. Browser actions are individually recorded; API acknowledgement replay, scheduler/worker steps, simulated retry-clock advancement and independent rate-limit windows are not counted as human actions. Start/approval are exercised through the real API here; the separate Main browser suite exercises the corresponding controls. Timing starts at the per-case start API after shared browser preparation, not from cold browser launch.

| Case | Actions | Manual transitions | Valid deposit wallets | Auto reports | Jobs at readiness | Readiness ms | Final state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| public | 2 | 0 | 1 | 1 | 1 | 1852 | Submitted |
| login | 3 | 0 | 1 | 1 | 2 | 1276 | Submitted |
| modal | 3 | 0 | 1 | 1 | 1 | 1372 | Submitted |
| qr | 2 | 0 | 1 | 1 | 1 | 1491 | Submitted |
| dynamic | 3 | 0 | 1 | 1 | 1 | 1422 | Submitted |
| decoys | 2 | 0 | 1 | 1 | 5 | 1532 | Submitted |
| ambiguous | 1 | 0 | 0 | 0 | 1 | 132 | Needs you |
| outage | 2 | 0 | 1 | 1 | 2 | 2677 | Submitted |
| browser-restart | 2 | 0 | 1 | 1 | 1 | 1431 | Submitted |
| main-restart | 2 | 0 | 1 | 1 | 1 | 2470 | Submitted |
| wallet-change | 2 | 0 | 2 | 1 | 2 | 1876 | Submitted |
| related | 2 | 0 | 1 | 1 | 2 | 4606 | Submitted |
| no-wallet | 1 | 0 | 0 | 0 | 0 | 140 | Parked |
| unsafe | 1 | 0 | 0 | 0 | 1 | 201 | Parked |

Total: **28 human actions**, **0 routine manual module transitions**, **12 validated relevant wallets**, **11 reports prepared/approved and locally verified once**. Applicable reportable-case deposit recall and precision are **1.0 in this fixture corpus**. All cases record zero duplicate jobs/reports; normal cases record zero unnecessary questions. Ambiguous/no-wallet/unsafe cases stop honestly instead of manufacturing a report. These are finite fixture outcomes, not population-level precision, Internet recall or a certified installed-extension workflow. QR, login/modal/dynamic and real browser-context restart are included. Lost confirmation is separately checked in the joined submission failure path and crash matrix.

## False-positive and uncertainty results

Executed suites cover generic CDN/hosting/kit, common counterparty/transaction relationships, copied upstream artifacts, example/withdrawal/history/contract wallet contexts, malformed/unrelated provider records and negative-evidence discipline. Decoy addresses were not promoted to reportable deposits. Different same-category contacts did not count as two independent evidence categories. The hidden workflow records zero unsupported ownership claims. Generic-only overlap supports kit/provider alternatives, not same-owner attribution. Provider outage/unknown network/failed bounded checks remain unavailable, ambiguous or inconclusive. Unrelated QR behavior is retained in Logger regressions; the new fourteen-case QR scenario is a relevant QR, not an independent broad unrelated-QR corpus.

## Actual crash/restart matrix

| Phase | Before | After |
| --- | --- | --- |
| site investigation | SIGKILL / passed | SIGKILL / passed |
| wallet observation ingestion | SIGKILL / passed | SIGKILL / passed |
| candidate deduplication | SIGKILL / passed | SIGKILL / passed |
| validation scheduling | SIGKILL / passed | SIGKILL / passed |
| Wallet Investigator completion | SIGKILL / passed | SIGKILL / passed |
| provider retry | SIGKILL / passed | SIGKILL / passed |
| operation update | SIGKILL / passed | SIGKILL / passed |
| report rebuild | SIGKILL / passed | SIGKILL / passed |
| exact approval | SIGKILL / passed | SIGKILL / passed |
| submission handoff | SIGKILL / passed | SIGKILL / passed |
| lost confirmation | SIGKILL / passed | SIGKILL / passed |
| Finder hunt handoff | SIGKILL / passed | SIGKILL / passed |
| Hunter update | SIGKILL / passed | SIGKILL / passed |
| queue reconciliation | SIGKILL / passed | SIGKILL / passed |
| scientific revision | SIGKILL / passed | SIGKILL / passed |

**30 actual child-process SIGKILL edges passed.** Each restart uses the persisted local SQLite D1 double and production workflow functions. Source evidence survives; logical wallet/report candidates and active jobs remain unique; exact approval is replayed safely; uncertain submission does not create another send job. Specialist delivery facts are preloaded for specific boundaries. This matrix is not remote D1, live-provider concurrency, or an in-flight external destination's crash certification. Existing v6/v7/v8 crash suites also run in the broad gate.

## Migration and performance

Migration has **151 populated old tables** and six executed checks: preserve old rows, replay 0020, resume the old investigation without duplication, preserve exact old report/source provenance, used-state restart/operator view, fresh install through 0020. `migration-source-integrity.json` confirms **all 20 migrations 0000–0019 are byte-identical to the supplied v8 ZIP**. Only 0020 is new. Old operations, candidates and scientific rows are covered by populated preservation; this is not a copy of an actual user's private database.

Stress fixture: **10,000 entities; 50,100 relationships; 5,000 evidence records; 300 investigations and autonomy states; 25 operations** plus 10,000 v7 decisions, 144,000 components, 10,000 tests, 100,000 costs, 30,000 outcomes, 20,000 lineage records, 5,000 gaps/20,000 gap history, and 5,100 scientific hypotheses/predictions, 5,000 contradictions/30,100 history records.

| Local measured function | Milliseconds |
| --- | --- |
| adaptive_operation_view | 25.67 |
| briefing_and_graph_first_page | 17.85 |
| scientific_cached_default_briefing | 3.5 |
| v9_dashboard | 2.65 |
| v9_investigation_default | 3.3 |
| v9_wallet_default | 7.43 |
| v9_queue_classification | 1.44 |
| v9_director_tick | 13.63 |
| v9_queue_reconciliation | 2577.7 |

DB after fixture/history: **100,020,224 bytes**; after workload: **176,283,648 bytes**; workload growth **76,263,424 bytes**. RSS after **199,823,360 bytes**, measured process peak **208,200 KiB**. Five unchanged scientific reads added **0 bytes and 0 scientific history rows**. dbstat identifies operation_history/operation_edges and their indexes as the largest workload-growth contributors; their full page usage is retained in `stress.json`. Compact scientific history records reduce repeated verbose snapshots but do not solve total projection growth.

These are single-process local SQLite/function timings, not remote D1 latency or full server-rendered page TTFB. Queue reconciliation still takes seconds, and multi-operation projection/adaptive ticks are materially slower than bounded default views. Default Main lists are bounded, but an inherited investigation server render still fetches legacy panels even when collapsed. Responsive defaults are verified in their fixtures; full large-state SSR scalability and long-term history compaction remain partial.

## Full regression and production verification

Fresh `npm ci` was executed for Main, WI, Form and Hunter before broad testing. The install logs are included. Main/WI/Form/Hunter production builds and TypeScript checks passed; Hunter's final 45 tests passed. Node 22.18 and Node 24.19 doctor checks passed. Main source-scoped ESLint remains **FAILED (38 errors, 223 warnings)**, including inherited React-hook and explicit-any issues; those were not disabled to manufacture a green gate.

| Regression group | Node 24 broad | Node 22 final broad |
| --- | --- | --- |
| unit | PASS | PASS |
| migration-matrix | PASS | PASS |
| suite | PASS | PASS |
| loops | PASS | PASS |
| integration:v6 | PASS | PASS |
| v2 | PASS | PASS |
| v3 | PASS | PASS |
| v4 | PASS | PASS |
| v5 | PASS | PASS |
| joined:hunter | PASS | PASS |
| joined:v61 | PASS | PASS |
| five-modules | PASS | PASS |
| startup:modules | PASS | PASS |
| site-finder | PASS | PASS |
| wallet-pipeline | FAIL | FAIL |
| director | PASS | PASS |
| operation-intelligence | PASS | PASS |
| adaptive-intelligence | PASS | PASS |
| scientific-intelligence | PASS | PASS |

Node 24 broad completed **19 groups**, 18 PASS and 1 FAIL. Its wallet-pipeline assertion failure is confined to the two installed-extension attempts; the other four steps passed. The final v9 group was separately completed **9/9** on Node 24 and Node 22, including five adapter tests. Node 22 final broad completed 20 groups; the cumulative final summary is in `all-node22-completed.log`. Its source logs identify the original broad run and the scientific/autonomy groups resumed after the execution environment went offline. This is completion across an environment restart, not one uninterrupted process.

The broad runner continues after failed steps. The earlier v9 run completed its assertions but stayed alive because inherited WI polling intervals held the process; those timers now allow shutdown when no server/work remains. A Node 22 fixture keep-alive reset was investigated and fixed with an explicit 60-second harness idle timeout, without replaying unsafe mutations. The corrected broad Node 22 run completed the first 18 groups, then the execution environment went offline during scientific crash tests. After reconnection, the entire scientific group and the entire v9 group were rerun to completion; the cumulative 20-group summary preserves the actual source logs and interruption. Earlier interrupted/stalled logs are retained as superseded diagnostics, not claimed as completed releases. The joined-v6.1 harness's destination route omission was also corrected and both normal and lost-confirmation paths rerun successfully.

Site Finder's final standalone suite is **550/550** in the completed Node 24 broad run. An earlier standalone attempt used the wrong browser-cache environment and failed browser setup; the correctly configured broad run is the relevant result. Finder cache lifetime had caused a real temporal watch regression and was fixed before that final suite. The build and actual production browser were rerun after adding shared local maintenance. Production smoke uses the compiled Worker, local D1 ordered migrations, source fixture ingestion, eight routes, hydrated dashboard, operation map/connection/source-evidence dialogs, 375px view, and an actual primary Investigate Site click opening the rendered site and redirecting to its workspace, with no recorded page errors. It does not certify live-chain-to-external-form operation. The one-entry launcher smoke starts every service and performs a successful shared maintenance pass against the production Worker.

## Known unfinished or failed goals

1. Finder v4 major quality/campaign discovery improvement is FAILED, despite working bounded ranking/caches and small cost gains.
2. Scientific structural generalization is FAILED and v8 carried-design performance regressed. The ranking is a heuristic, not calibrated information theory.
3. Complete world simulator integration through production scientific DB, all seven causal learning transitions and independent broad split/merge correctness certification are NOT IMPLEMENTED in full.
4. Full native interaction/status unification, Logger popup control audit, every populated/loading/error/dialog state and universal context preservation are incomplete.
5. New real provider coverage is Bitcoin plus keyed explicit Blockscout EVM networks; other live adapters and live keyed EVM verification are absent. Actual Bitcoin fetch is separate from fixture end-to-end tests.
6. Installed-extension lifecycle is ENVIRONMENT-BLOCKED; rendered content.js with a message shim is the closest exercised path and not equivalent. Native Windows is separately ENVIRONMENT-BLOCKED.
7. External configured report-destination lifecycle is not fully verified. Local verified receipts do not establish external submission success; uncertain remote outcomes stay manual and are not resent.
8. History/projection growth, seconds-long reconciliation, hidden legacy SSR queries and source ESLint are unresolved. Complete long-lived real-world liveness/concurrency is partially verified.

## Exact upgrade/start instructions

The archive retains both original sibling directory names. Use the included current `README.md`; historical README material is moved to `README_HISTORY.md`. Installation excludes user databases, credentials, generated dependencies/builds and runtime state. Preserve your existing data separately.

## Upgrade existing v8 state

1. Stop Main and all specialists. Back up the complete old folders, including local configuration and databases.
2. Extract this bundle into a new directory with both sibling folders above. Keep the backup untouched.
3. Copy your old `.dev.vars`, `.wrangler/state` (or your existing `MIP_PERSIST_TO` directory), specialist `.env` files, specialist `data` and evidence directories, and Hunter data to their matching locations. Preserve the browser extension settings and Form Submitter's browser-local settings. Do not replace old databases with a new empty database.
4. Install/build below, then run `npm run start:suite`. Main applies ordered additive migrations through `0020_full_autonomy.sql`. Migrations 0000–0019 remain unchanged. Do not downgrade a used v9 database; restore the complete v8 backup for rollback.

The launcher preserves an existing `.dev.vars`. It requires nonempty keys for all six module names in `MODULE_API_KEYS`: `site_finder`, `site_investigator`, `crypto_wallet_logger`, `wallet_investigator`, `form_submitter`, `operation_hunter`. On a fresh install it generates six local random keys.

## Install and build

Requires Node.js **22.13+** (22.18 and 24.19 were exercised), npm, Python 3, and Chromium for browser checks. Run these commands from the Main folder. Linux/macOS:

```bash
npm ci
npm run build
npm --prefix integrations/wallet-investigator ci
npm --prefix integrations/wallet-investigator run build
npm --prefix integrations/form-submitter ci
npm --prefix integrations/form-submitter run build
npm --prefix ../operation-hunter-v2.0 ci
npm --prefix ../operation-hunter-v2.0 run build
python3 -m venv .venv
.venv/bin/python -m pip install -r integrations/site-finder-v07/requirements.txt -r integrations/site-investigator-v01/requirements.txt
.venv/bin/python -m playwright install chromium
npm run test:doctor
npm run start:suite
```

PowerShell uses the same npm commands, then:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r integrations/site-finder-v07/requirements.txt -r integrations/site-investigator-v01/requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium
npm run test:doctor
npm run start:suite
```

These are portable commands; native Windows operation was not available for verification. Set `MIP_PYTHON` to an absolute Python interpreter if needed. For an existing custom database path retain `MIP_PERSIST_TO`.

## One local entry point

`npm run start:suite` starts Main at **http://127.0.0.1:8787**, Wallet Investigator :3001, Form Submitter :3002, Hunter :3003, Finder :5000, and Site Investigator :8765. It runs the shared Main maintenance entry every 15 seconds with no overlapping launcher calls. Existing server leases and budgets still apply. **Ctrl+C** stops the child services. Logs are in `logs/suite`.

Open Main, enter a public HTTP(S) site, and choose **Investigate Site**. Browser login, CAPTCHA, MFA and email verification remain your actions. Do not give credentials or sessions to Main.

One-time local setup:

- Load the unpacked extension at `integrations/crypto-wallet-logger-v08` in Chromium developer mode. Set Main URL to `http://127.0.0.1:8787` and use only the `crypto_wallet_logger` key from `.dev.vars`. Enable passive observation. Its `wallet.observation` 2.0.0 interface remains compatible.
- Configure the authorized reporting destination and verified required field mapping in Form Submitter. Enable its approved-report automation if desired. Main still requires exact-content final approval. Local test receipts are not proof of an external form submission.
- Bitcoin uses the public bounded Blockstream Esplora read adapter. For the supported explicit EVM networks, put `BLOCKSCOUT_API_KEY=your_key` in **Wallet Investigator's own** `.env`; the launcher passes it only to that specialist. Ethereum, Optimism, Base, Arbitrum, Polygon and BSC have adapter definitions. Without a permitted provider, validation/analysis availability is shown honestly. EVM networks are never guessed. Other networks retain deterministic validation but do not have new live activity adapters in this release.

Do not enable `WALLET_INVESTIGATOR_SYNTHETIC_FIXTURES` in a real investigation. Provider history is bounded and marked partial; common counterparties and transactions do not establish ownership.


Run `npm run test:doctor`, `npm run test:all`, `npm run test:autonomy` and `npm run build` to reproduce the local gates. Browser caches and Python dependencies must exist. The broad gate deliberately reports the installed-extension execution failure when the browser environment blocks it. Scientific/Finder benchmark measurements require the explicit quality interpretation above. Verification JSON/logs and fixture screenshots are included under `verification/autonomy-v9`; legacy version folders/reports are historical evidence.

Main never ingests passwords, vault keys, provider secrets, session secrets, private keys or seed phrases. Provider configuration remains with WI; Form destination credentials/settings remain with that specialist. Login/verification and exact final approval remain human. All automatic work is bounded routine public investigation/read-only analysis; no crypto transfer/signature/deposit/withdrawal or intrusive access action was added.
