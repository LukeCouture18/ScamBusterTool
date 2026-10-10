# Main Platform v2 + Site Finder v2 — implementation report

**Goal:** maximise the share of surfaced sites that are actually worth checking by hand. Volume and the amount of collected data are not the target; precision is.

**Result on the simulated benchmark** (details and caveats in `V2_BENCHMARK_REPORT.md`):

| Split (5 seeds × 6 rounds) | v1 precision | v2 precision | Useful sites surfaced, v1 → v2 |
| --- | ---: | ---: | ---: |
| eval (held out) | 40.6% | **99.1%** | 39 → 447 |
| stress (built to break v2) | 32.5% | **100.0%** | 25 → 347 |
| dev (used while building) | 40.8% | **98.3%** | 49 → 400 |

These numbers come from a simulated internet that I also built. They show the mechanisms work and that v2 fixes v1's failure modes. They are not a forecast of live precision. `integrations/site-finder-v07/benchmark/live_ab.py` runs a blind live A/B that you judge.

---

## 1. What was hurting precision in v1

Found by reading the code, then confirmed with v1's own code in the benchmark and, for the two contract bugs, against the platform's real ingest route.

| # | Weakness in v1 (v0.7 Site Finder / v6.1 platform) | Effect | v2 fix |
| --- | --- | --- | --- |
| 1 | No detection of parked, for-sale, server-default, suspended or coming-soon pages. | Parked crypto names with "Deposit Bonus / Crypto Investment / Telegram" ad links pass triage (suspicious TLD + brand + deposit words). **Parked pages were v1's largest noise class in every split.** | Hard gates using page markers and parking nameservers. Crypto-named parked and coming-soon domains are rechecked later (change detection). |
| 2 | Triage follows redirects but scores the *original* domain. | A brand-owned typo that redirects to the real exchange is scored as impersonation with the real exchange's content. **Second-largest noise class.** | Redirects to an allowlisted site are gated. Other off-domain redirects are re-keyed to the final domain. |
| 3 | News, review, forum and HYIP-monitor pages use scam vocabulary. | Pass triage. | Informational gate. Domains those pages name or link become discovery leads instead. |
| 4 | Indicators without context: `withdraw`, `deposit`, `telegram`, any 0x address; brand substring match (`ledger`, `gemini`). | Legitimate exchanges, DeFi docs and crypto blogs trip three or more categories. | Typed evidence. Delivery requires a **core** signal (see §2.4). Checksum-validated addresses only count as a *deposit* address; donation, contract and "reported by users" contexts are excluded. Brand matching is token-aware with edit distance. |
| 5 | Dedup on full hostname. | `mail.x`, `cpanel.x`, `webmail.x` (cPanel AutoSSL puts them on every certificate) and kit clones each surface separately. | Registrable-domain keys (with multi-part and hosting-platform suffixes). Infrastructure labels are sightings, not sites. Operator clusters keyed on wallet, certificate, chat backend or uncommon favicon. |
| 6 | CT source: fragments like `invest`, `exchange`, `trading` rated 0.75 just for a recent certificate; the 150-candidate cap means only the first query ever runs. | Every run returns the same newest slice of one noisy term. | Rotated scam-specific terms, per-term performance tracking, and a staleness discount. |
| 7 | Shared-IP corroboration against any IP, including CDN and shared hosting. | False "shared infrastructure" boosts. | IP and nameserver are never merge keys. Infrastructure seen only on parking pages is learned and skipped before fetching. |
| 8 | Pivots seed from sites v1 itself scored highly. | Errors propagate. | Pivots (certificate siblings, name patterns, learned CT stems) seed from sites **you** marked USEFUL. |
| 9 | **Contract bug:** raw triage scores (6–20) sent as `confidence`, but the platform caps it at 1.0. | Verified with the original code against the platform ingest route: the site and evidence records are dead-lettered. No promoted v1 site could reach the platform. | Confidence mapped into [0, 1]; v2 sends p ∈ [0, 1]. |
| 10 | **Contract bug:** the SDK copy bundled in Site Finder sends ingest schema `1.1`. Under 1.x, promotion needs `triage.passed`, which the strict schema forbids. | Verified: even with valid confidence, no `site.triaged` and no `INVESTIGATE_SITE`. | Bundled copy synced with the canonical `sdk/python` (schema 3.0). |
| 11 | Every discovered domain queued a platform batch before triage. | The platform database fills with unreviewed noise. | Off by default in v2; only inbox candidates reach the platform. |
| 12 | No path for your judgement to reach discovery. | Discovery couldn't learn what you consider worth your time. | Inbox decisions feed strategy budgets, signal weights and cluster priors (§2.6). |

## 2. Site Finder v2 (`integrations/site-finder-v07/app/v2/`)

The folder name is unchanged so the Launcher and existing scripts keep working. All v0.7 code paths, APIs, the dashboard (now at `/advanced`), campaigns and tests remain. The v0.7 suite passes unchanged (421 tests), plus 29 new v2 tests.

```
strategies ─▶ intake ─▶ probe (budgeted) ─▶ gates ─▶ evidence ─▶ enrich ─▶ cluster ─▶ score ─▶ inbox
    ▲                                                                                    │
    └──────────────── your USEFUL / SKIP decisions (budgets, weights, priors) ◀──────────┘
```

### 2.1 Discovery strategies (`strategies.py`), all passive and public

| Strategy | Source |
| --- | --- |
| `ct_terms` | crt.sh searches over rotated scam-specific name fragments (usdt, trc20, invest, yield, mining, arbitrage, stake, recover, airdrop, …); only certificates ≤30 days old. |
| `ct_learned` | crt.sh searches for name stems learned from sites you marked USEFUL (finds kit clones). |
| `cert_siblings` | Other registrable domains on the same certificates as USEFUL sites. |
| `pattern_siblings` | Numbered, affixed and re-TLD'd variants of USEFUL names, DNS-checked. |
| `brand_typos` | Brand look-alikes (typos + scam affixes like `-verify`, `-kyc`, `-claim`), rotating through brands and TLDs. |
| `feeds` | Your configured public scam-report feeds (same `feeds.txt` as v1). |
| `mentions` | Domains linked or named on review, monitor and forum pages that the informational gate filtered. |
| `recheck` | Crypto-named parked, placeholder, coming-soon and dead domains re-probed after a delay. |

### 2.2 Intake and probing (`engine.py`, `netio.py`, `domains.py`)
Every lead collapses to a registrable domain and is deduplicated against everything seen before; every route that reached it is kept as provenance. Probing costs DNS (A + NS), one GET of the public page, plus the public JS bundle for app shells and the favicon and RDAP registration date for shortlisted candidates. It is bounded by a per-round budget (default 200 HTTP, 600 DNS, 12 crt.sh, 60 RDAP) and spent in the order the adaptive allocator picks. A candidate whose checks were cut short by the budget is **held, not delivered**, and finished first next round.

### 2.3 Gates (`classify.py`)
`dead` · `parked` · `for_sale` · `placeholder` · `suspended` · `coming_soon` · `redirect_legit` · `informational` · `legit` (regulator registration **and** statutory risk warnings) · `not_crypto` · `thin`. Each gate records a reason. Several schedule a recheck.

### 2.4 Evidence (`signals.py`) and the delivery rule
**Core** signals, at least one required: fixed daily return · pay-before-withdraw trap · checksum-valid deposit address · recovery-phrase request · brand login page on a look-alike domain · login-gated trading-app kit (from the page or its public bundle: recharge/withdraw/invitation-code/seconds-contract strings) · fund-recovery pitch.
**Supporting** signals: plan tiers, VIP ladders, referral commissions, fake payout counters, deposit instructions, invitation code, off-platform support, unverifiable licence claims, urgency, registration age, throwaway TLD.
**Counter** signals: regulator registration, statutory risk warnings, security-education text, domain registered ≥ 6 months / ≥ 2 years.

### 2.5 Clustering (`cluster.py`)
Merge keys: the same validated deposit address, the same certificate, the same embedded chat or customer-service backend, or the same uncommon favicon (default and framework icons are excluded by a popularity cap). Only one member of a cluster reaches you ("N related sites"). A mirror is delivered only if it carries a **new** wallet. Shared infrastructure is recorded as an observation, never as proof of common ownership.

### 2.6 Score and learning (`score.py`, `adaptive.py`)
`p = sigmoid(bias + Σ group weights × evidence + learned + strategy prior + cluster prior)`. The **delivery decision uses the page's own evidence plus any demotion**. Upward learning only re-orders what already qualifies; the exception is a bounded boost for a strong link to a kit you confirmed. Default bar: 0.62 plus a core signal.

What your decisions change:
* **Strategy budgets:** value per probe = P(delivered | probed) × P(useful | delivered), Thompson-sampled with a 5% floor so no strategy is switched off. The crt.sh query split between strategies is learned from useful candidates per query. CT terms are discounted for staleness.
* **Signal weights:** move only when a signal is skipped *significantly* more (or less) often than candidates overall (binomial test, α = 0.05). One mistaken click changes nothing.
* **Skip reasons matter:** `not a scam` and `not crypto` count fully against the signals and hide the rest of that kit. `duplicate` costs the strategy a little but is not evidence against the signals. `dead / parked` means the site changed or a gate missed.
* **Cluster priors:** siblings of a kit you kept start higher; siblings of one you rejected are suppressed.

The benchmark includes an ablation with your decisions withheld (§ results). Building it caught two real design errors, both fixed and covered by tests: treating every skip as "not a scam", and letting learning *promote* weak pages.

### 2.7 Inbox and Main Platform bridge (`inbox.py`, `platform_bridge.py`, `autopilot.py`)
Standalone, Site Finder has its own inbox (`/`, `python cli.py inbox`), and the autopilot keeps `V2_INBOX_TARGET` candidates waiting. Linked to the platform, each delivered candidate becomes one schema 3.0 batch in the existing durable outbox: investigation, site with `triage.outcome=promoted` (`request_downstream=false` by default), a public_triage evidence record, wallets, discovery path, a one-line finding, and the `inbox` passthrough block. Decisions come back through `GET /api/v1/inbox/decisions`. `DISCOVER_SITES` runs a round; `FIND_RELATED_SITES` runs a round seeded with the confirmed site.

## 3. Main Platform v2

* **Inbox (`/`)**: domain, one line of why, OPEN SITE / SKIP / USEFUL (keys O / S / U), optional skip reason. Details stay collapsed behind **Details**: score components, evidence, discovery route, registration age, hidden related sites, public deposit addresses, jobs and the raw record. "In progress" lists sites you kept and how far evidence collection has got.
* **Coordinator (`lib/inbox.ts`)**:
  * **Second-line dedup:** by registrable domain, by cluster (mirrors without a new wallet are attached, not shown), related-to-a-skipped-site, and already-has-evidence-from-another-module. A score floor applies.
  * **Leasing** so two tabs never show the same site.
  * **USEFUL** publishes a platform-originated `site.triaged` (promoted, `request_downstream=true`), so the existing planner routes `INVESTIGATE_SITE` with its usual budget, capability, freshness and approval rules, and queues `FIND_RELATED_SITES`. When you open the site and WalletLogger records wallets, they join the same investigation (the adapter now matches `www.` hosts), and the existing orchestration continues automatically: wallet capture, wallet analysis, review, report preparation.
  * **SKIP** publishes a non-routing `dismissed` triage, cancels jobs for that site that haven't started, and hides waiting siblings.
  * **Supply:** when fewer than `target_depth` candidates are waiting, it queues one `DISCOVER_SITES` job, capped per day. This runs on the Worker cron, on every NEXT and decision, and from `local_scheduler.py`.
* **Migration `0008_inbox_v2`** is additive. The startup schema gate checks for it. The v6 overview moved to `/overview`; everything else sits under **Advanced**.

## 4. Scope and safety

Discovery and probing are passive and public: DNS, crt.sh, RDAP, and unauthenticated GETs of public pages and their public assets. Nothing logs in, submits forms, handles CAPTCHA or MFA, or performs financial actions. Every job carries the existing automation policy, and Site Finder refuses anything outside it. Scores, clusters and shared infrastructure are labelled as software-derived observations that justify a manual look, never as proof of fraud or common ownership. CryptoWalletLogger, Wallet Investigator, Site Investigator and Form Submitter are byte-identical to v6.1. The Launcher is not in the bundle and was not touched.

## 5. Testing

| Suite | Result |
| --- | --- |
| Site Finder (v0.7 suite + v2) | 450 passed (421 existing + 29 v2) |
| Platform unit tests (`npm test`) | 17 passed |
| Platform integration (`test:integration:v6`) and migration matrix (now including 0008) | all passed |
| **New:** `tests/v2-inbox.mjs`: real Site Finder v2 batches → ingest → inbox → NEXT / USEFUL / SKIP → routed jobs → decision feed → WalletLogger joins → supply; URL sanitisation | passed |
| **New:** v1 wire-bug verification with the *original* v0.7 code against the platform ingest route | bugs 9 and 10 reproduced; fixed paths verified |
| Benchmark v1 vs v2, 3 splits × 5 seeds × 6 rounds, with ablation and cost accounting | see `V2_BENCHMARK_REPORT.md` |
| UI | both inboxes rendered in Chromium (desktop, mobile, light and dark for Site Finder) |

**Not run in this environment**, because the sandbox has no access to the npm or PyPI registries: `npm ci`, `next build`, `tsc` against real type packages, ESLint, the joined five-module test (needs Wallet Investigator's `sql.js`), and live-network discovery. Platform tests ran with esbuild and a small test-only zod shim; new TypeScript was type-checked in strict mode against minimal stubs. Please run `npm ci && npx tsc --noEmit && npm run lint && npm run build` before deploying.

## 6. Known limitations

* The benchmark world is synthetic, and I built both it and v2. The held-out and stress splits reduce, but do not remove, the risk that v2 fits my model of the world rather than the real one. Expect live precision to be lower. The live A/B script and the inbox's own running precision (`GET /api/v1/inbox`) are the real measure.
* Recall is bounded by the budget and by what passive sources reveal. "Stealth" scams that show almost nothing before login are mostly missed (by v1 as well).
* In the simulation, withholding your decisions does not change precision: the gates and evidence rules already carry it. The learning loop's value on live data will show up as budget shifting toward the strategies and terms that produce what you keep.
* Clustering on an uncommon favicon can merge unrelated scams that happen to use the same stock icon. That affects recall (a hidden sibling), not precision, and hidden siblings are listed under Details.
* v2 finds candidates from public pages only. Pig-butchering apps that expose nothing publicly are found only through their public bundle, certificates, names and feeds.
