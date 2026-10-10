# Main Platform v5 — Autonomous Investigation Director

**Release status: integration candidate; the complete release gate is not certified.**

This is an upgrade of the supplied Suite v4 source, with migration 0016 and a durable investigation director. The original wallet chain remains Logger observation → candidate → Wallet Investigator validation → blockchain analysis → automatic report → hash-bound approval → Form Submitter. Core migration, restart, provider recovery, adversarial, submission-uncertainty, production build and populated production browser checks passed. Browser extension loading is blocked by this environment. Some requested resource telemetry, crash injection and end-to-end deep discovery measurements remain incomplete; see the explicit limitations below.

The ZIP contains `main-investigation-platform-v7-suite-v5-director/` and the unchanged supplied `operation-hunter-v2.0/` beside it. All existing launcher-facing paths inside Main are retained. Dependencies, local databases, credentials and generated test evidence are excluded. Install dependencies and configure module keys in your own environment. This report distinguishes source implementation from observed test behavior.

## Architecture and preservation

Main now reasons over recorded evidence and persistent work. It delegates collection, wallet validation, blockchain analysis, operation reconstruction and report submission to the existing modules. It does not fetch blockchain data, create wallet validation facts or implement Hunter's specialist inference itself.

| Component | Change |
|---|---|
| `lib/director/director.ts` | Leased decision loop, objectives, action selection, outcome memory, provider recovery, stop state and briefing |
| `lib/director/resources.ts` | Shared investigation allowances and atomic job reservations, including adoption of existing jobs |
| `drizzle/0016_investigation_director.sql` | Seven additive, idempotent director tables |
| Existing wallet pipeline | Retry adoption, fresh validation on changed network hints, readiness withdrawal and report regeneration |
| Wallet Investigator | Optional refresh identity, cache bypass on recovery, bounded provider attempts and conflicting network hint handling |
| Scheduler | Existing maintenance/cron invokes the director; local scheduler script also posts maintenance automatically |
| Site Investigator / Finder bridges | Optional per-job public request limits flow into the existing collectors |
| Suite UI | Investigation briefing and readable activity; diagnostics under Details / Evidence / Advanced; human work grouped in Needs You |
| Existing jobs / Form Submitter | Submission uncertainty is parked for human verification; approved submission identity and duplicate protection remain |
| Logger ingest | Existing observation contract retained; nested secret fields rejected before ingestion |

Migration 0015 and every earlier SQL migration are preserved byte-for-byte. The bundled Logger source is unchanged; there is no duplicate Logger 1.0 implementation. The separately supplied Operation Hunter is included unchanged. Existing Windows launchers, Node compatibility paths, Wallet Investigator atomic storage, sql.js fallback and five-tool shell remain in place. Small TypeScript corrections found during the production type check preserve runtime behavior. Fresh specialist installation exposed an existing Vite 8 / esbuild peer conflict: Wallet Investigator now declares compatible esbuild 0.28, and Form Submitter gains a reproducible lockfile. Unused import.meta-derived path constants were removed from Wallet Investigator because the existing CJS server build could not evaluate them. Build/start output paths remain unchanged. Root `tsx` is now explicitly declared because the existing test scripts already require it.

## Decision and state model

A maintenance tick selects due investigations, ordered by last evaluation, and acquires a compare-and-set lease for one investigation. The lease lasts 60 seconds. A tick reconciles completed work and wallet results, adopts old v4 PARTIAL analysis, updates objectives, identifies a specific gap, ranks safe actions and chooses at most one director action. Planned actions are persistent before execution. Immutable action identity is copied into the job payload, so a restart can adopt a job created before the action's job pointer was saved.

Actions record kind, target, gap, reason, expected value, cost, risk, fingerprint, job, result and usefulness. A unique investigation/fingerprint pair prevents a failed public branch or repeated correlation from silently becoming new work. Existing agent runs and queued/running legacy work retain ownership of their gaps. Module registration, per-module occupancy and global running concurrency are checked before a director job is queued. Global scheduler pause prevents new director public and wallet work while allowing status reconciliation.

States include RUNNING, WAITING_FOR_MODULE, WAITING_FOR_PROVIDER, WAITING_FOR_HUMAN, PAUSED, STOPPED and COMPLETE. Durable stop reasons are exposed in the briefing. A stopped investigation may be evaluated again by maintenance; action fingerprints prevent repeated dead-end jobs. The stored watermark is reserved for future event-driven invalidation and is not currently used to suppress all evaluations.

## Objectives and evidence gaps

Nine objectives are persisted with status, explanation and evidence references: site worth investigating, payment interface, deposit wallets, wallet validation, blockchain evidence, operation correlation, related sites, report readiness and report blockers. Statuses use unresolved, in_progress, resolved, blocked, not_applicable and exhausted.

| Evidence gap | Existing module / safe next action |
|---|---|
| Site attached, no deposit observation and no completed public investigation | Site Investigator public collection |
| Observed address not validated | Wallet Investigator validation-only job |
| Valid deposit wallet without chain analysis | Bounded Wallet Investigator analysis |
| Transient incomplete chain evidence | Persist backoff and issue a fresh read-only refresh when due |
| Valid deposit wallet observed in another investigation on the same validated network | Record a correlation signal and its existing evidence references |
| Useful validated overlap and no competing legacy owner | Ask Operation Hunter to evaluate the signal |
| Recorded public artifacts justify a related-site gap | Bounded Site Finder hunt |
| Authentication, verification or material network ambiguity | Human checkpoint with clear instructions |
| Ready report | Exact-content analyst approval; no automatic approval |
| Failed / exhausted safe branches | Durable stop reason and recorded report blockers |

Site worthiness currently means that a site is attached to the investigation, rather than a new calibrated scam-worthiness classifier. Finder lead handling and triage remain the existing implementation. The director uses explicit, finite action templates; it is not an unconstrained planner.

## Provider recovery

Authenticated Wallet Investigator results for the candidate's active analysis job can create durable recovery state. Existing populated v4 PARTIAL/FAILED analysis is also adopted without waiting for another result event. Pagination limits and otherwise complete zero-activity results are not treated as outages.

Retries persist candidate, original job, refresh job, generation, attempts, reason and next time. Network-level health records park work until the next probe. Backoff starts at five minutes and grows to ten and twenty minutes, with a maximum of three fresh director retries. Job attempts are separately bounded. Every refresh has a stable generation identity and bypasses the old cached result, while duplicate delivery of that same generation retains idempotency.

A successful result resolves the retry, records provider health, reevaluates wallet evidence and rebuilds the report automatically. Results from superseded analysis jobs do not override the candidate's active job. Retry work is read-only and can continue on an already validated deposit wallet while a separate login/MFA checkpoint is open; that checkpoint never authorizes further site access.

**Verified:** real Main routes and the real Wallet Investigator engine/worker, with a deterministic transport that fails then recovers, survive a Main restart. Exactly two provider calls and one refresh are observed; the report is rebuilt and the old hash is rejected with HTTP 409. Repeated provider failures stop after three refreshes without creating a storm over twenty further ticks.

**Limit:** supplied Wallet Investigator provider delegates use synthetic behavior. These tests do not certify live provider configuration, rate limits or recovery against a production blockchain service.

## Cross-tool coordination and correlation safety

Main reuses Finder hunts and existing Hunter proposals/work items. A Hunter gap is dispatched through the existing work scheduler and Finder bridge; repeated requests do not create another hunt. Recorded public artifacts, rather than learned priors, seed discovery.

Only authoritative, validated deposit observations on the same validated network participate in the director's cross-investigation wallet check and the report's “also seen on” list. A transaction does not establish ownership. An address overlap is a correlation signal, not an operator merge. Shared hosting, CDN, template and generic example text do not become ownership evidence in the director. Existing provenance categories remain attached to evidence.

If the browser later supplies incompatible network hints, Main retires the old retry state, queues fresh validation and withdraws the prior report's readiness. Wallet Investigator returns network ambiguity instead of choosing the strongest conflicting label; no blockchain call is made for that ambiguity. Previously approved, unclaimed stale content is superseded, including when there is no longer any confirmed wallet. Claimed submission is an uncertainty boundary requiring separate outcome review.

## Investigation budgets

Enrolled investigations share one resource ledger across module jobs. Enrollment adopts historic jobs once. Job insertion, reservation and budget predicates run in the same D1 batch; losing a race does not create an orphan charge. Legacy profile limits supply jobs, requests/provider calls, public work, wallet count and effort limits. Finder and Hunter expansion allowances default to four and two jobs. The final ordinary job slot is reserved for the approved submission lifecycle.

| Dimension | Enforcement / meaning |
|---|---|
| Jobs | Atomic common allowance; includes historic reservations |
| Wallet analysis | Common wallet count plus existing pipeline budget |
| Provider calls | Conservative allowance of six provider attempts per analysis attempt; WI enforces its attempt ceiling |
| Site Investigator | Fifty public request units per attempt passed into the collector; HTTP/DNS/TLS and browser-route work are bounded |
| Finder expansion | Common expansion count; per-attempt request limits: HTTP 40, DNS 40, crt.sh 4, RDAP 6 |
| Hunter expansion | Common expansion count and conservative request reservation; Hunter's own existing budget remains |
| Investigation effort | Estimated effort reserved per job; not a measured elapsed-time kill switch |

Reservations are allowances, not actual endpoint telemetry, and are intentionally not presented as measured calls. Hunter's request reservation is not a strict HTTP cap inside the unchanged Hunter. Unenrolled legacy investigations keep their legacy behavior until adopted. Approved Form Submitter work is excluded from the ordinary director reservation path and retains its separate frozen lifecycle. Consequently this implementation does not yet meet a universal measured global request/elapsed-effort budget across every specialist and background worker.

## Stop logic and learning

The exposed reason vocabulary is READY_TO_REPORT, WAITING_FOR_HUMAN, SOURCE_EXHAUSTED, LOW_EXPECTED_VALUE, BUDGET_EXHAUSTED, DUPLICATE_INVESTIGATION, INSUFFICIENT_PUBLIC_EVIDENCE, PROVIDER_UNAVAILABLE, NO_REPORTABLE_WALLET and COMPLETED. Readiness, checkpoints, bounded provider exhaustion, public exhaustion, low value and completion have explicit branches. Existing ingest deduplication still handles duplicate leads; there is no new dedicated DUPLICATE_INVESTIGATION transition for a duplicated investigation record.

Historical action outcomes influence ordering only. Up to one hundred outcomes per action kind receive a thirty-day exponential decay; adjustment is capped at ±0.12 and expected value has a 0.1 floor. No learned value is emitted as evidence. Current usefulness is a coarse measure of added evidence or returned candidates, not a complete causal attribution model of final validated wallets. This is bounded outcome memory, with room for better downstream attribution and exploration scheduling.

## Human policy, briefing and report lifecycle

Needs You groups Login / Verification, Decision required and Ready to report. Worker retrying alone is not human work. The briefing presents recorded findings, observed wallets, what Main is doing and why, next timing, required human tasks and report status. Action/job scores, reservations, retries and raw state remain under Details / Evidence / Advanced. Finder's manual investigation controls are under Advanced investigation controls. The readable activity timeline records reasoned actions, provider parking/recovery and branch results.

Main requests legitimate browsing authentication, CAPTCHA/MFA/email verification, material analyst ambiguity or final exact report approval. It receives neither credentials nor vault contents. A new director checkpoint resumes only after new authenticated Logger evidence or a deposit browser observation crosses its evidence watermark; unrelated DNS evidence cannot resume it. Existing run-bound checkpoints retain their existing behavior. Cancellation prevents further director work for that checkpoint.

Report readiness retains the original evidence requirements. Pending provider recovery and ambiguous validation withhold readiness. Needs You shows the exact report summary, warnings and content hash and sends that hash with approval. Material report or destination changes invalidate approval. The director view derives BUILDING, NOT_READY, AWAITING_APPROVAL, APPROVED, SUBMITTING, NEEDS_HUMAN, SUBMITTED_VERIFIED, SUBMITTED_UNVERIFIED, FAILED_RETRYABLE and FAILED_FINAL from the existing authoritative report/job state. READY remains the readiness flag before the UI presents approval; this is a derived lifecycle, not a second independent submission database.

A PREPARE_REPORT worker lease that expires after work may have been sent is parked as needs-review. Failed or uncertain submission is not automatically resubmitted. **Verified lost confirmation:** the synthetic receiver accepts one actual Form Submitter POST and destroys the response; Main records needs-review, twenty director ticks and three further worker ticks produce zero automatic resubmissions. The receiver observes exactly one accepted POST.

## Restart recovery and migration

The migration test constructs a populated v4 database by applying every original migration, inserts wallet candidates, observations and an approved hash-bound report, then applies 0016 twice. Every original table definition and row is unchanged. It also aborts a partial table-removal transaction, verifies rollback, then drops all seven director tables and verifies the old data again. This is a populated synthetic v4 database, not a copy of a real analyst's production data.

Fresh migrations are also exercised by the acceptance harness and built production startup. Restart tests retain used state and assert one public job, one refresh generation, backoff persistence, report hash rejection and no duplicate submission. Existing pursuit/worker suites retain their restart and repeated-delivery assertions. Dedicated crash injection at every listed phase (in particular inside report rebuild and every Finder/Hunter acknowledgement window) has not been completed. Lease/fingerprint reconstruction is implemented for those windows, but comprehensive phase-by-phase crash certification is still required.

### Upgrade

1. Stop/suspend Main autonomous starts and module workers, and back up Main persistence and each module's database/configuration. Preserve the supplied v4 package for rollback.
2. Replace the Main source at its existing install location. Keep the existing relative module locations. If extracting this ZIP fresh, Main and `operation-hunter-v2.0` are sibling directories.
3. Run `npm ci` in Main, install each module's documented dependencies, and retain the existing module API-key configuration. No test keys or local state are shipped.
4. Run `npm run build`. Local `npm start` uses `scripts/start-production.mjs`, applies pending ordered D1 migrations to binding DB, and serves the built worker. Use the same existing `MIP_PERSIST_TO` value so this upgrades the used database rather than creating a new one. For a controlled local migration, run:

   ```sh
   npx wrangler d1 migrations apply DB --local --config dist/server/wrangler.json --persist-to /absolute/existing/persistence
   ```

   A remote deployment must apply the same ordered migrations using its existing real D1 binding/configuration; the generated local placeholder is not a remote database identifier.
5. Start the existing supervised module processes and Main. The built Worker retains its five-minute scheduled trigger; the separately supervised local scheduler posts maintenance. Confirm module registration/health, migration 0016, existing report hashes and the briefing before resuming autonomous starts.
6. Run `npm run test:doctor`, `npm run test:director`, and the original regression groups in the target environment, including an extension-capable browser.

### Rollback

The reliable rollback is to stop workers, restore the backed-up v4 code and all pre-upgrade persistence, and resume the prior configuration. If no v5 work has run, only the seven additive tables may be removed in this order: director_reservations, director_resources, director_provider_health, director_retries, director_actions, director_objectives, director_investigations. Reconcile migration history with the chosen deployment tooling rather than blindly reusing a migration ledger that still claims 0016 is applied.

Dropping director tables after v5 runtime activity does not undo newly collected evidence, superseded reports, approvals or queued jobs in original tables. Do not treat table removal as a complete operational rollback. No external submission can be undone by restoring a database.

## Benchmarks: measured gains and limits

The twelve-scenario corpus is stored outside director code and supplies identical opaque site names, observations, fault sequences and configured budgets to both arms. Real Main APIs, Wallet Investigator engine/worker and Form Submitter worker are executed. Site/Finder transports and chain providers are deterministic fixtures. Dynamic/login browsing actions are supplied equally; v4 receives one manual public investigation start per case. The v4 arm is not manually repaired after the provider outage. The raw JSON includes every scenario and all limitations.

| Metric | v4 | v5 |
|---|---:|---:|
| Confirmed deposit wallets | 12 | 12 |
| Useful evidence records | 50 | 53 |
| Scripted human actions | 34 | 23 |
| Manual tool transitions | 12 | 0 |
| Manual retries | 0 | 0 |
| Director actions | 0 | 22 |
| Useful director actions | 0 | 14 |
| Jobs | 283 | 62 |
| Measured provider calls | 11 | 12 |
| Reports reaching approval | 9 | 10 |
| Verified synthetic submissions | 8 | 9 |
| Duplicate jobs | 0 | 0 |
| Duplicate reports | 0 | 0 |
| False ownership relationships | 0 | 0 |
| Runaway loops | 0 | 0 |
| Median time to first confirmed wallet, observed cases (ms) | 1487 | 1401 |
| Median time to report, cases ready in both arms (ms) | 1580 | 1433 |
| Aggregate jobs / confirmed deposit wallet | 23.58 | 5.17 |
| Benchmark budget-exhaustion telemetry | Not measured | Not measured |

Scripted human actions fall from 34 to 23 (**32.4%**). Jobs fall from 283 to 62 (**78.1%**), chiefly due to bounded decoy validation. Fourteen of twenty-two v5 director actions are useful under the runner’s coarse outcome definition (**63.6%**). Timing medians are fixture process wall time and do not imply a live performance gain.

Human actions count scripted browsing/login, the initial manual v4 public investigation start and exact report approval. They do not measure analyst time saved in live investigations. Useful evidence counts authoritative chain facts and valid deposit observations; unrelated decoys are excluded. Jobs per useful result uses a confirmed validated deposit wallet as the result. Recorded wall timings and provider-backoff advancement are fixture measurements, not live service latency.

The improvement is fewer routine starts, bounded decoy work and automatic provider recovery; confirmed wallet recall is unchanged. The provider-recovery arm reaches approval and verified submission after recovery, while v4 stays incomplete without an invented manual repair. Provider calls increase by one because v5 does that additional useful recovery work. The large total job reduction is dominated by the 250-decoy case; it is not a uniform per-investigation reduction.

False ownership relationships, duplicate jobs/reports and runaway loops are zero in the fixture counters. These are limited fixture assertions, not a universal false-correlation rate. `budget_exhaustions` is null in the end-to-end runner because that metric was not measured there; budget exhaustion is tested separately by acceptance tests.

The corpus's `four_pivot_lead` record is explicitly marked `finder_pivots_measured: false`. It supplies the observed wallet and does not actually discover that wallet through four pivots. Therefore this runner does not fulfill the requested end-to-end deep-discovery comparison.

A separate comparison runs the **unchanged, pre-existing independent Finder pursuit benchmark** against both supplied v4 and upgraded v5 Finder trees: hard `cdn_maze`, seeds 1 and 2, ten rounds, identical budgets and hash-order noise repeats. Both arms find 31 useful sites across the two seeds, average 97.05% precision, mean 3.5 multi-hop useful results per run, 7,384 total requests and zero measured false cross-operation relationships. Results and request counts are identical, including noise repeats. This supports preservation of real multi-pivot Finder behavior; it does not measure the director's complete discovery-to-report path or a v5 Finder quality gain.

## Verification results

Verification was repeated before and after a workspace reset. Node 24.19.0 is the full-suite runtime. Node 22.23.3 also passes director migration/acceptance/provider/adversarial tests, root unit tests (36 pass, one existing skip, zero failures), the ten-case migration matrix and actual built Wallet Investigator/Form Submitter health checks. A production build and type check pass after the network conflict and pause fixes.

| Check | Status / evidence |
|---|---|
| Populated v4 → 0016, idempotent reapply, original row/schema preservation, rollback transaction | VERIFIED — director migration test on Node 22/24 |
| Fresh schema and ten-case legacy migration matrix | VERIFIED — Node 22/24 |
| Restart, concurrent tick, global job allowance, provider backoff, scheduler pause | VERIFIED — director acceptance tests |
| Real WI outage → restart → fresh refresh → report rebuild → stale hash rejection | VERIFIED — provider recovery test |
| Incompatible browser network hints withdraw readiness and do not guess | VERIFIED — real WI validation plus recovery test |
| Provider flapping, legitimate login resumption, nested secrets, misleading CDN/example evidence | VERIFIED — adversarial tests |
| Hash-bound report, original form flows, uncertainty after one accepted POST | VERIFIED — in-process wallet pipeline plus lost-confirmation test |
| WI checksum/network validation | VERIFIED — 26 passed, zero failed |
| Fresh specialist installs/builds; real built-server health on Node 22/24 | VERIFIED — isolated dependency checks; WI specialist suite 31 passed |
| Original integration:v6 | VERIFIED on targeted rerun after optional-argument compatibility fix — ten steps |
| Suite workflow, 39 UI checks, full twenty-page sweep and used-state restart sweep | VERIFIED on final full run, including used-state restart; counts below |
| Remaining legacy groups | Earlier aggregate results retained; final rerun result below |
| Root type check / Main production build | VERIFIED |
| Actual built production worker, eight routes, populated briefing and 375px layout | VERIFIED — no captured page exceptions |
| Logger extension and browser wallet-flow acceptance | ENVIRONMENT-BLOCKED — Chrome persistent-profile socket denied |
| Exhaustive per-phase crash injection; universal actual request/effort telemetry | IMPLEMENTED IN PART / NOT FULLY VERIFIED |
| Director four-pivot discovery-to-report benchmark | NOT MEASURED; separate real Finder preservation benchmark passes |
| Windows runtime | NOT VERIFIED on a Windows host |


The earlier full aggregate repeat passed fourteen groups and failed two: the Site Investigator bridge passed an optional keyword to a legacy FakeInvestigator constructor, and the extension browser was unavailable. The bridge now omits that keyword unless a request limit exists, and all ten integration:v6 steps pass on rerun. The current aggregate rerun uses the default full UI sweep, with MIP_REQUIRE_UI and MIP_REQUIRE_HUNTER enabled; its final results are captured below. A separate earlier full suite run also passed: twenty server-rendered/hydrated pages, 394 controls at first start and 232 controls after restart, plus the 39 primary UI assertions. That run predates the final network-conflict/pause fixes. The reduced-sweep aggregate runs are not counted as another full sweep pass.

Final Node 24 aggregate: **15 PASS, 1 environment-blocked group**. The runner exits nonzero because `wallet-pipeline` stops at the real Logger extension test, which cannot create Chrome’s persistent-profile process-singleton socket. No other group fails. The independent wallet pipeline and separate browser-flow results are described above.

| Final group | Result |
|---|---|
| unit | PASS |
| migration-matrix | PASS |
| suite | PASS |
| loops | PASS |
| integration:v6 | PASS |
| v2 | PASS |
| v3 | PASS |
| v4 | PASS |
| v5 | PASS |
| joined:hunter | PASS |
| joined:v61 | PASS |
| five-modules | PASS |
| startup:modules | PASS |
| site-finder | PASS |
| wallet-pipeline | FAIL in runner; ENVIRONMENT-BLOCKED at extension step |
| director | PASS |

Final UI counts: 39 primary assertions, twenty hydrated pages and 394 enumerated controls on first start (358 activated, 34 harness warnings), then twenty hydrated pages and 232 activated controls after Main restarts on the same database (zero restart warnings). Full raw results are in `final-suite-ui.json` and `v5-release-regression.log`. Main’s worker polling logs during the harness’s ephemeral-port restart include expected connection-refused messages; the suite finishes successfully and does not classify these as product failures.


The populated production browser check launches the actual built worker and Chromium, rather than only the API harness. Eight routes return HTTP 200 (`/`, `/finder`, `/wallets`, `/logger`, `/reports`, `/hunter`, `/tasks`, `/api/v1/health`); the populated director briefing renders and has no horizontal overflow at 375px. No captured page exceptions occur. Browser-console collection is part of the separate suite checks, not this production smoke test. Screenshots and machine-readable checks are included in `verification/director-v5/`.

Browser extension testing fails before the extension loads: native Chrome's persistent profile requires a process-singleton socket and this environment denies `socket()` with Operation not permitted. An earlier serverless browser also could not load extension service workers. These are environment-blocked checks, not passing extension tests. The complete wallet-pipeline group stops at that step; a separate run of its later real-extension end-to-end step hits the same socket denial, so neither is certified. Independent Wallet Investigator validation tests (26/26), real worker tests and the in-process full report/submit/lost-confirmation test pass.

## Known limitations and release follow-up

- Complete release certification is withheld until the extension/browser flow and final regression failures or blocks are resolved in a capable environment.
- Global resource reservations are conservative estimates; Hunter HTTP and elapsed effort are not universally enforced/measured across all internal or background work.
- The end-to-end benchmark does not measure real four-pivot wallet discovery, live provider coverage, dynamic-page detection or analyst time. The separate Finder benchmark establishes preservation, not a new director quality improvement.
- All requested restart interruption phases have not received dedicated crash injection. Recovery logic and several used-state scenarios are verified, but that is not exhaustive crash certification.
- Outcome learning is coarse; some objective statuses and the duplicate stop reason are representational rather than complete specialized intelligence. Main reevaluates stopped investigations on maintenance and does not yet use its stored watermark for all event-driven wakeups.
- Early aggregate verification used a temporary shared dependency environment. Fresh isolated specialist installation subsequently exposed and fixed a Wallet Investigator Vite/esbuild peer conflict and the missing Form Submitter lockfile. Both modules now pass fresh `npm ci`, production build and actual built-server HTTP health checks on both Node 22 and Node 24; Wallet Investigator’s 31-test specialist suite also passes in that isolated dependency environment. The ZIP ships these manifests/locks and source fixes, not installed dependencies.
- Windows behavior is preserved by source paths and portable runners, but no Windows machine was available for this release run. Node 22 was exercised on the core tests, not the full browser/production matrix.

## Wallet Logger 1.0 merge notes

Main continues to accept `wallet.observation` schema 2.0.0 and legacy v4 Logger compatibility ingestion. Logger 1.0 is optional and not required. New read-only flow metadata can be added to the existing observation/evidence interface; it must retain provenance and must not become authoritative network/checksum/chain validation.

The ingest denylist recursively rejects the explicit password, private/API/vault key, provider credential, account secret and session/access/refresh token key patterns with HTTP 400 before events are accepted. Do not send account-vault contents, passwords, provider credentials or session secrets to Main. Resume hints describe authenticated observations only; they neither carry a reusable session nor authorize bypassing login, CAPTCHA, MFA or email verification. Re-run Logger 1.0 contract, nested-secret and extension acceptance tests when that independent branch is merged.

## Reproduction and evidence

From Main: `npm run test:director`, `npm run test:integration:v6`, `npm run test:all`, `npm run build`, and `npx tsc --noEmit`. Set MIP_PYTHON to the configured interpreter and HUNTER_DIR to the supplied sibling Hunter when needed. Python module requirements and Playwright browser installation are required for browser groups. Synthetic fixture flags are test-only.

For the platform benchmark run `node --experimental-sqlite --import tsx --import ./tests/lib/sqljs-fallback.mjs bench-director/run-arm.mjs <tree> <output.json> <v4-or-v5>` once per arm. The original v4 archive is the baseline source; it is not modified to emulate v5 recovery. The Finder benchmark command and raw traces are in the verification directory.

Selected raw logs, benchmark JSON, source preservation manifest and production screenshots are shipped under `verification/director-v5/`. Earlier failure logs are retained and labeled so fixes and blocks remain reviewable. Only tests demonstrated by those records are claimed as verified.
