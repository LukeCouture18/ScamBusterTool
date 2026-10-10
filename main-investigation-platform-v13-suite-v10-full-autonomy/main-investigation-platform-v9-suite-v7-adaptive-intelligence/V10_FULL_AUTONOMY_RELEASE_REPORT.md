# V10 Full Autonomous Investigation — release report

Release: `main-investigation-platform-v13-suite-v10-full-autonomy.zip`  
Report date: 2026-10-04 UTC  
Frozen code/document identity: `9e3253c2a56137092c801b8288a8fd21b0c4851c0dc281dce2338db7651b6f5f`  
Overall status: **IMPLEMENTED BUT PARTIALLY VERIFIED**.

The release adds a durable Finder-led Start Investigation flow, a bounded mission coordinator, separate evidence/confidence dimensions, and an encrypted private account workspace to the existing Main/Finder/Site Investigator/Logger/Wallet Investigator/Form Submitter/Hunter pipeline. Scoped local verification passes for automatic public work, normal human authentication assistance, passive deposit capture, validation, report preparation, and exact approved local submission. Actual installed-extension operation is **ENVIRONMENT-BLOCKED**; independent scientific decision quality and large-state performance remain **FAILED**. This is a reviewable source release, not a certification of live-site accuracy, live mailbox/provider availability, external submissions, or Windows operation.

## Recovery, baseline and source provenance

The immutable v9 ZIP remains byte-for-byte intact: 18,166,499 bytes, SHA-256 `ab79b6936f24fb4d34fc1c6a3f0d4db6def51b924974f50867c453c335c684c0`. The accessible original Main/Hunter trees matched all 1,395 packaged baseline files. Reported v9.1 progress and recovery notes were available, but executable v9.1 source, its migrations, owned vault and a final v9.1 deliverable were absent from this environment. Required behavior was reconstructed from the retained v9 baseline; absence here does not prove deletion elsewhere. A legacy Logger 1.0RC source was separately available for its decrypt/migration algorithm; migration was tested with synthetic legacy payloads.

The workspace rolled back twice during execution. Checkpoint 12 was restored into an isolated tree with all 1,487 manifest hashes verified, and later checkpoint 18 with all 1,540 hashes verified. Unarchived changes were reapplied and retested. The ledger preserves unsuccessful/interrupted attempts and superseding checks. Git commit references from earlier environments are provenance; the source ZIP does not contain Git history. Durable recovery bundles retained the work independently of the scratch workspace.

Historical packaging omitted `build/sites-vite-plugin.ts` and its license. Both required build sources were recovered from the retained baseline and are included here. Existing sibling folder names, interfaces, lockfiles and authoritative evidence tables are preserved. Migrations 0000–0020 remain unchanged; 0021 adds search/claim/supply state and 0022 adds mission/resource/opportunity/history state. No database reset, corpus tuning, evidence deletion or replacement of uncertain results with synthetic successes was used.

## Capability disposition

| Capability | Status | Evidence and practical scope |
|---|---|---|
| Durable no-URL Start, supported candidate selection, ownership handoff, restart/replay | VERIFIED | Actual Main routes; concurrent Starts, lost acknowledgement, full unsupported inbox, generation limits and SIGKILL boundaries |
| Mission coordinator, stop reasons, budgets, bounded related children and separate site findings | VERIFIED | Production coordinator over local SQLite D1 double; four-site/two-level saturation, atomic reservations, lineage and selected-child recovery |
| Full multi-child campaign through independent external reports | IMPLEMENTED BUT PARTIALLY VERIFIED | Real Finder related discovery and controller child recovery pass separately; joined golden suite submits the root report, not every child report |
| Finder evidence dimensions and authoritative reuse proofs | VERIFIED | 14 boundary fixtures and actual matching WI-job/site-evidence/network proof tests; no field accuracy certification |
| Finder discovery yield | VERIFIED | Unchanged hard pursuit benchmark: 518 useful discoveries across 24 runs; synthetic corpus only |
| Unbiased field calibration of Finder confidence | NOT IMPLEMENTED | Handcrafted boundary tests and pursuit measurements do not provide a new unbiased live-site calibration set |
| Encrypted account generation/import/recovery and private transport boundary | VERIFIED | 52 native Logger tests on actual Node22/24; real WebCrypto; fixture storage/provider/Chrome APIs |
| Explicit credential/code fill and mailbox parser/account UI | VERIFIED | Rendered Chromium, 12 fill cases, 4 widths; no automatic login/signup/code submission |
| Genuine installed extension / service-worker browser lifecycle | ENVIRONMENT-BLOCKED | Both real unpacked-extension groups crash at persistent Chromium startup with SIGSEGV/TargetClosedError |
| Live mailbox creation and delivery across providers | IMPLEMENTED BUT PARTIALLY VERIFIED | Bounded production Mail.tm adapter and uncertain-create recovery tested against fixtures; live service not certified |
| Wallet detection, validation, bounded analysis, exact approval/submission recovery | VERIFIED | Real modules/local worker HTTP plus controlled page/chain/form responses; fixture authority and local receipts |
| Live chain-provider precision and external reporting destination | IMPLEMENTED BUT PARTIALLY VERIFIED | Production adapters preserved and adapter recovery tests pass; live provider data and external receipts not certified |
| Operation/Hunter evidence, alternatives, gaps, contradictions and provenance | VERIFIED | Historical operation/adaptive/scientific/joined groups pass on both runtimes; local fixtures |
| Independent scientific generalization | FAILED | Frozen compound holdout: 2/36 optimal, worse than confirmation comparator |
| Large-state responsiveness and projection storage growth | FAILED | Final isolated measurements still take seconds and add roughly 76 MB on first projection |
| Clean Main install/build/type/lint and compiled browser smoke | VERIFIED | Actual Node22.18/24.19, fresh npm ci, compiled worker + local D1 + rendered Chromium |
| Fresh specialist dependency reinstall certification | IMPLEMENTED BUT PARTIALLY VERIFIED | Specialist locks unchanged; retained dependencies and actual native builds tested, not fresh installs in each clean runtime tree |
| Windows/native platform operation | ENVIRONMENT-BLOCKED | Portable commands/path/runner checks provided; no Windows host available |
| Full UI control audit | IMPLEMENTED BUT PARTIALLY VERIFIED | Main 21-page activation sweep passes before/after restart; native view/account checks pass but do not exhaust every data-dependent native control |

“VERIFIED” is limited to the evidence stated in that row. **FAILED** quality/performance measurements remain failures even when their measurement harness exits successfully. **NOT IMPLEMENTED** describes missing certification work or functionality explicitly identified here.

## Durable Start and mission control

The primary button needs no URL. A client request ID and server search row exist before Finder selection. Coalesced Starts adopt the server's canonical ID, preventing a requested-but-uncreated ID from producing 404s after navigation. Lost responses reuse the ID; concurrent calls do not create duplicate active searches, investigations or supply jobs. Denied browser storage retains retry identity within the current page, while reload recovery then depends on the server dashboard. The original supplied-URL path enters the same ordinary investigation pipeline.

Search state progresses Finding site → Starting → Investigating, or Parked with a recorded reason. A candidate claim and assessment are saved before site creation. Leases fence ownership. Search-specific supply handles an inbox full of claimed/generic candidates without requiring fabricated approvals or votes. Search limits remain four Finder generations, a 30-minute deadline, singleton pending discovery, a daily supply cap of 48 jobs, and bounded specialist collection. The fourth job creation and generation increment now commit atomically; a real SIGKILL regression exposed and fixed over-allocation at that boundary.

`lib/missions.ts` layers coordination over existing specialist authority. Its 17 stages are: Starting, Finding site, Investigating, Waiting for you, Looking for wallet, Validating wallet, Analyzing wallet, Checking related sites, Reconstructing operation, Resolving evidence gaps, Preparing report, Ready for approval, Submitting, Submitted, Parked, Complete, Failed. The persisted snapshot contains target/objective, next action, authoritative findings, open gaps, uncertainty, human/provider blockers, active work, retries, considered actions, related opportunities, budgets, lineage and stop reasons. Viewing a mission refreshes its projection; it does not invoke a specialist.

A root allows four sites including itself, maximum child depth two, and ordinary reservations of 64 jobs, 1,200 requests and 180 provider calls. Four report slots are protected from exploratory work. These are reservation/estimated-cost counters, not a complete wire-level request meter. Existing exact-approved report execution retains its exemption from exploratory budget refusal. Child slots are reserved before site creation; recovery attaches the selected child without another charge. Site findings, investigations, reports and approvals remain separate. Generic infrastructure and transaction counterparties cannot create factual ownership claims. Roots are visited fairly under bounded leases; actionable due work owns gaps, while a future six-hour revisit no longer blocks current network review.

Completion/readiness, required human action, unsupported evidence, saturation, exhausted budgets, deadlines and provider retry timing stop or park discovery with reasons. No artificial heartbeat marks a parked mission productive. Public modules and maintenance continue automatically when permitted work is available. Human authentication, verification and final exact-content approval remain explicit.

## Finder confidence and evidence authority

Priority, suspected relationship, evidence quality, source independence, novelty and expected investigation value are separate dimensions. A high ranking is not an ownership claim. Copies share their original evidence unit; unknown origins remain one unknown unit rather than multiplying independence. Multiple indicator categories on the same page can justify bounded triage without becoming independent proof. Shared CDN/hosting/templates, generic promises and exchange counterparties do not establish an operator. Legitimacy counter-evidence, dead pages, unsupported reuse and duplicates reduce or reject eligibility.

A reuse assertion must resolve through same-investigation deposit observations/evidence, a completed real Wallet Investigator job, matching validated address and network, and at least two independent site proofs. A forged validated flag is rejected. Canonical source evidence and analyst decisions remain intact; selection creates no analyst vote.

The 14 predefined boundary fixtures contain 8 positive and 6 negative cases: zero fixture false positives/negatives, zero unverified wallet promotions and zero ownership claims. This is a regression boundary result, not field accuracy. The unchanged hard pursuit benchmark uses seeds 101/203/307, 8 rounds and 8 scenarios, with 24 runs: 518 useful discoveries, mean run precision 0.93275, 75,073 request units, mean run requests/useful 166.95417 and zero engine errors. All recorded baseline metrics match. Mean ratios are reported as means, not mistaken for the aggregate request/useful ratio.

## Private Logger account assistance

The complete account payload is encrypted with AES-GCM-256, a unique 12-byte IV, and a key derived with PBKDF2-SHA256/310,000 iterations and a 16-byte salt. Master passwords require at least 12 characters; keys are nonextractable. The vault locks after 15 minutes or worker restart. Lock generations fence delayed writes/unlocks so pending work cannot resurrect plaintext. Account secrets live separately from evidence, Main, Hunter, normal exports and sync.

Preparing a legitimate new account or importing an owned one is explicit, domain-bound and request-idempotent. Generated passwords have 28 random characters. Identity/purpose are persisted before remote creation; uncertain mailbox creation recovers the same saved identity using token recovery rather than creating another account. Supported legacy migration decrypts with the original algorithm, preserves the complete source in an encrypted legacy snapshot, commits new ciphertext before tombstoning the old entry, and fails closed without deleting unsupported source formats. Real owned legacy data was unavailable.

Only trusted extension UI can request fill. The chosen tab is rechecked; filling targets a visible, editable, unambiguous form on the exact top-level HTTPS origin/frame. Login refuses new-password fields; ambiguous/multiple forms, wrong origin, iframe targets and hidden/disabled/read-only fields are rejected. Native setters/events update frameworks. Fill Signup, Fill Login and Fill Code never click or submit. The operator completes the site's normal steps. Reveal/copy, selected verification-link opening and mailbox polling are explicit.

Mail requests allow only fixed HTTPS Mail.tm API origins/paths, reject redirects, use an eight-second timeout and a streaming one-MB cap. Polling is bounded to six attempts over ten minutes, ten-second spacing and at most ten messages. Secret redaction occurs before storage/transport, including nested and known multiply encoded secrets. Unstructured bodies/snippets/titles are dropped and URL query/hash/userinfo are removed; typed safe context remains. Credential fields and the vault are excluded from passive wallet evidence. Existing-vault capture pauses after lock/restart until explicit unlock; observing wallets does not extend vault inactivity.

Rendered UI checks cover locked/empty, prepare/import/same-identity recovery, explicit tab fill, normal operator login confirmation, reveal/copy, parser/code/link disclosure, errors, locking and encrypted restart at 375/1024/1280/1600 widths. Chrome messaging/tabs/clipboard/provider responses are fixtures. Twelve rendered fill cases have zero automatic submissions and no page errors. This does not substitute for an installed-extension test.

## Joined hard workflows and human work

The joined harness uses genuine Finder discovery (no manually seeded candidate/approval), actual Main routes, Site Investigator/Finder workers over HTTP, production Logger content scanning/redaction/fill, Wallet Investigator and Form Submitter. Public pages, provider replies, Chrome transport and final form responses are controlled fixtures. Both runtime trees pass all 14 cases and record 11 exact approved local receipts, 14 provider-adapter calls, zero duplicate jobs/reports and zero manual module transitions.

| Case | Final state | Explicit human actions | Wallets validated | Reports prepared | Jobs before final submission | Local readiness ms (Node24) |
| public | Submitted | 2 | 1 | 1 | 4 | 7795 |
| login | Submitted | 6 | 1 | 1 | 4 | 4800 |
| modal | Submitted | 3 | 1 | 1 | 4 | 5506 |
| qr | Submitted | 2 | 1 | 1 | 4 | 4239 |
| dynamic | Submitted | 3 | 1 | 1 | 4 | 4344 |
| decoys | Submitted | 2 | 1 | 1 | 13 | 13306 |
| ambiguous | Needs you | 1 | 0 | 0 | 4 | 8931 |
| outage | Submitted | 2 | 1 | 1 | 5 | 6860 |
| browser-restart | Submitted | 2 | 1 | 1 | 4 | 5210 |
| main-restart | Submitted | 2 | 1 | 1 | 4 | 6209 |
| wallet-change | Submitted | 2 | 2 | 1 | 5 | 6672 |
| related | Submitted | 2 | 1 | 1 | 4 | 8412 |
| no-wallet | Parked | 1 | 0 | 0 | 3 | 10384 |
| unsafe | Parked | 1 | 0 | 0 | 4 | 11770 |

The ordinary accessible cases count Start Investigation and Approve & Submit. Login counts those plus explicit Fill Login, normal sign-in, explicit Fill Code and normal verification (six). Modal/dynamic cases add one normal page action. Owned-account setup happens before this measured flow and is excluded; totals are not a promise of zero setup. API acknowledgement replays, rate-limit window resets, fixture clock acceleration and automatic scheduler/worker steps are not counted as human work. Readiness timing excludes shared browser fixture preparation and is not a live service latency target.

The login wallet is absent from public HTML/scripts. It appears only after normal fixture authentication/verification, then the production passive scanner captures it with redaction. QR/dynamic/modal cases use real rendered detection. Decoys cannot become validated/report wallets. Ambiguous network remains Needs you with no valid wallet or report. No-wallet/unsafe cases park without a report. Wallet-change validates two wallets while retaining one exact report. Related-case Finder discovers the new deployment; bounded child mission creation/recovery is separately verified. These scopes do not prove external child reports.

Each runtime's joined artifact retains 150 module trace entries and 2,526 recorded request-URL events. These trace events mix public/DNS/certificate/provider fixture requests and do not include a complete cross-module wire count or every Main/browser request. Per-case comprehensive network cost is therefore not certified. The unchanged pursuit benchmark supplies its own explicit request-unit measurement. Precision/recall equal 1 for the accessible deposit fixtures where a labeled deposit exists; empty/ambiguous cases retain null recall rather than inventing recall.

## Wallet, provider, report and operation boundaries

Logger remains a passive sensor on the 2.0 wallet-observation interface, with version 0.9.0 compatibility preserved. Candidate deposit context, deterministic address/network validation, provider analysis and report authority remain separate. EVM network is never inferred from address syntax. QR/config/network/script/passive DOM paths retain provenance. Contract/example/history/withdrawal/exchange labels do not silently become deposits.

Wallet Investigator retains bounded read-only Blockscout adapters for Ethereum/Optimism/Base/Arbitrum/Polygon/BSC and Bitcoin Esplora support. Provider credentials belong only to that specialist. Partial history, retry timing, outages, deterministic negatives and unavailable providers remain visible. No wallet signing, transaction submission, funds movement, credential guessing or authentication bypass was added. Chain transactions and common counterparties do not establish common ownership.

The existing director coordinates ordinary site/observation/validation/analysis/report work. A legacy operation projection can no longer queue analysis for a WI-derived entity lacking an eligible SI/Logger observation version; existing pipeline ownership remains authoritative. Typed deposit presentations resolve an obsolete no-deposit gap without claiming network validity. Real ambiguous-network and provider-outage fixtures retain truthful checkpoints/retry states. Report contents are prepared automatically, but approval binds the exact hash and destination. Uncertain receipts remain uncertain with idempotent reconciliation; a response loss cannot automatically create a second logical submission. Local synthetic form receipts are explicitly identified.

Hunter/operation/adaptive/scientific layers retain observations versus inferred relationships, alternatives, discriminating tests, contradictory evidence, uncertainty, gap exhaustion, costs and outcome lineage. Historical joined/operation/scientific/crash tests pass. Unsupported ownership assertions and generic infrastructure traversals remain prohibited. The scientific policy was not tuned on the frozen holdout or altered to improve the release score.

## Crash, replay and quiescence

The v10 matrix performs 18 actual SIGKILL boundaries before/after search creation, selection, site creation, mission creation, search attachment, child reservation, child site creation, child attachment and mission history. Two additional actual kills target the fourth Finder-generation job commit. Production functions/routes operate over file-backed SQLite with a D1 double; lease expiry is accelerated after restart. All 20 cases preserve candidate provenance and have zero duplicate active jobs; generation stays exactly four with a truthful parked search after exhaustion. Historical crash/replay/provider/submission groups also pass in their stated local scope. Remote D1 process termination, actual installed browser worker termination and live mailbox/form server failure are not certified.

Mission history is content-addressed, selected/reserved work resumes, resource reservations are atomic and unchanged evidence references remain canonical. The native sync test was corrected to observe durable error/retry state rather than a fleeting “offline” label: it deliberately delays the observer and checks pending count, one failed attempt, future retry time, alarm retention and truthful offline/waiting status. Both full native 52-test reruns pass. The original Node22 timing failure log remains retained; production sync code was unchanged by that test correction.

## UI and runtime verification

The full Main activation audit hydrates 21 pages at first start: 466 recorded controls, 434 activated, zero failures. After Main restart it hydrates 21 pages and activates all 242 recorded controls with zero failures. The first pass records 33 warnings, including controls removed by prior mutations and cancelled navigation GETs; these are retained. Only expected cancelled GET reads during navigation are warnings; HTTP/server errors and other failed requests remain failures. Separate suite tests pass 40 browser checks. Native module view smoke covers 60 views at desktop/1024/375 with zero errors; Logger accounts and compiled Main mission/suite pages also cover 1600. Native data-dependent controls are not all covered by the Main audit.

Request lifecycle tests cover stale responses, context changes, guarded local storage and canonical Start coalescing. The earlier sweep exposed six restart-navigation 404s; they were fixed in the client by persisting the returned canonical search ID and the full sweep rerun passed. No 404 suppression was used.

Both clean Main trees use fresh npm ci (683 packages), actual Node22.18 and24.19 executables, unchanged package locks, TypeScript, full ESLint and compiled worker builds. The Node24 offline install initially lacked one tarball; a normal install populated the cache before the successful offline rerun. Specialist dependencies use retained cached trees with identical lockfiles; Wallet Investigator/Form/Hunter production builds pass on Node24.

The final unit list passes 43/44 with one explicit skip for the unused node:sqlite fallback because actual sql.js is installed. Full lint has 0 errors and 231 warnings, with the rules unchanged. All 147 JavaScript/MJS syntax checks pass on each runtime and 237 Python files parse. Compiled production browser tests use actual Wrangler/Cloudflare worker and local D1 migrations, source fixture ingestion, hydration, primary no-URL Start, reload recovery and secondary supplied-URL mission routing: seven checks per runtime, zero page errors, 375/1024/1280/1600 without overflow.

One earlier Node24 production run reported all migrations successful but its persisted ledger/schema later lacked 0021/0022. Read-only diagnostics confirmed that discrepancy. Applying only the pending migrations recovered the same database, and its seven-check smoke passed. Startup now separately verifies the persisted migration ledger and eight search/mission tables, retries pending migrations once, and exits without serving if readiness still fails; it never resets data. Six readiness regression cases pass per runtime. Final new isolated production states pass on both runtimes. The underlying intermittent Wrangler persistence discrepancy is not conclusively diagnosed; failed logs and recovered-state evidence are retained.

## Historical regression matrix

The matrix ran all groups on actual Node22 and Node24 and continued after failures. It finished 19/20 groups per runtime. Detailed exit codes are in `verification/v10/final-historical-node22.json` and `final-historical-node24.json`.

| Group | Node22 | Node24 |
|---|---|---|
| migration-matrix | VERIFIED | VERIFIED |
| autonomy-v10 | VERIFIED | VERIFIED |
| unit | VERIFIED | VERIFIED |
| director | VERIFIED | VERIFIED |
| loops | VERIFIED | VERIFIED |
| integration:v6 | VERIFIED | VERIFIED |
| v2 | VERIFIED | VERIFIED |
| v3 | VERIFIED | VERIFIED |
| v4 | VERIFIED | VERIFIED |
| v5 | VERIFIED | VERIFIED |
| joined:hunter | VERIFIED | VERIFIED |
| joined:v61 | VERIFIED | VERIFIED |
| five-modules | VERIFIED | VERIFIED |
| startup:modules | VERIFIED | VERIFIED |
| site-finder | VERIFIED | VERIFIED |
| wallet-pipeline | ENVIRONMENT-BLOCKED (see qualification) | ENVIRONMENT-BLOCKED (see qualification) |
| operation-intelligence | VERIFIED | VERIFIED |
| adaptive-intelligence | VERIFIED | VERIFIED |
| scientific-intelligence | VERIFIED | VERIFIED |
| full-autonomy | VERIFIED | VERIFIED |

`wallet-pipeline` was nonzero because genuine installed-extension startup failed in steps 2 and 6 on both runtimes. Node24 passed its other four steps. Node22 additionally recorded the native sync transient-state observer failure (44/45); the stronger durable observer correction and full 52/52 native rerun pass on both runtimes. The historical failing log is not rewritten into a passing result. Installed checks remain blocked and were not replaced by transport-shim success.

The historical matrix/golden/UI evidence used freeze24; final executable changes since that freeze are only the production startup schema check (separately tested/unit/build/production smoke on both runtimes) and a native observer test correction (52/52 rerun). The final README/guide edits are documentation only. The release audit compares file hashes to establish this component scope. Main product components exercised by the joined/UI/scientific/historical tests are unchanged. Code freeze27 final gates and the documentation-only freeze28 identity are both retained in the ledger; there was no untested change to those product components.

## Independent quality and large-state measurements

The frozen independent compound holdout uses six seeds and six unfamiliar multi-operation shapes (36 observed states), cloned-world counterfactuals and production decision policies. It is not a live provider benchmark. Final Node22/24 reruns reproduce the original independent metrics exactly.

| Policy | Optimal choices | Near-optimal rate | Mean regret |
|---|---|---|---|
| Current carried v9 scientific policy | 2/36 (5.56%) | 8.33% | 1.95325 |
| Confirmation comparator | 6/36 (16.67%) | 16.67% | 1.705694 |
| Random comparator | 1/36 (2.78%) | 2.78% | 3.368556 |

Status: **FAILED** independent decision quality. Successful holdout execution does not improve this result. The carried training/held-out benchmarks and all per-state outputs remain included. No weights, corpus labels, seed lists or target thresholds were changed to make this release pass.

The unchanged large-state fixture contains 10,000 entities, 50,100 canonical relationships, 5,000 evidence rows, 300 investigations, 25 operations, 10,000 prior tests/decisions, 144,000 decision components, 100,000 cost rows, 30,000 prior outcomes and 30,000 scientific history rows. Timings come from actual Main routes and a local file-backed SQLite D1 double, not remote D1 service measurements.

Profiling found 73,700 evidence-reference queries costing 2,192.6 ms in aggregate. Bounded page batching reduced that to 142 calls/182.15 ms in the retained paired profile, preserving all canonical refs and the sorted 100-reference projection limit. Unchanged edge/member writes were removed while retaining analyst membership. The next correlated corpus-count query was batched per distinct page target; all fields/order/counts of 2,000 edges matched the original query, including out-of-operation relationships and 2,423 canonical source relations. This is a measured query improvement, not proof of acceptable end-to-end scale.

| Measurement | Queue reconciliation ms | First projection/run growth bytes | Peak RSS KB | Five quiet reads growth bytes | Quiet history additions |
|---|---:|---:|---:|---:|---:|
| Immutable v9 baseline | 2348.25 | 76292096 | 334360 | 0 | 0 |
| Final isolated Node22 | 3623.79 | 76341248 | 240172 | 0 | 0 |
| Final isolated Node24 | 3493.47 | 76341248 | 350948 | 0 | 0 |

Status: **FAILED** large-state responsiveness/storage target. Quiet reads add no database bytes or scientific history, but first projection still grows about 76 MB and reconciliation remains seconds; it has not been eliminated. Final isolated runs occur without the heavy matrix/UI/build gates running concurrently. The v10 profiler adds read timing hooks and dbstat page accounting; single-run timing differences from the original baseline are not claimed as a causal speedup/regression. The full database page-usage breakdown, all timings, memory and SQL profiles are included in `profile-final-isolated-node22/stress.json` and `profile-final-isolated-node24/stress.json`. No provenance was deleted to reduce growth.

## Installation, upgrade and recovery

Keep these sibling directories exactly as packaged: `main-investigation-platform-v9-suite-v7-adaptive-intelligence` and `operation-hunter-v2.0` (or set an absolute HUNTER_DIR). Full instructions are in Main `README.md` and `V10_RELEASE_GUIDE.md`.

1. Stop all old services and back up the complete old folders, private config, D1/specialist databases, evidence, Hunter data and extension settings. Keep that backup untouched.
2. Extract the release into a new directory. Copy existing `.dev.vars`, the complete `.wrangler/state` or custom `MIP_PERSIST_TO`, specialist `.env` and data/evidence, and Hunter data to matching locations. Never overwrite an existing database with an empty one. Keep the extension storage/profile settings.
3. Install/build with the commands below, then run the suite. Ordered additive migrations 0021/0022 extend existing state; readiness is verified before serving. Roll back by restoring the complete pre-upgrade backup, not by downgrading a used v10 database.

From Main on Linux/macOS:

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

On PowerShell the npm commands are the same; use `py -3 -m venv .venv`, `.\.venv\Scripts\python.exe -m pip install -r integrations/site-finder-v07/requirements.txt -r integrations/site-investigator-v01/requirements.txt`, and `.\.venv\Scripts\python.exe -m playwright install chromium`. Native Windows verification is blocked. Node requires 22.13+; the actual tested versions are 22.18.0 and24.19.0. Set MIP_PYTHON to a Python3 interpreter where needed.

The launcher preserves existing config or generates six local random module keys on a fresh install. It starts Main :8787, Wallet :3001, Form :3002, Hunter :3003, Finder :5000 and Site Investigator :8765, and runs non-overlapping maintenance every 15 seconds. Open `http://127.0.0.1:8787` and choose **Start Investigation**. The launcher still prints the compatible secondary “Investigate Site” label in its console; the dashboard provides the primary no-URL action. Ctrl+C stops suite children. Configure the permitted reporting destination/verified field mapping in Form Submitter, and the `crypto_wallet_logger` module key in the unpacked extension. Put a supported Blockscout provider key only in Wallet Investigator's own `.env`. Never enable synthetic provider fixtures for real investigations.

Load `integrations/crypto-wallet-logger-v08` as an unpacked Chromium extension. Its options page opens Private Account Workspace. Explicitly prepare/import only an account you are authorized to use, fill the matching HTTPS tab, complete normal login/verification yourself, browse the deposit page, then review and approve the exact Main report. Browser CAPTCHA/MFA/normal verification remain operator actions. Real installation still requires a functioning browser environment; these instructions are not a claim that the blocked installed test passed.

A recovery ZIP includes both source folders and `V10_SOURCE_MANIFEST.json`. Check ZIP CRC and every manifest SHA-256 before restoring into a fresh directory. Reuse backed-up configuration/state only after preserving the originals. Archive screening excludes dependencies, runtime databases, browser profiles, real `.env`/`.dev.vars`, private vaults and caches. Public tests use explicit synthetic secrets and provider/page responses. Zero configured private module-key matches were found in the screened deliverable files. This is a bounded content audit, not proof against every possible unknown secret.

## Evidence index and remaining work

Current evidence is under Main `verification/v10/`: `release-node22-gates.json`, `release-node24-gates.json`, `release-node22-production.json`, `release-node24-production.json`, both `final-historical-*.json`, `final-node*-artifacts/v10/golden.json`, canonical UI sweep JSONs, full native Logger logs, readiness logs, source/syntax audits, and final isolated stress profiles. `baseline/` retains unchanged v9 lint/quality/stress measurements. Earlier failed UI/startup/installed/native runs remain alongside their successful superseding scoped runs. Versioned earlier reports remain historical and must not be read as current certification.

To claim a fully verified production release still requires: working real installed Chromium/worker tests; native Windows operation; live authorized mailbox/provider/external-form verification; exhaustive native data-dependent control coverage; independent confidence field calibration; full multi-child external report flows; better independent scientific decision quality; and improved large-state reconciliation/first-projection growth without losing provenance. The current source is packaged with these limitations explicit.
