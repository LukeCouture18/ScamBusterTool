# Release report: Site Finder next generation + unified investigation suite

This release builds on the merged Main Platform (Site Finder operational RC plus Operation Hunter
v2.0 integration, see `MERGE_REPORT.md`). Launcher paths are unchanged: `sdk/contracts/v6.json`,
`integrations/` and `scripts/start-production.mjs` are at the root, and Operation Hunter is still a
sibling folder.

Most of the work went into Site Finder's discovery intelligence. The next largest piece is one
simplified operator experience across the five tools. The other tools got small, conservative
upgrades, and no stable backend was rewritten.

## 1. What the operator sees

Main is the one front door. Its sidebar lists exactly five tools:

| Tool | Route | What it answers by default |
|---|---|---|
| **Site Finder** | `/finder` | Which new sites deserve a look, and why (in plain words). The *Investigate* tab shows everything the suite knows about one site: what was found, evidence labelled *Seen on the site*, *On-chain record* or *Software analysis*, wallets and which tools saw them, the operation it may belong to, and what to do next. |
| **Wallet Investigator** | `/wallets` | Where the money went, in words ("recorded 4 transactions: 3 incoming and 1 outgoing…"), which sites show the wallet, its counterparties (on-chain links, not identities) and its role in an operation. |
| **Wallet Logger** | `/logger` | The wallets you captured while browsing, grouped by site. The logger stays passive: it never navigates, clicks or submits. |
| **Form Submitter** | `/reports` | Which investigations can become a report, readiness checks, approval, and where each submission is ("Submitted and confirmed"). |
| **Operation Hunter** | `/hunter` | A briefing on the operation behind a site: the headline, best leads, the living model and the member evidence. Membership is always labelled as analysis. |

Two items sit below the tools. **Needs you** holds the human tasks. **Advanced** holds all of Main's
coordination views (the old home page is now `/operations`, plus campaigns, investigations,
discovery, intelligence, queues, the scheduler and integration status). Nothing was removed, only
moved out of the primary navigation.

**Progressive disclosure.** Scores, raw records, jobs and JSON are behind *Why?*, *Details* or
*Show N more*. Evidence titles are translated into plain words. For example, "Site Investigator:
wallet_display" with a JSON body now reads "Wallet address shown on the page / Address 0x…".

**Investigation context.** The site, wallet and operation you pick appear as chips in the top bar.
They are carried in the URL, remembered for the browser tab, and survive a reload. Moving from a
site to *Follow the money* to *Open in Operation Hunter* to a member site keeps the whole trail
without copying any IDs. Each chip can be cleared.

**Site Investigator folded into Site Finder.** Investigation is now Site Finder's *Investigate* mode.
The Site Investigator module keeps running unchanged underneath as the investigation engine, under
the same module key, job types, contract and data. Its own page is retitled "Site Finder ·
Investigation", and its evidence is labelled "Site Finder · investigation".

**One visual language.** `sdk/ui/suite.css` is the canonical set of tokens and components (the Main
dark navy palette). `node scripts/sync-ui-tokens.mjs` writes a generated block into every tool's
own screens: the Site Finder review page, the investigation page, the Wallet Logger extension, the
Wallet Investigator and Form Submitter apps (as a Tailwind v4 `@theme` palette override), and
Operation Hunter. `tests/ui-tokens.test.mjs` fails if any copy drifts. Only colours change. Class
names, ids and layouts are untouched, so the tools' own browser tests still pass. The React apps
pick up the palette on their next `npm run dev` or `npm run build`.

**Phones.** Under 900 px the sidebar becomes a strip of tools, the top bar wraps, and every grid
collapses to one column. At 390 px, none of the seven main views scrolls sideways (this is tested).

## 2. Site Finder next generation (engine 2.1)

Full description: `integrations/site-finder-v07/docs/NEXT-GENERATION.md`.

The goal was more *new* useful investigations per unit of discovery effort, without adding sources
for their own sake. The new layer (`app/v2/ng/`) does six things:

- **Pivots from what Site Finder already knows.** It follows the operator's own build files (shared
  libraries are excluded), page titles, icons, servers, certificate names, private name servers and
  name patterns. Pivoting starts from eligible sites before you have reviewed them, and from your
  useful sites and from seeds requested by Main or Hunter.
- **Plans by value of information.** It learns the yield of each route (Beta posteriors, with
  Thompson sampling for exploration). Routes below a value floor are not run. Empty indicators are
  cooled down and then retired. Generic result sets are never followed. Certificate searches run
  only when they beat the ambient rate.
- **Keeps persistent discovery memory.** It records every indicator, the lineage of every lead
  (route, parent, depth), route statistics, seeds, watches and the sites held elsewhere, in additive
  tables at schema v5.
- **Protects novelty.** Sites Main or Operation Hunter already hold never take a review slot. Neither
  do near-duplicates that add no new wallet (SimHash) or mirrors within a batch. The reasons are
  stated as similarities, never as common ownership.
- **Watches for reappearance.** Useful sites are re-resolved periodically. A new site that shares the
  build or title of a site that went dark is flagged as a possible reappearance.
- **Uses feedback and gaps.** Your decisions and Main's downstream outcomes credit the route that
  produced a site. Operation Hunter's evidence gaps ("find more like these") become Main work items
  (`find_related_sites`, budgeted as `discovery_requests`). Main dispatches them as Site Finder jobs,
  and Site Finder treats them as priority seeds. Main's `GET /api/v1/finder/context` tells Site
  Finder which sites are already held.

Switch the layer off with `SITE_FINDER_NG=0`. You can drop its tables with
`memory.rollback(confirm=True)`. Its status is at `GET /api/v2/discovery/next-generation`, linked
from Site Finder's Advanced panel.

### Benchmark: identical difficult worlds, seeds and budgets

The benchmark is `python -m benchmark.ng_ab --seeds 1 2 3 4 5 6 --rounds 8 --compare <previous
tree>`. It uses six synthetic hard worlds (`benchmark/hard_world.py`). Those worlds contain
operations invisible to certificate search, CDN-fronted sites, successor sites after takedowns,
vendor demo sites, shared libraries, sites Main already holds, and Hunter gap requests. The budget
per round is the same for every variant: fetch 60, DNS 220, crt.sh 6, RDAP 30, with 5 review slots.
The variants are:

- **previous**: the merged RC engine, run from its own tree.
- **next**: this release.
- **next, no page search**: an ablation of this release.

**Difficulty 0.7**

| Metric | previous | next | next, no page search |
|---|---:|---:|---:|
| Useful in the first 3 slots per round (total) | 82 | **139** | 139 |
| New useful sites reviewed | 130 | **223** | 221 |
| Share of review slots that were new and useful | 0.544 | **0.987** | 0.978 |
| Distinct useful operations reviewed | 106 | 184 | **200** |
| Hidden (not findable by certificate search) useful | 37 | **54** | 39 |
| Found by multi-hop pivots | 0 | 28 | 34 |
| Gap-request discoveries | 31 | **35** | 30 |
| Successor sites found | 2 | **5** | 3 |
| New wallets | 222 | **375** | 365 |
| Slots spent on sites Main already held | 104 | **0** | 0 |
| Mirror / duplicate slots | 3 / 0 | 0 / 0 | 0 / 0 |
| Useful new sites found in total (reviewed or waiting) | 166 | **356** | 256 |
| … of which hidden | 73 | **179** | 80 |
| Requests (all sources) | 18,359 | 19,415 | 18,687 |
| Requests per new useful reviewed | 141.2 | 87.1 | **84.6** |
| Requests per useful found | 110.6 | **54.5** | 73.0 |
| Search queries (wasted share) | 396 (0.48) | 970 (0.67) | 572 (0.58) |
| False cross-operation relationships | 0 | 0 | 0 |

**Difficulty 0.9**

| Metric | previous | next | next, no page search |
|---|---:|---:|---:|
| New useful sites reviewed | 101 | **212** | 205 |
| Share of review slots new and useful | 0.437 | **0.972** | 0.972 |
| Hidden useful reviewed | 21 | **58** | 31 |
| Multi-hop | 0 | **53** | 43 |
| Successors found | 3 | **12** | 6 |
| Slots spent on sites Main already held | 122 | **0** | 0 |
| Useful new found in total (hidden) | 135 (60) | **309 (183)** | 192 (65) |
| Requests per useful found | 136.8 | **61.7** | 96.4 |
| Mean requests to the first hidden useful | 1,143 | **874** | 1,058 |
| False relationships | 0 | 0 | 0 |

**Certificate transparency exhausted** (crt.sh down from round 2, no passive DNS, difficulty 0.7)

| Metric | previous | next | next, no page search |
|---|---:|---:|---:|
| New useful sites reviewed | 99 | **164** | 125 |
| Hidden useful reviewed | 13 | **59** | 16 |
| Gap-request discoveries | 13 | **47** | 16 |
| Successors found | 2 | **7** | 3 |
| Useful new found in total (hidden) | 62 (18) | **196 (149)** | 60 (18) |
| Requests per useful found | 259.2 | **86.7** | 262.1 |
| Worlds with a hidden useful site | 4/6 | **6/6** | 6/6 |
| False relationships | 0 | 0 | 0 |

**How to read these tables**

- Much of the reviewed-slot gain comes from not showing sites Main already holds. The previous
  engine spent 104 to 129 of about 230 slots on them. That gain depends on the new Main context
  feed. Discovery itself also improves through pivots: the pool of useful sites found about
  doubles, and the pool of hidden sites grows about 2.5×.
- The ablation shows the split. Without page search, the pivots from certificates, name servers
  and name patterns still carry the normal worlds. When certificate search is down, only page
  search keeps finding hidden sites (149 vs 18).
- **Cost.** This release makes about 2.4× as many (cheap) search queries. Two thirds of them
  return nothing new, which the planner learns from. Total requests rise by about 3 to 6 %.
  Simulated wall time per 8-round world rises from about 12 s to about 15 s.
- **Database cost of the RC round is kept.** One deterministic round is 41 connections before and
  after. Statements go from 7,468 to 7,708 (+3 %) and commits from 2,386 to 2,562, for the new
  memory tables (`benchmark/operational_profile.py`).
- **The worlds are synthetic, and I wrote them.** They were designed to contain the hard cases the
  brief names, so they favour an engine built for those cases. They are evidence that the
  mechanisms work as intended, not a forecast of real-world yield. The live page-search endpoint
  (urlscan.io by default) was not reachable from the build environment.

**One real defect the benchmark caught.** At difficulty 0.9 the first run showed 3 false
cross-operation links in the campaign graph. The RC graph treated one shared support-chat backend
("kefu" host) as enough to link two sites. Third-party support desks are sold to unrelated
operators, so a single shared service now needs a second, independent category. A shared wallet
still links on its own. After the fix, false links are 0 in all three scenarios. Regression test:
`test_one_shared_support_service_alone_is_not_a_relationship`.

## 3. Cross-tool workflow and small upgrades

**The whole flow runs through Main's own work items.** The flow is: site → Useful →
site investigation → wallets → Wallet Logger capture → wallet analysis → Hunter reconstruction →
related-site discovery → report → approval → submission. Actions in the tools (`POST
/api/v1/suite/actions`: review, investigate, find related, reconstruct, analyse wallet, prepare
report) become inbox decisions, work items, reconstruction requests or report candidates. They run
under the existing scheduler, budgets, approvals and deduplication. Asking twice does not duplicate
work. Main stays the authority for coordination and durable state. The read models are in
`GET /api/v1/suite/{home|finder|site|wallets|wallet|logger|reports|hunter}`, in `lib/suite.ts`.

**Operation Hunter**
- Hunter's proposals now include evidence-gap requests (`find_related`), sent when an operation is
  rotating, a wave is due, or it has fewer than three members. Main turns them into budgeted Site
  Finder jobs.
- Hunter's briefing in Main leads with the headline, then best leads, the model and the evidence.

**Wallet Investigator**
- Money flow is explained in words.
- The wallet view links back to the sites that show the wallet and to its operation role.
- Case-sensitive addresses (TRON) are shown as reported, not lower-cased.

**Wallet Logger**
- Captures are visible and reviewable in Main by site and by wallet, with *Follow* links into the
  wallet view.
- It stays passive.

**Form Submitter**
- Readiness checks: at least two evidence items, something seen directly, a wallet, more than one
  tool, and your approval.
- Approve or reject from the tool.
- Submission status in words.
- Nothing is filed before approval, as before.

## 4. Problems found and fixed along the way

| Problem | Effect | Fix |
|---|---|---|
| Wallet keys that already named their network (`tron:T…`, as Site Finder sends them) were stored as `tron:tron:t…`. | The same wallet reported by Site Finder and by the investigation or Wallet Logger became two entities, so cross-tool dedupe failed for those wallets. | `lib/domain.mjs` never prefixes twice. Migration `0013_wallet_key_prefix.sql` (additive, idempotent) renames stored keys where no correctly-keyed twin exists. Rows that already have a twin are left untouched: nothing is merged or deleted. Tests: `domain.test.mjs`, `wallet-key-migration.test.mjs`. |
| One shared support service linked unrelated operations. | False campaign edges. | See section 2. |
| Raw JSON and module-internal titles in the evidence list. | Unreadable by default. | Plain wording, observed evidence first, extras behind *Show N more*. |
| Inline two-column grids on the Wallet and Hunter pages. | Sideways scrolling on phones. | Responsive grid classes. |
| The Wallet Investigator worker needs `sql.js`, which could not be installed here. | The five-module and Wallet Investigator suites could not run in a sandbox. | `tests/lib/sqljs-fallback.mjs` resolves `sql.js` to a node:sqlite stand-in only when the real package is missing. With `npm install` done, the real package is used. This made the real Wallet Investigator worker, and its 31-test suite, runnable here. |
| The "new operation" wording overstated. | It read as a claim. | Now "…so it may belong to an operation you have not seen yet". |

## 5. Tests

`node scripts/run-tests.mjs all` runs every group. There is a new `suite` group, and
`tests/*.test.mjs` gained `ui-tokens` and `wallet-key-migration`. Results in this environment are
below. Operation Hunter is found as the sibling folder.

| Group | Result |
|---|---|
| unit (all `tests/*.test.mjs`) | PASS (30) |
| migration-matrix | PASS (10) |
| **suite**: whole operator workflow plus browser walk of the five tools (34 UI checks) | PASS |
| integration:v6, v2, v3, v4, v5 | PASS |
| joined:hunter (Site Finder → Main → Operation Hunter, upgrade in place 0011 → 0013) | PASS |
| joined:v61 (five modules, golden path and failure/recovery path) | PASS |
| five-modules (includes the Wallet Investigator's own 31 tests) | PASS |
| site-finder (full suite) | PASS (530) |
| Operation Hunter's own suite (in its folder) | PASS (45) |
| startup:modules | 1 of 4 passes here. See the note below. |

**The `suite` gate.** Site Finder's real next-generation engine delivers sites. You mark one Useful
through the suite API. Main routes the investigation, and the real investigation exporter delivers
evidence and a wallet. The real Wallet Logger sync captures the same wallet. The real Wallet
Investigator worker analyses it. A Hunter-shaped snapshot adds the operation and a gap request,
which Main dispatches as a Site Finder job. You prepare and approve a report, and the real Form
Submitter worker files it and records the confirmation.

Then Chromium walks Home, Site Finder (queue, Why, In progress, How it searches, Investigate), the
wallet, Wallet Logger, Form Submitter, Operation Hunter, a Hunter member back into Site Finder,
clearing context, and Advanced. It checks the context chips, reload persistence, evidence labels,
no raw JSON by default, phone width, and that the browser logs no errors. It passed three runs in a
row.

**`startup:modules`** starts each module's real server. Three of them need npm or pip packages the
build environment could not download: FastAPI for the investigation engine, Express for Form
Submitter, and `sql.js` for the Wallet Investigator server. The same three fail identically on the
unmodified baseline. Site Finder's startup check passes.

**Two intermittent Site Finder failures fixed.**
`test_operations_api_status_create_and_control` resumed a run, which started a real discovery round
in a background thread. That thread outlived the test and raced the tests after it, which is why
`test_provider_failure_fallback_recovery_and_half_open_lease` sometimes saw the wrong provider
state. The test now records the worker start instead, and asserts that the start was requested.
Both tests pass in the full suite.

## 6. Upgrading an existing installation

1. Replace the Main folder with this one (same layout). Keep your `.env` and module keys.
2. Apply the migrations: `wrangler d1 migrations apply DB`, or let `scripts/start-production.mjs`
   do it. The only new Main migration is `0013_wallet_key_prefix.sql`, which is additive.
3. Site Finder upgrades its own SQLite on start (new `ng_*` tables, schema v5). No existing rows
   change.
4. Restart the modules. Wallet Investigator, Form Submitter and Operation Hunter pick up the new
   palette at their next build.
5. Optional: set `URLSCAN_API_KEY` for higher page-search limits. `SITE_FINDER_NG=0` returns Site
   Finder to 2.0 behaviour.

Before the upgrade, back up the D1 database and Site Finder's `data/` folder, as for any release.

## 7. Safety boundaries (unchanged)

Discovery and investigation stay public and passive. There are no credential attacks or guessing,
no CAPTCHA, MFA or email-verification bypass, no exploitation, no destructive activity, no
private-key handling and no transactions. Wallet Logger records only what you browse yourself.
Existing user-authorized login workflows remain as they were, with manual steps for CAPTCHA, MFA
and email verification.

Observations, software analysis, external metadata and analyst conclusions are labelled separately
on every screen. Shared hosting, CDNs, templates, kits, support desks and transactions are shown as
similarities, never as proof of common ownership.

## 8. Known limitations

- The Next.js production build could not run here: npm registry access was blocked, and
  `node_modules` lacks Next and React types. The UI was verified by bundling the real client
  components with esbuild and small stand-ins for `next/link`, `next/navigation` and the icon
  package, then driving them in Chromium against the real route handlers.
- The TypeScript check of the new and changed server code shows 10 errors. The unmodified
  baseline shows the same 10, so none are new. The new TSX components were not type-checked, because React types were missing.
- The Tailwind palette overrides in the Wallet Investigator, Form Submitter and Hunter apps are
  generated and tested for drift, but were not compiled here.
- The Hunter step of the `suite` gate posts a snapshot in Hunter's wire shape. Hunter's real engine
  against Main is covered by `joined:hunter`.
- The benchmark worlds are synthetic (see section 2).
