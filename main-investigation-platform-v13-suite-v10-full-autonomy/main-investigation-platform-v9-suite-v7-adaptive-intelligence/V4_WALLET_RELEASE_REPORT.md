# Suite v4: autonomous wallet discovery and reporting

Built on the hardened v3 release (`main-investigation-platform-v6-suite-finder-v3-hardened.zip`). Everything from that
release is kept: the Windows fixes, the atomic Wallet Investigator database, the sql.js / Node 24 fix, temp-file
cleanup, the pursuit engine, Investigation Mode, Operation Hunter, provenance, migrations, launcher paths and the
five-tool shell. The shared contract `sdk/contracts/v6.json` is unchanged.

## What changes for you

1. You open a site you are investigating and, if it needs it, **log in yourself**.
2. **Wallet Logger 0.9** watches what your browser shows while you browse and click normally. It covers page text,
   inputs, dynamic content, modals and tabs, Shadow DOM (open and closed), copy buttons, QR codes, page scripts and
   config, network responses, and addresses that appear only after you interact. Each sighting is classified as
   deposit, withdrawal, example, transaction history, contract, unrelated or unknown, together with the words and
   structure that led to that class.
3. Sightings reach Main as `wallet.observation` events. If Main is down, they queue and arrive later, even across a
   browser restart.
4. Main merges sightings into **one candidate per wallet**: same address, any page, tab, letter case or method. Every
   sighting is kept as evidence.
5. **Wallet Investigator validates every candidate** with real checksums: EIP-55, base58check, bech32/bech32m, TRON,
   XRP and Solana length. It never guesses between EVM networks. The outcome is one of valid, invalid, network
   ambiguous, unsupported or unable to validate. Only **valid deposit wallets** are analysed, within the existing
   wallet budget.
6. Main builds the report by itself, with exactly the confirmed deposit wallets, their deposit evidence, the
   blockchain evidence and the destination form. Site Finder → Investigate shows a **Wallet pipeline** card:
   observations, validated, rejected, confirmed deposit contexts and report state. Click any wallet to see what it is,
   where it was found, why it counts as a deposit wallet, whether it validated, and whether it is in the report. The
   card also shows **Likely wallet page — Open** links, which you open yourself.
7. When the report is complete, the card (and Form Submitter → Review) shows **Ready to report** with:
   - the site
   - the confirmed wallets and their networks
   - the deposit evidence and blockchain evidence
   - the destination
   - warnings

   You press **Approve & Submit** once.
8. Your approval is **bound to the exact contents and destination** (`content_sha256`). If either changes before
   Form Submitter starts, the approval is withdrawn and you are asked again. Form Submitter re-checks the
   destination itself before filing, files each report once, and **stops for you** at a sign-in, CAPTCHA or other
   verification page. Nothing is bypassed.

Nothing is submitted without your approval. The Logger never navigates, clicks, logs in, submits forms or makes
requests of its own.

## What changed, by component

**Main**
- `drizzle/0015_wallet_pipeline.sql`: five new tables (`wallet_candidates`, `wallet_observations`,
  `wallet_discovery_stats`, `report_contents`, `module_destinations`). The migration is additive and idempotent, and
  dropping the five tables restores the previous schema (tested). The schema gate requires it.
- `lib/wallet-pipeline.ts`: candidates and observations, job routing to WI (validate-only for non-deposit contexts,
  analysis for deposit contexts), report building and rebuilding, approval checks, the read model for the UI, and
  likely-page scoring learned from which pages produced confirmed wallets.
- `lib/logger-adapter.ts`: accepts `wallet.observation` 2.0.0, including token-only hints (`network: null`). The v0.8
  events are still accepted.
- Ingest route: WI results move candidates along. An address WI did not confirm stays out of the wallet graph; its
  result is kept on the candidate. Legacy evidence events from 0.9+ Loggers no longer create wallet entities.
- Report route: approval requires `content_sha256`. It returns 409 `REPORT_CHANGED` when the report was replaced
  while you looked at it.
- New `POST /api/v1/modules/form_submitter/destination`: Form Submitter reports its form, and a change withdraws
  approvals that haven't been handed over yet.
- The scheduler reconciles the pipeline (failed or stuck jobs). Its "wallet not analysed" gap no longer queues a
  second, older-style analysis for pipeline wallets.
- UI: `components/suite/wallet-pipeline.tsx` (pipeline card, drill-down, likely pages, Ready to report), used in
  Site Finder → Investigate and Form Submitter → Review. Form Submitter's approve button now sends the content hash.

**Wallet Logger 0.9.0** (folder name kept: `integrations/crypto-wallet-logger-v08`)
- New `wallet-core.js` (extraction, checksums, network hints, context classifier), `page-hook.js` (MAIN-world, reads
  only responses and config the page already received), jsQR fallback for QR codes, and the `wallet.observation`
  event.
- Same permissions as 0.8. `minimum_chrome_version` is 111 (closed shadow roots).
- Precision rules: evidence about the address itself outweighs a heading shared with the whole card. Deposit wording
  found only in the wider section gives `unknown` when that section shows other addresses. Broken-checksum
  mixed-case EVM addresses are never `deposit`. Details are in the Logger README.
- Sync queue: serialised writes, so an enqueue during a drain is never lost, and it drains on browser start.

**Wallet Investigator**: `validateWalletAddress` rewritten with real checksums; `processV4` handles `wallet-v4` jobs.
A provider outage gives a PARTIAL analysis, and the report says so.

**Form Submitter**: v4 reports are filed from the frozen wallet list (exact case). The destination is reported to
Main and re-checked before filing. A stop for human verification is reported as "Stopped for you: …".

## Problems found and fixed while building v4

| Problem | Root cause | Fix |
|---|---|---|
| Report stuck at "building" after a candidate turned out invalid or ambiguous | The report was rebuilt only when a candidate became valid | Rebuild on every WI result |
| Approving a just-replaced report said "already decided" | Superseded candidates hit the generic status check | 409 `REPORT_CHANGED` with a plain message |
| Re-approved report never submitted | The cancelled submission job kept its dedupe key | Cancelling releases the key and logs a job event |
| "Ready to report" could change after approval (analysis finished late), withdrawing your approval | Readiness ignored analysis still running | Not ready while blockchain analysis is still running |
| Main rejected about 12 % of Logger events in the benchmark | Token-only hints (`network: null`) failed Main's schema | Accepted and treated as no network |
| Unconfirmed addresses became wallet entities (`unknown:evm:0x…`), splitting one address into several entities | WI's unconfirmed results were ingested as wallets | Kept on the candidate, out of the graph |
| Logger 0.9's legacy deposit-section evidence also created an unconfirmed wallet entity (`unknown:<address>`, base58 lowercased) | The v0.8 evidence path attached a wallet entity | For 0.9+ Loggers that evidence is attached to the site; wallets come only through validation (0.8 Loggers unchanged) |
| The scheduler queued older-style analyses of pipeline wallets, which failed | Gap detection didn't know about the pipeline | Skipped for pipeline wallets |
| Approval notice disappeared as soon as the report moved on | Message lived inside the panel that unmounts | Notice kept on the card |
| "Ready to report" showed evidence counts, not the evidence | The summary stored counts | The summary is the frozen wallet entries |
| Form Submitter stopped without saying why at CAPTCHA/sign-in | The reason was dropped | "Stopped for you: …" with the reason |
| You learned only after approving that the form can't express Polygon / Arbitrum / Optimism / Base / Avalanche / native BNB, or ambiguous "3…" BTC/LTC addresses | No warning before approval | Warning in Ready to report |
| Saving the Logger's settings while it was writing its own state could silently undo them, so sync showed "disabled" and stopped (pre-existing since 0.8; it caused one unexplained E2E timeout) | Background writes put back a stale copy of `settings` | Those writes re-read settings first and merge only custom labels. The check fails without the fix and passes with it |
| Logger classified 18 benchmark decoys as deposit | Section-level cues outweighed what was said about the address | Closest-evidence rules, now 0 (see benchmark) |
| Logger "your wallet address" withdrawal rule never fired | "y**our**" matched its own exclusion | Fixed |

## Tests

New group: `node scripts/run-tests.mjs wallet-pipeline` (`npm run test:wallet-pipeline`).

- **Logger unit tests** (45): wallet-core vectors, URIs, hints, classifier, context precision, JSON scanning, sync
  queue.
- **Logger real-extension browser test** (93 checks): every placement, decoys never deposit, one identity per
  wallet, contract shape, no extension-initiated requests, page behaviour unchanged, and a settings change surviving
  a concurrent background write.
- **WI** `validation-v4` (25 tests) and `platform-worker-v4`.
- **`tests/wallet-pipeline-e2e.mjs`**: real Main routes, the real WI worker and the real Form Submitter worker. It
  covers:
  - multiple wallets, duplicates and replays
  - an invalid checksum
  - an ambiguous EVM network
  - example and transaction-history decoys
  - a token-only hint
  - provider outage (analysis PARTIAL)
  - scheduler ticks
  - a report that changes after you opened it
  - an approval without a hash
  - a duplicate approval
  - a Main restart on the same address
  - exactly one submission
  - a destination change reported to Main, and one noticed only by Form Submitter
  - a CAPTCHA stop with no retry
  - an ambiguous wallet alone (no report)
  - one wallet entity per address
  - no server errors
- **`tests/wallet-browser-e2e.mjs` + `.py`**: Chromium with the real extension, Main with its UI, and WI and Form
  Submitter as separate processes. In order:
  1. You log in by typing into the site's form, switch a network tab and copy an address.
  2. Main and WI are stopped while you browse.
  3. The browser is closed with events queued.
  4. Main comes back and the Logger reconnects and drains.
  5. WI is restarted and catches up.
  6. Main builds the report; the pipeline card and drill-down are checked in the UI.
  7. **Approve & Submit** is clicked in Main's UI.
  8. The report is filed exactly once.

  Result: the 3 deposit wallets in the report, 4 decoys kept out, 7 human actions in total, of which 1 is a report
  action.

Full regression (`node scripts/run-tests.mjs all`, 15 groups, Operation Hunter required):

- **Node 22:** all 15 groups pass. This full run predates the final Logger fix (the settings race in the table above); after that
  fix, the browser E2E passed 3 runs in a row and the Logger browser test passed every time.
- **Node 24:** all 15 groups pass: 14 in the final full run, and wallet-pipeline in a rerun after the last Logger
  change.
- **Transient failures seen during development, and what happened to them:**
  - The Logger sync-queue unit test timed out once on a busy machine. It then passed 46 runs in isolation, including
    under CPU load, plus every later group run. I found no race, so I'm reporting it rather than hiding it.
  - The browser tests sometimes configured the extension before Chrome had attached its APIs. They now retry that one
    startup error.
  - One E2E timeout came from the settings race in the table above.

Existing tests changed (no expectation weakened):
- The Logger browser test retries the one startup error described above.
- The 0014 rollback test now accounts for objects added by later migrations.
- The in-place upgrade list includes 0015.
- A new 0015 additive/idempotent/rollback test was added.
- `tests/lib/main-harness.mjs` can restart on the same port and closes idempotently.

## Benchmark (independent; `/bench-wallet`, not tuned against)

The benchmark was built by a separate agent from the task brief and the shared contract only (its independence
statement is in `bench-wallet/README.md`). Neither the Logger tuning nor any fix used its corpus.

**Corpus:** 44 HTTPS sites, 92 real deposit wallets and 816 decoys (contracts, transaction IDs, examples,
placeholders, malformed addresses, your own withdrawal address, transaction counterparties and unrelated addresses),
across 13 placements: plain, dynamic, modal, tab, input, copy-only, open and closed Shadow DOM, API response, script
config, QR-only, iframe, and behind a login.

**Method:** both trees' real Loggers browse every site in Chromium with the same user script. The captured events are
then replayed into each tree's real Main, Wallet Investigator and Form Submitter with a 5-minute analysis window. The
chain provider is synthetic, so analysis is PARTIAL (a provider outage). The benchmark approves every report it is
offered.

Seed 1, final run, baseline = hardened v3:

| Metric | Baseline | v4 | |
|---|---|---|---|
| Real deposit wallets found (recall) | 53 (0.58) | **92 (1.0)** | win |
| Recall on copy / Shadow DOM / script / QR | 0.14 / 0 / 0 / 0 | **1.0 on all** | win |
| Real wallets classified deposit | 0 | **92** | win |
| Decoys classified deposit | 0 | **0** (was 18 before the precision work) | — |
| Logger network hint correct | 51 | **92** | win |
| Logger events accepted by Main | 884/884 | **914/914** | — |
| Wallets reaching Wallet Investigator | 3 | **92** | win |
| WI network correct | 3 | **81** | win |
| Main entities per wallet / wallets split | 1.09 / 5 | **1.00 / 0** | win |
| Validated wallets in reports | 0 | **81** | win |
| Sites with a report built automatically | 0 | **43** | win |
| Reports needing manual wallet entry | 44 | **1** | win |
| Human actions (total) | 180 | **46** | win |
| Completed, verified submissions | 0 | **19** | win |

**Losses, and why:**
- **Unique reported precision 0.16 vs 0.17; false detections 484 vs 257.** v4 reports *every* address the browser
  shows, as a classified observation, including examples, contracts, withdrawal addresses and history rows. That is
  the brief's "detection ≠ validation". None of them is classified deposit, and none reaches a report. The relevant
  precision, of deposit-classified observations, is 1.0.
- **Decoys sent to WI: 484 vs 31.** Every candidate is validated by WI (the brief's Logger → Main → WI rule). Decoys
  get validate-only jobs at the lowest priority, with no chain queries and no wallet budget. Main's limit of 120
  requests per minute per module caps WI at about 20–25 jobs a minute, so this queue drains slowly. It never delays
  deposit wallets, which run first.
- **"WI ambiguous handled correctly" 0 vs 1.** The 7 EVM wallets shown with no network were correctly validated as
  `network_ambiguous` and kept out of reports (asserted by `tests/wallet-pipeline-e2e.mjs`). The benchmark reads WI
  results from wallet entities, and v4 deliberately no longer turns an unconfirmed address into a wallet entity, so it
  can't see them. An earlier run, before that change, scored 7.
- **19 of 43 auto-built reports were filed:**
  - **10 were not ready**, because of the existing two-evidence rule. These sites showed the wallet once, and with
    the synthetic provider the analysis gave no blockchain evidence. With a working provider, the analysis supplies
    the second item. Ready to report says exactly this.
  - **14 approved reports stopped in Form Submitter for a person:**
    - 10 because the reporting form has no option for the wallet's network (each contained a Polygon wallet, or a BSC
      wallet without a USDT label)
    - 3 on its own ambiguity gate (Bitcoin addresses starting with "3")
    - 1 legacy evidence report without wallets
  - **1 was still being filed** when the window closed.

  The reporting form decides which networks can be filed. v4 now warns about these cases before you approve.

Earlier v4 runs during development: the first full run found Main rejecting 113 of 916 Logger events (token-only
hints) and 11 wallets split across entities. Both were fixed (see the table above), and the final run shows
914/914 and 0.

Single seed. The browser stage varies by ±2 wallets between runs on the baseline; v4 found 92/92 in all four runs.

## Known limitations and Windows notes

- **Production build:** the UI was bundled with esbuild and exercised in a real browser, but `npm run build`
  (vinext) could not run here because the npm registry is blocked in the build environment. Run `npm ci && npm run
  build` on Windows before deploying, as for every release.
- **Reload the extension** after upgrading (chrome://extensions → Reload). It needs Chrome 111 or later.
- **Apply migration 0015** (the production start applies pending migrations). Back up first, as always.
- **Unconfirmed addresses** (examples, contracts, withdrawal addresses) are sent to WI for validation only: no chain
  queries and no wallet budget. That is why "decoys sent to WI" is high in the benchmark.
- The reporting form has **no option** for Polygon, Arbitrum, Optimism, Base, Avalanche or native BNB, and asks you
  to confirm "3…" Bitcoin/Litecoin addresses. Form Submitter stops for you on those, and Ready to report warns
  beforehand.
- **Provider outages:** a PARTIAL analysis is not retried automatically when the provider recovers. A site where
  the wallet was seen only once can then stay below the two-evidence rule, and Ready to report says so.
- **Decoy validation throughput** is capped by Main's limit of 120 requests per minute per module (about 20–25 WI
  jobs a minute). On a page with many example or history addresses, those validations finish minutes after the
  deposit wallets. They never hold up the report.
- **Base58 entity keys:** Main lowercases whole entity keys (pre-existing). The exact address is kept on the
  candidate and in the report, and that is what is filed.
- **Site Finder's tests** write screenshots into `integrations/site-finder-v07/evidence/screenshots` (pre-existing,
  also in v3). They are left out of the zip; delete the folder's contents if it grows.
- Context classification is heuristic (mostly English wording plus page structure); other languages may fall back to
  `unknown`.
