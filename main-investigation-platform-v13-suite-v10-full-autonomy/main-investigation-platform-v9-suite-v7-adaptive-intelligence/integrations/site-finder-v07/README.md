# ScamHunter / Site Finder v2

> **Site Finder v3 (3.0) · discovery pursuit & campaign hunting.** One clue starts a *hunt*: Site Finder follows the
> most informative public artifacts (build files, API and chat hosts, analytics IDs, titles, icons,
> servers) several pivots deep, drops dead branches with a reason, and stops when a hunt runs dry.
> Main and Operation Hunter can ask it to hunt for more sites like an operation; investigations feed
> their artifacts back as bounded hunts. Every candidate says *why* it was found, as a readable chain.
> Same kit never means same operator. On an independent adversarial benchmark it finds ~2.5× the
> new useful sites of 2.1 at higher precision, for about a third more requests.
> See `docs/PURSUIT.md` and `../../SITE_FINDER_V3_RELEASE_REPORT.md`; switch off with `SITE_FINDER_PURSUIT=0`.

> **2.1 · next-generation discovery.** Site Finder now pivots from what it already knows (the
> operator's own build files, page titles, icons, servers, certificates, private name servers),
> remembers what every search produced, retires routes that have gone dry, and skips sites Main or
> Operation Hunter already hold. On identical hard synthetic worlds it brings about 1.7× as many new
> useful sites for the same review effort. Investigation of a site you pick now happens from Site Finder
> in Main (the former Site Investigator runs underneath as its investigation engine).
> See `docs/NEXT-GENERATION.md`; switch off with `SITE_FINDER_NG=0`.

**v2 has one goal: raise the share of surfaced sites that are actually worth your
time.** It still discovers widely in the background, but only a few strong
candidates reach you, one at a time, in an inbox: NEXT SITE → OPEN SITE → SKIP / USEFUL.

What changed from v0.7 (details in `docs/V2-IMPLEMENTATION-REPORT.md`):

* **Hard gates before anything is shown.** Dead, parked, for-sale, server-default,
  suspended, coming-soon, redirect-to-the-real-brand, news/review/forum and
  non-crypto pages are filtered out with a recorded reason. Crypto-named parked and
  coming-soon domains are rechecked later, because that is where new scams appear.
* **Context-aware evidence.** Delivery needs a *core* signal: a fixed daily return,
  a pay-to-withdraw trap, a checksum-valid address shown as a place to send money,
  a recovery-phrase form, a brand login page on a look-alike domain, a login-gated
  trading-app kit (read from its public JS bundle), or a fund-recovery pitch.
  Words like "deposit", "withdraw" and "Telegram" no longer count on their own.
* **One candidate per registration and per kit.** Hostnames collapse to registrable
  domains (mail./cpanel./www. are sightings, not sites). Clones sharing a deposit
  address, certificate, chat backend or uncommon favicon are one cluster. You see
  one, plus "N related sites", and a mirror is only shown if it carries a new wallet.
* **Adaptive discovery.** Eight passive strategies (CT term rotation, CT searches for
  stems learned from sites you kept, certificate siblings, name-pattern siblings,
  brand look-alikes, public feeds, domains named on review/monitor pages, and
  change-detection rechecks). Budget (HTTP, DNS, crt.sh, RDAP) follows your decisions.
* **Learning from USEFUL / SKIP.** Decisions update strategy budgets, signal weights
  and cluster priors. The skip reason matters: a duplicate is not evidence against
  the signals. Learning can demote freely but promote only slightly, and delivery is
  decided on the page's own evidence.

Quick start:

    python cli.py serve        # UI at http://127.0.0.1:5000 — inbox at /, the full v0.7 dashboard at /advanced
                               # (the v2 autopilot starts with the server; V2_AUTOSTART=0 to disable)
    python cli.py round        # one discovery round now
    python cli.py inbox        # work the inbox in the terminal
    python cli.py benchmark    # v1 vs v2 on the simulated internet (benchmark/run.py)
    python -m benchmark.live_ab run   # blind v1-vs-v2 comparison on the live internet, judged by you

When linked to the Main Platform (MAIN_PLATFORM_URL + MAIN_PLATFORM_TOKEN), your
inbox lives in the Main Platform and decisions flow back automatically. Rounds then
run when the platform asks for more candidates (DISCOVER_SITES). `FINDER_V2=0`
restores the v0.7 behaviour; the v0.7 scan loop, dashboard, campaigns and APIs are
all still present.

---

# ScamHunter

A research tool for finding, investigating, and documenting cryptocurrency
scam websites — built for reporting to projects like ScamBusters, blockchain
analytics services, or law enforcement.

## What it does

1. **Discover**: continuously finds new candidate scam sites from public sources
   instead of relying on you to manually supply URLs — certificate transparency
   logs, typosquat/permutation domain generation, shared-infrastructure matching,
   page-template fingerprinting, and reused contact-info correlation, each
   combined and cross-checked against the others. See "Automatic Discovery"
   below for the full detail.
2. **Collect**: also pulls candidate URLs from public scam-report feeds you
   configure, or from a manual list you import, alongside discovery.
3. **Rank**: scores every candidate with cheap heuristics (scam-language keywords,
   suspicious TLDs, wallet addresses on the homepage, discovery confidence, etc.)
   so the worst offenders get investigated first — this scales to thousands of
   candidates because scoring only needs one lightweight HTTP GET per site.
   Optionally also factors in domain age via WHOIS (brand-new domains score
   higher) if `python-whois` is installed; degrades gracefully to skipping that
   signal if it's not.
4. **Investigate**: after ranking, sites at or above your configured risk threshold
   are automatically queued for investigation in a real (headless-capable) isolated
   browser session per site. The investigator understands each page (is this a
   deposit/wallet/funding/investment/trading page? a login or signup page? an
   access-control wall?), follows relevant internal links (optionally asking Claude
   to pick the most promising ones), extracts wallet addresses with context-based
   confidence scoring and network identification, and saves a screenshot + surrounding
   text as dedicated evidence for every wallet found — not just a page-level screenshot.
   An optional **deep wallet hunt mode** makes this more thorough still: bigger
   crawl budgets, clicking through currency/network tabs to reveal addresses
   hidden behind a tab switch, and continuing into the account area after a
   signup that succeeds cleanly. It stops immediately, without attempting to
   bypass anything, the moment it hits a CAPTCHA, KYC/identity check, phone
   verification, or payment requirement — deep wallet hunt mode never changes
   that. See "Automatic Investigation" and "Deep Wallet Hunt Mode" below for
   the full detail.
5. **Review**: a live, full-featured web dashboard (no terminal needed) lists
   draft findings for you to approve or reject, with full evidence (screenshots,
   wallets, page types, and the investigator's own decision log explaining why it
   navigated where it did) shown inline, updating in real time as scans run.
6. **Report**: once you approve a finding, the tool can open the ScamBusters Google
   Form and fill in what it can (site URL, wallet addresses/types) — but it **never
   clicks Submit**. It reports honestly, step by step, which fields it confirmed
   filling vs. couldn't find (with a screenshot after every step), rather than
   assuming success — Google Forms' later wallet-entry pages only render after
   a branching answer on page 1, so their exact structure can vary. You always
   review the filled form yourself and submit it by hand.

## Quality Over Quantity

The pipeline is built around one idea: **search very wide, report very narrow.**
Returning hundreds of sites that merely contain a suspicious keyword is noise.
The goal is a handful of sites you can actually act on, each with enough
evidence attached to justify a report.

```
Mass discovery  ->  Fast triage  ->  Risk scoring  ->  Deep analysis
                ->  Wallet validation  ->  High-confidence results
```

Each stage is cheaper per site and much wider than the next, so expensive work
only ever lands on candidates that already proved themselves:

| Stage | Scope | Cost per site |
|---|---|---|
| Discovery | thousands of domains | ~free (DNS / CT logs) |
| Fast triage | hundreds–thousands | one small HTTP GET |
| Deep analysis | tens | full browser session + enrichment |
| Results | a handful | — |

### The quality gate

Triage (`app/analysis/triage.py`) is what makes this work. A site passes only
if it trips **multiple independent indicator categories** — not if it repeats
one keyword many times. The categories are deliberately different *kinds* of
evidence, so several firing together is far stronger than any one firing loudly:

`wallet_address` · `deposit_language` · `guarantee_language` ·
`investment_scheme` · `offchain_contact` · `suspicious_tld` ·
`brand_impersonation` · `urgency_pressure` · `fake_trust_signals`

A page saying "investment" two hundred times scores **zero categories**. A page
with a wallet address, a deposit flow, guaranteed-return claims, a tiered VIP
scheme and Telegram-only support scores **five** and gets the full treatment.
Tune it with `TRIAGE_MIN_INDICATOR_CATEGORIES` in `config.py` — raise it for
fewer, stronger results; lower it for more, weaker ones.

Every rejection records *why*, so a filtered-out site is never a black box.

### What a result contains

Each site clearing the gate gets a full profile: domain and URL, risk score,
why it was flagged, title and description, important page text, categorised
keywords, deposit/withdrawal pages, wallet addresses with network and
**checksum validation status**, on-chain activity where publicly available,
related domains, shared infrastructure, template matches, domain age and
registration data, contact information, social links, threat-intelligence
matches, discovery source, screenshots, a confidence score, and a written
evidence summary.

### Confidence scoring

Confidence compounds across **independent** evidence types, so a high score
genuinely means several unrelated things agree:

| Evidence | Confidence |
|---|---|
| Keyword matches only | 0% |
| A wallet address, nothing else | 30% |
| Wallet + deposit page | 45% |
| + multiple triage categories + off-platform contact | 65% |
| + on-chain activity | 77% |
| + recently registered domain | 85% |
| + shared infrastructure + threat-intel hit | 100% |

Only profiles at or above `HIGH_CONFIDENCE_THRESHOLD` (default 70%) are
surfaced as results. Everything else stays in the database but isn't presented
as a finished finding.

### Wallet validation

Addresses are checksum-validated offline before anything is reported —
base58check for BTC/TRON/LTC/DOGE/DASH, bech32/bech32m for segwit, and format
validation for EVM chains. This is verified in the tests against the Bitcoin
genesis address and the BIP-173 reference vector, and a single altered
character is caught. **An address that fails validation can never be
submitted**, because reporting a bogus address is worse than reporting nothing.

On-chain activity (balance, transaction count) is looked up from free public
explorers when reachable. Failures degrade to "activity unavailable" with the
reason recorded — they never invalidate an address.

## Report Submission

Enter your **username** and **team invite code** once in Settings → Report
Submission. They're stored locally in the tool's own database and reused
automatically for every future submission. The team code is never echoed back
in full — only masked.

Three modes:

- **Manual** — the tool validates and shows you the values; you open and fill
  the form yourself.
- **Review Before Submit** — the tool validates, opens the form, prefills
  everything it can, and hands it to you with a per-field report.
- **Automatic** — the tool validates and prefills so confirming takes one click.

### Every mode ends with your click

The tool does all the work up to the Submit button and then stops. Filing a
report is a real-world action against a real project, and an automated system
that files reports unattended can file wrong ones at scale — so a person always
confirms. "Automatic" means the *preparation and validation* are automatic, not
the submission.

### The validation gate

Before any submission is prepared, all of these must pass:

- the site exists and has a completed deep-analysis profile
- confidence meets `SUBMISSION_MIN_CONFIDENCE` (default 70%)
- at least one wallet passes checksum validation
- that wallet's network is one the form actually accepts
- username, team code and site URL are all present
- the site has not already been submitted
- the wallet has not already been submitted (even from a different site)

If a wallet with demonstrated on-chain activity is available, that one is
chosen — it's the strongest evidence to hand over. Blocked submissions are
recorded with their failed checks, so there's an audit trail of what was
attempted and why it didn't go.

## Automatic Discovery

The discovery engine (`app/discovery/`) continuously finds new candidate sites
from public, passive sources — no manual URL list required, though you can
still add one. It's modular: each source is a small, independent Python class,
so adding a new one later means writing a class and registering it in
`app/discovery/engine.py`, nothing else needs to change.

**Sources, targeting the categories requested:**
- **Certificate Transparency** (`certificate_transparency.py`) — searches
  crt.sh (a free, public, no-API-key log of every TLS certificate ever issued)
  for domains matching scam-category keyword fragments (investment platforms,
  trading platforms, fake exchanges, fake wallets, cloud mining, USDT deposit
  schemes, pig-butchering language patterns), with confidence weighted by how
  recently the certificate was issued — directly targeting "recently created
  suspicious crypto sites."
- **Similar domains** (`similar_domains.py`) — generates typosquat/permutation
  variants (character omission, doubling, adjacent-key substitution,
  transposition, and scam-favorite affixes like "-support"/"-official") of
  either a known scam domain or a well-known crypto brand name, and checks
  which variants actually resolve in DNS. A resolving variant of a real word
  is strong evidence someone registered it on purpose — this is how brand
  impersonation and copycat sites get found even before any content is known.
- **Shared infrastructure** (`shared_infrastructure.py`) — fingerprints known
  scam sites by resolved IP (and nameservers, if `dnspython` is installed) and
  checks whether new candidates from any other source share that
  infrastructure — a strong "same operator" signal, using only standard DNS
  lookups (no paid reverse-IP API needed).
- **Template similarity** (`template_similarity.py`) — fingerprints the HTML
  *structure* (not text) of pages already investigated, using shingled tag
  sequences, to find sites built from the same scam template/builder even when
  the branding and copy are completely different. Runs entirely on HTML
  already saved locally — no new network requests to anyone.
- **Contact-info reuse** (`contact_reuse.py`) — extracts Telegram handles,
  WhatsApp numbers, emails, and phone numbers from investigated pages and
  finds sites sharing them, since scam operations frequently reuse the same
  "customer service" contact across many throwaway domains.

**Combining sources**: the engine doesn't just run sources independently — a
typosquat candidate that *also* turns out to share hosting infrastructure with
a known scam gets its confidence boosted and the corroboration recorded, and
template/contact matches between already-known sites get logged even though
they don't produce a new URL, since they're useful context for a reviewer.

**Deduplication and memory**: every candidate any source ever surfaces is
permanently logged to a `discovery_events` audit trail — "exactly why and
where it was found" — whether or not it became a new site, so a source never
re-suggests the same already-known domain as if it were new. Sites themselves
dedupe by domain (see the dedup section below); a site can be independently
flagged by multiple sources, and every one of those events stays on record.

**Confidence and prioritization**: each discovered site gets a
`discovery_confidence` (0.0–1.0) and a plain-language `discovery_reason`,
visible on every site's detail view. That confidence feeds into ranking (see
`app/ranker.py`), so strongly-flagged discoveries — a brand-new certificate
for a keyword-matching domain, a typosquat that also shares infrastructure
with a known scam — get prioritized ahead of weak or generic candidates,
rather than the scanner spending most of its time on low-signal sites.

**Passivity and rate limits**: every discovery source makes only standard,
public, unauthenticated reads — DNS lookups, a public certificate-log search,
or correlating data already saved locally. Nothing here bypasses any
protection, solves any challenge, or authenticates as anyone. Each source
self-limits its request volume (see `CRT_SH_MAX_QUERIES_PER_RUN`,
`SIMILAR_DOMAIN_MAX_DNS_CHECKS_PER_RUN`, etc. in `config.py`), and the engine
adds a courtesy delay between sources on top of that.

**Running discovery**: enabled by default as part of the automatic scan cycle
(Settings → "Run discovery on Start"), or trigger a standalone run any time
from the Discovery view's "Run Discovery Now" button — useful for building up
a backlog of candidates before committing browser time to investigating them.
The Discovery view shows live stats (candidates surfaced, new sites, pivoted
finds, duplicates skipped), a by-source and by-category breakdown, the full
discovery log, and recent run history.

## Automatic Investigation

Once ranking has scored a batch of candidate sites, the scan controller
automatically moves on to investigating them — no need to manually pick sites
one at a time. Each investigation:

- Runs in its own **isolated browser context**: no cookies, storage, or session
  state is shared between sites, and nothing persists after the investigation ends.
- **Only investigates sites at or above the configured risk threshold** (Settings
  → "High-risk score threshold"), so browser time isn't wasted on low-signal sites.
- **Understands each page** before deciding what to do with it: is this a
  deposit/wallet/funding/investment/trading page worth recording as evidence?
  A login page (never enters credentials)? A signup page (only attempts
  registration if you've explicitly enabled it in Settings)? Or an access-control
  wall — CAPTCHA, KYC/identity verification, phone/SMS verification, or a payment
  requirement — in which case **the entire investigation stops immediately**,
  with a screenshot of exactly what stopped it, rather than trying another page
  or attempting to work around it.
- **Extracts wallet addresses** with regex + context-based confidence scoring,
  automatically identifying the network (BTC/ETH/TRON/BNB/MATIC/USDT/USDC/etc.)
  from nearby text, and captures a **dedicated screenshot scrolled to the address
  itself** plus the surrounding text as evidence — separate from the page-level
  screenshot, so a wallet found after scrolling or behind a modal still has
  usable evidence.
- **Avoids loops and repeat visits**: URLs are normalized (trailing slashes, www.,
  fragments, and tracking-parameter noise all treated as the same page) before
  being checked against what's already been visited, and a hard cap on total
  pages guarantees every investigation terminates even against a pathologically
  linked or cyclic site.
- **Handles broken/slow/redirected/unreachable sites cleanly**: timeouts, DNS
  failures, connection refusals, SSL errors, and HTTP error responses are each
  classified and logged specifically rather than crashing the investigation;
  redirects are followed and the investigation continues on the final URL.
- **Records why**: every navigation decision — which link was followed and why,
  which were skipped and why, where and why it stopped — is logged in plain
  language to a decision log visible per-investigation in the dashboard's
  Investigations view, so a reviewer can see the reasoning without re-watching
  a recording.
- **Feeds the review queue automatically**: any site with wallets or interesting
  pages found gets a draft finding created for you to review — no separate step.

The Investigations view in the dashboard shows live status for anything currently
running (with per-page progress) plus a history of recent investigations you can
click into to see the full decision log for each one.

### Deep Wallet Hunt Mode

Turning on **Deep wallet hunt mode** in Settings makes the investigator spend
its whole budget trying to find every wallet address a site has, rather than
doing a balanced survey of the site:

- **Bigger page and link budgets** (`DEEP_WALLET_HUNT_MAX_PAGES` /
  `DEEP_WALLET_HUNT_MAX_LINKS_PER_PAGE` in `config.py`), and link selection is
  scored against a narrower "this specifically leads to a deposit address"
  word list instead of general finance-adjacent terms, so the larger budget
  gets spent productively.
- **Clicks through currency/network tabs**: many deposit pages show one
  address at a time, switched via a tab, pill button, or dropdown (e.g.
  "BTC | ETH | USDT-TRC20 | USDT-ERC20"), sometimes loading the address only
  when that tab is clicked rather than shipping it in the page's initial
  HTML. The investigator finds every element whose label looks like a
  currency/network switch and clicks through each one, re-scanning for
  wallets after every click. This is safety-gated: only short labels matching
  a currency/network name are clicked, and anything that ALSO looks like an
  action — "Buy BTC Now," "Connect ETH Wallet," "Withdraw," "Swap," "Confirm"
  — is excluded even though it names a currency, since clicking those would
  cross into the same forbidden-action territory the rest of the system
  refuses to touch.
- **Continues past a signup that succeeds cleanly**: if account registration
  is also enabled (see below) and the signup attempt reports a clean success —
  meaning it never hit a CAPTCHA, phone verification, or any other wall —
  the investigator keeps going into the resulting account area with its own
  small, separately-budgeted crawl, specifically looking for member-only
  deposit/wallet pages. This never changes when or how signup itself is
  allowed to proceed; it only means a *successful, unblocked* signup isn't
  treated as a dead end.

**This does not change what the tool will or won't do.** It's a more thorough
search using the exact same rules: the entire investigation still stops
immediately at any CAPTCHA, KYC check, phone/SMS verification, or payment
requirement; signup is still never attempted unless you've explicitly enabled
it; nothing is ever clicked that pays, connects a wallet, confirms a
transaction, or otherwise takes an action beyond looking at a page. Deep
wallet hunt mode only means the investigator looks harder and clicks through
more read-only tabs before giving up — never that it bypasses anything it
would otherwise stop at.

Enable it from the dashboard's Settings view ("Deep wallet hunt mode"), or
from the CLI with `--deep-wallet-hunt` on `investigate`, `investigate-parallel`,
or `full` (see Running, below). Combine with `--allow-signup` /
"Allow research account signup" to also get the post-signup continuation.

## Web Dashboard

The dashboard (`python3 cli.py serve`, then open http://127.0.0.1:5000) is a
full control center — no terminal commands needed for day-to-day use:

- **Overview**: live stat cards (sites discovered/scanned, high-risk count,
  wallets found, pending/submitted findings), a recently-scanned sites feed,
  and a live activity log streaming every backend log line as it happens.
- **Discovery**: live stats on candidates surfaced, how many became new sites,
  how many came from pivoting off existing sites, and duplicates skipped; a
  by-source and by-category breakdown; a full discovery log (every candidate
  any source has ever surfaced, with its confidence and reason); recent
  discovery-run history; and a "Run Discovery Now" button to trigger a
  standalone run without starting a full scan.
- **Start / Pause / Stop controls**: sit in the top bar on every screen.
  Pause takes effect at the next safe checkpoint (between pages, typically
  within a second or two — an in-flight page load can't be aborted mid-call).
  Stop finishes the current site, then halts before starting the next one.
  A live progress bar and "currently investigating" box show exactly what
  the browser is doing right now.
- **Sites**: every candidate site, searchable by URL/domain, filterable by
  status, sortable by score/date, with a min-score slider. Click any row for
  full details: risk reasons, wallets found, every page visited with its
  screenshot, dedicated wallet evidence screenshots, how/why it was discovered
  (source, confidence, reason, and any corroborating discovery events), and
  (if investigated) a link to that site's full decision log.
- **Investigations**: live status for anything currently running (current URL,
  pages visited, wallets found so far), plus a history of recent investigations.
  Click any one to see its full decision log — every navigate/skip/stop the
  investigator made, in plain language, including exactly why and where it
  stopped if it hit an access-control wall.
- **High Risk**: sites at or above your configured risk threshold, for a
  fast triage view. This is also the threshold that gates automatic
  investigation — sites below it are left queued rather than investigated.
- **Wallets**: every distinct wallet address found across all sites, with
  network, confidence, and how many different sites it's been seen on
  (a strong signal of an organized scam network).
- **Review Queue**: pending/approved/rejected findings with full evidence —
  summary, wallets, and deposit/wallet/funding/investment/trading page
  screenshots — plus Approve/Reject buttons and the Google Form submission flow.
- **Settings**: batch size, headless mode, whether Start also runs
  discovery/collector/ranker, ranking limits, the high-risk score threshold
  (also gates auto-investigation), whether to allow research-account
  signup on pages the investigator recognizes as genuine signup forms, and
  deep wallet hunt mode (see "Deep Wallet Hunt Mode" above) — persisted in
  the database so they survive a restart.

Everything updates live via Server-Sent Events (a single persistent
connection per browser tab, no polling): when the scanner finds a wallet,
finishes a site, or hits an error, every open dashboard tab sees it within
about a second. No extra services (no Redis, no message broker) — it's
plain Flask, running with `threaded=True` so the SSE connection doesn't
block the rest of the API (verified: without threading, opening the live
feed would freeze every other request against a single-worker dev server).

## Hard safety boundaries (enforced in code, not just prompted)

- Never sends cryptocurrency, connects a real wallet, or clicks "Connect Wallet" /
  "Confirm Transaction" / similar buttons — these are hard-blocked regardless of
  what any ranking or AI suggestion says (see `FORBIDDEN_ACTION_SIGNALS` in
  `app/investigate/navigator.py`).
- The instant a page shows a CAPTCHA, KYC/identity verification, phone/SMS
  verification, or a payment requirement, **the entire investigation stops right
  there** — not just that link, not "try a different page" — with a screenshot
  of the wall captured as evidence of what stopped it. This is detected from
  both visible text and raw HTML (some CAPTCHA widgets show no visible text at
  all) and is checked before anything else on every page.
- Never attempts to solve or bypass a CAPTCHA, email/SMS verification, or 2FA
  prompt. The optional signup module stops immediately when it detects one,
  at any point in the flow — before typing, after typing, or after submitting.
- Never brute-forces logins or touches an account that isn't a fresh signup the
  tool itself created (and only when you've explicitly enabled it in Settings).
  Login pages are recognized and never receive any entered credentials.
- Never auto-submits the Google Form. Filling and submitting are two separate,
  clearly-separated steps; only you can do the latter.
- Stays on the target site's own domain during a crawl (no wandering off to
  unrelated sites) and enforces a hard cap on total pages per investigation,
  with URL normalization (trailing slashes, www., fragments, tracking params)
  ensuring the same page under a slightly different URL doesn't count as new
  territory and cause a loop.
- Each investigation runs in a fresh, isolated browser context — no cookies,
  storage, or session state is shared between sites or carried over from a
  previous investigation.
- Discovery is entirely passive: every source makes only standard, public,
  unauthenticated reads (DNS lookups, a public certificate-transparency log
  search, or correlating data already saved locally) — never an authenticated
  API call, never something that solves a challenge or bypasses a protection.
  Each source self-limits its request volume and the engine adds a courtesy
  delay between sources, so this stays respectful of the public services it
  reads from rather than hammering them.

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
playwright install chromium
```

Optional environment variables:

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # enables Claude-assisted link picking/classification
export SCAMBUSTERS_USERNAME=your_username  # from Discord /username, for the report form
export SCAMBUSTERS_TEAM_CODE=your_code     # from Discord /team
export SIGNUP_EMAIL_DOMAIN=yourdomain.com  # only if you plan to use the signup module
```

If `ANTHROPIC_API_KEY` isn't set, the tool still works — it falls back to
keyword-based link picking and page classification instead of asking Claude.

## Seeding candidate sites

Public scam-feed formats and hosts change often, so v1 ships two collectors:

- **`data/feeds.txt`**: one URL per line pointing at a JSON or CSV feed of
  scam-reported URLs. Empty by default — add sources you've vetted.
- **Manual import**: drop URLs (one per line, or a CSV with a `url` column)
  into any text file and import with:
  ```bash
  python3 -c "
  from app.collectors.manual_import import ManualImportCollector
  from app.collectors import run_collectors
  run_collectors([ManualImportCollector('my_urls.txt')])
  "
  ```
- Or just paste URLs into the "Add a URL manually" box on the dashboard.

## Running

```bash
# One-time setup
python3 cli.py init

# Launch the web dashboard (recommended — this is the full control center)
python3 cli.py serve
# then open http://127.0.0.1:5000
```

Everything — starting/pausing/stopping scans, reviewing findings, adjusting
settings, adding URLs, watching live progress — is available from the
dashboard with no terminal needed after this point. Click **Start Scan**,
watch the Overview panel and live activity log update in real time, then use
**Review Queue** to approve or reject findings as evidence comes in. Approved
findings get a button to open and fill the Google Form — review it in the
browser window that pops up and click Submit yourself when you're satisfied.

The CLI remains fully functional for scripting or headless/server use:

```bash
python3 cli.py collect              # pull in new candidates
python3 cli.py rank                 # score them
python3 cli.py investigate 5        # browser-investigate top 5 (sequential)
python3 cli.py investigate-parallel 5 500  # 5 concurrent workers, up to 500 sites
python3 cli.py full 10              # collect + rank + investigate 10, all at once

# Add --allow-signup and/or --deep-wallet-hunt to investigate/investigate-parallel/full:
python3 cli.py investigate 5 --deep-wallet-hunt
python3 cli.py investigate 5 --allow-signup --deep-wallet-hunt
python3 cli.py full 10 --deep-wallet-hunt
```

## Running the tests

```bash
pytest                          # once requirements.txt (incl. pytest) is installed
```

If you're in an environment without package-index access, a dependency-free
fallback runner is included (discovers the same tests/test_*.py files, no
pytest required):

```bash
python3 run_tests_standalone.py
```

The suite covers DB dedup/CRUD, wallet extraction (including the EVM chain/token
relabeling and a regression test for a loop-variable bug that once mislabeled
every address after the first), the heuristic ranker, the hard safety filters
in the navigator, page classification, and a concurrency test that hammers the
worker pool's queue-claiming logic with 10 threads to catch any reintroduced
race condition before it ships.

It also includes **real browser + real HTTP integration tests**
(`tests/test_navigator_integration.py`, `tests/test_runner_integration.py`):
a local Flask app (`tests/fixtures/fake_scam_site.py`) simulates a scam site
with deposit/wallet pages, a login page, a signup page, a payment-gated
access-control page, a two-page link loop, a redirect, and a dead link, and
the tests run the actual navigator/runner against it — not mocks. These are
what caught several real classification bugs during development (a shared
nav bar mentioning "Deposit" or "Sign Up" was leaking into page-type and
login/signup detection, misclassifying nearly every page on any site with a
persistent nav template) before they could affect a real investigation.
These are slower than the pure unit tests, so allow ~1-2 minutes for the full
suite; both the standalone runner and pytest run them automatically alongside
everything else.

`tests/test_deep_wallet_hunt.py` extends the same fixture with a currency-tab
deposit page and a clean-signup-to-member-deposit-page chain, and caught two
more real bugs the same way: the wallet-tab hunt was re-scanning the whole
page after every tab click and counting every extraction hit rather than only
genuinely new wallets, so a page with 3 real addresses reported "13 wallets
found" (the database itself was correct throughout — only the reported count
was wrong); and the first version of the tab-click test fixture put the
hidden addresses in a `<script>` block, which meant a raw-HTML scan found
them without any click ever happening, silently testing nothing. Both are
now covered by dedicated regression tests.

The discovery sources (`tests/test_discovery_*.py`) are tested with a mix of
mocked-network unit tests (deterministic, no external dependency — this is
how `certificate_transparency.py`'s parsing/scoring logic and the engine's
orchestration/dedup/audit-trail behavior are verified without needing crt.sh
or DNS to be reachable) and genuine live tests against real DNS where that's
practical (`similar_domains.py` and `shared_infrastructure.py` — DNS
resolution is a lightweight stdlib call with no API key, so these run for
real against domains like `binance.com` whenever DNS is available, and are
written to skip cleanly rather than fail if it isn't). This combination
caught several real bugs: two false-positive regexes in `contact_reuse.py`
(an email's domain half being misread as a Telegram handle; a phone number's
optional country-code prefix causing it to double-count as two different
numbers) and a shingle-size miscalibration in `template_similarity.py` that
made it too sensitive to trivial HTML edits on short pages.

## Architecture

```
app/
  config.py              All tunables: score keywords, wallet regexes, crawl limits, discovery limits
  db.py                  SQLite storage (sites, pages, wallets, findings, investigations,
                          decision log, wallet evidence, discovery events/runs) + dedup + stats
  events.py              SSE pub/sub bus powering the live dashboard
  log_stream.py          Routes Python logging output into the live activity panel
  runner.py              Start/Pause/Stop scan controller, emits live progress events
  ranker.py              Cheap heuristic scoring for prioritization (incl. discovery confidence)
  claude_client.py       Optional Claude calls: pick links, classify page type
  pipeline.py            Orchestrates collect -> rank -> investigate -> draft findings
  form_filler.py         Fills (never submits) the report Google Form, step-by-step
  collectors/
    public_feeds.py      Pulls from user-configured JSON/CSV feed URLs
    manual_import.py     Imports a plain URL list / CSV you gathered yourself
  discovery/
    base.py               Discoverer / PivotDiscoverer interfaces + DiscoveryCandidate
    engine.py              Orchestrates all sources: dedup, scoring, audit trail, run stats
    certificate_transparency.py  crt.sh search for keyword-matching, recently-issued certs
    similar_domains.py     Typosquat/permutation generation + DNS resolution pivot
    shared_infrastructure.py  IP/nameserver fingerprint matching between sites
    template_similarity.py  HTML structural fingerprinting (shingled tag sequences)
    contact_reuse.py        Telegram/WhatsApp/email/phone extraction + cross-site matching
  investigate/
    navigator.py         Isolated-context crawl loop: page understanding, access-control
                          stops, loop avoidance, wallet evidence, decision logging
    page_understanding.py Access-control (CAPTCHA/KYC/phone/payment) and login/signup detection
    url_utils.py          URL normalization + loop-avoidance tracking
    wallet_extractor.py  Regex + context-based wallet address extraction
    page_classifier.py   Keyword fallback for page-type / link filtering
    signup.py            Opt-in research signup; halts at any verification wall
    domain_age.py         WHOIS-based domain-age signal for the ranker (optional)
    queue_worker.py       Concurrent multi-browser worker pool for large backlogs
  review/
    server.py            Flask app: JSON API + SSE stream backing the dashboard
    templates/
      dashboard.html      Single-page dashboard shell
    static/
      css/style.css        Dashboard styling
      js/app.js             All dashboard logic: SSE handling, views, live updates
cli.py                   Command-line entry point (still fully usable without the UI)
tests/                   Pytest suite: DB, extraction, ranker, safety filters, queue races,
                          page understanding, URL/loop avoidance, discovery sources/engine,
                          plus real browser+HTTP integration tests against a local fake
                          scam site fixture
tests/fixtures/fake_scam_site.py  Local Flask test site used by the integration tests
run_tests_standalone.py  Dependency-free test runner for environments without pytest
pytest.ini               Pytest configuration
```

## Scaling to thousands of sites

- Ranking only needs one HTTP GET per site (no browser), so scoring 1,000+
  candidates is fast and cheap — this is what lets the queue stay ordered by
  suspicion even at scale.
- For the investigation stage itself, use the **concurrent worker pool**
  (`app/investigate/queue_worker.py`) instead of the sequential batch runner:
  ```bash
  python3 cli.py investigate-parallel 5 500   # 5 workers, up to 500 sites
  ```
  or click "Investigate with worker pool" on the dashboard. Each worker runs
  its own Playwright browser and atomically claims the next highest-scored
  site from the same SQLite queue, so multiple workers never duplicate work
  (verified with a concurrency test — 6-10 simultaneous workers claiming from
  a shared queue never produced a duplicate claim across repeated runs).
- `MAX_CONCURRENT_BROWSERS` in `config.py` sets the default worker count.
  Tune it to your machine's CPU/memory — each worker is a full Chromium
  instance.
- SQLite with WAL mode comfortably handles this volume for a single-user
  research tool. If you outgrow a single machine, the queue-claiming logic
  in `queue_worker.py` is the one piece to swap for a real broker
  (Celery+Redis or RQ); the ranker, navigator, and extractor don't know or
  care how they were invoked.

## Known v1 limitations / next steps

- Public feed sources are pluggable but empty by default — add feeds you trust
  to `data/feeds.txt`, or keep using manual import/URL entry.
- The Google Form filler matches fields by visible label text, which is robust
  to minor form edits but may need adjustment if the form's structure changes
  significantly (e.g. new question order, added pages). Its later pages (the
  wallet-entry pages) only render client-side after the Yes/No branch on page 1
  is answered, so they can't be inspected ahead of time — the filler reports
  per-step success/failure with screenshots rather than assuming it worked, so
  you can see exactly where to pick up manually if a later page doesn't match.
- Wallet regexes cover BTC/ETH/TRON/LTC/DOGE/XRP/SOL/ADA/DASH/BCH, plus
  context-based relabeling of EVM-format (0x...) addresses to BNB/MATIC/
  USDT/USDC when nearby text names the chain or token — covering every
  wallet type the ScamBusters form currently accepts except SOL (still
  recorded locally as evidence even without a matching form option).
- No CAPTCHA-solving anywhere, by design — sites that hit a CAPTCHA, KYC/identity
  check, phone verification, or payment requirement are recorded as "blocked"
  with the specific reason and a screenshot of the wall, and need manual review
  to go further (which this tool will never attempt on its own).
- Deep wallet hunt mode's tab-clicking only clicks elements whose visible text
  looks like a plain currency/network label; a deposit page that switches
  wallets via something other than a labeled button/tab/link (e.g. a custom
  dropdown widget with no visible per-option text until opened, or a
  currency selector driven entirely by image icons) may not be recognized.
  The post-signup wallet hunt is similarly bounded by its own small page
  budget (`POST_SIGNUP_MAX_PAGES`) so it doesn't run indefinitely inside an
  unfamiliar account area.
- Domain-age ranking signal requires `python-whois`; many registrars rate-limit
  or block WHOIS queries, so treat it as a helpful tiebreaker, not a reliable
  signal for every domain.
- The certificate-transparency discoverer depends on crt.sh being reachable
  from wherever you run this. It was built and logic-tested (JSON parsing,
  age-based confidence scoring, error handling) but could not be verified
  against the live service in this project's development sandbox, whose
  network egress is restricted to an allowlist that didn't include crt.sh —
  test it against the real service in your own environment before relying on
  it, and check the Discovery view's run history for errors if it comes back
  with zero candidates.
- The shared-infrastructure discoverer's nameserver correlation only activates
  if `dnspython` is installed (`pip install dnspython`); without it, IP-based
  matching alone still works using only the standard library.
- Discovery's similar-domains and shared-infrastructure sources use plain DNS
  resolution, which has no rate limit of its own, but generates a real query
  per candidate checked — the `SIMILAR_DOMAIN_MAX_DNS_CHECKS_PER_RUN` and
  `SHARED_INFRA_MAX_SEEDS_PER_RUN` settings in `config.py` cap this per run;
  raise them cautiously if your resolver/network can handle more volume.
- The heuristic ranker scores only a site's homepage (one lightweight HTTP GET,
  by design, so it stays fast at scale) — a site with scam content only on
  interior pages (e.g. wallet addresses solely on `/deposit`) may rank lower
  than its true risk. The risk threshold that gates auto-investigation should
  be tuned with this in mind; sites just below it are still visible and
  investigable manually from the Sites view.
- Page-type and login/signup classification rely on a page's own URL and title
  as the primary signal (deliberately not scanning the full page body, since a
  shared navigation bar linking to "Deposit" or "Sign Up" would otherwise get
  every page on the site misclassified — this was found and fixed via the
  integration tests, see below). A page with a generic URL/title and no Claude
  API key configured may classify as "other" even when it has relevant content;
  configuring `ANTHROPIC_API_KEY` lets Claude read the actual page content for
  these ambiguous cases.

## v2: Cross-Site Correlation

v2 shifts the goal from "find more domains" to "find the connections between
the good ones". The organising idea is an **indicator graph**: every reusable
public artifact a site exposes becomes a normalised indicator, and any two
sites sharing one are connected by construction.

### Observed facts vs derived correlations

This distinction runs through the whole system and is enforced structurally —
every row carries an `evidence_class`:

- **observed** — we saw it ourselves: this wallet on this page at this time,
  this IP in DNS, this fingerprint on the served TLS certificate.
- **derived** — software concluded it by comparing observations: these two
  sites are related, these five form a family.

Every derived relationship points back to the specific observed indicator that
justifies it, so "why are these linked?" always has a concrete answer.

### Indicators harvested

`wallet` · `analytics_id` (GA/GTM/Pixel — account-bound) · `telegram` ·
`whatsapp` · `email` · `phone` · `cert_sha256` · `template_hash` ·
`favicon_hash` · `ip` · `nameserver`

### Clustering

Sites are grouped into families by connected components over the relationship
graph. Priority mirrors the per-site quality gate: it's driven by how many
**independent strong indicator types** tie a family together, not by size.
Three sites sharing a wallet, a Telegram handle and an analytics ID outrank
twenty sites sharing one budget-hosting IP.

Promiscuous indicators are rejected as infrastructure noise before they can
create links — a CDN IP appearing on 40 sites forms no cluster at all.

### Related-site discovery

Pivots outward from **confirmed high-confidence sites only** (pivoting from
unconfirmed sites just multiplies noise): TLS certificate SANs, wallet
backtracking, and domain-pattern siblings. Everything found still goes through
triage and deep analysis rather than being trusted for its origin.

### Historical tracking

Observations are never silently overwritten. When a later scan no longer sees
an indicator it's closed out (`still_present=0`) and kept, so previous scans
inform correlation without being mistaken for current truth. Changes are
recorded in `indicator_history` and surfaced at `/api/changes`.

### Key endpoints

```
GET  /api/intel/stats               graph-wide counts
GET  /api/search?q=...              global search across all intelligence
GET  /api/clusters                  families, highest priority first
GET  /api/cluster/<id>              one family with members and evidence
POST /api/correlate                 derive relationships, rebuild clusters
GET  /api/wallet_reuse              wallets seen on more than one site
GET  /api/workspace/<site_id>       Site -> Pages -> Deposits -> Wallets -> Related
GET  /api/site/<id>/timeline        evidence timeline
GET  /api/changes                   historical change feed
POST /api/related/discover          pivot from confirmed sites
GET  /api/export/cryptowalletlogger CSV export
GET  /api/export/wallet_investigator JSON export
GET  /api/export/evidence/<site_id> full observed/derived bundle
GET  /api/export/cluster/<id>       whole family as one document
```

### Export format fidelity

The CryptoWalletLogger and Wallet Investigator exporters are built from those
tools' documented/typical shapes. I could not validate against a live copy of
either from my build environment, so treat the column sets as a best-supported
interpretation rather than a verified match. Each exporter keeps its field
mapping in one dict at the top of `app/export.py` so adapting to your exact
build is a one-line change, and `/api/export/evidence/<id>` is always available
as a lossless fallback.

### v2 UI

Two new views, plus global search:

**Families** — every derived cluster, ranked by priority, each with a plain-language
summary of *why* those sites are one family. Click through for per-member join
reasons, and export a whole family as one document. Below the list, a wallet-reuse
panel surfaces every address seen on more than one site. Two buttons drive the
graph: *Re-run Correlation* (derive links, rebuild families) and *Find Related
Sites* (pivot outward from confirmed sites).

**Investigation Workspace** — the Site → Pages → Deposit Options → Wallets →
Related Sites chain rendered as a visual funnel, with six evidence panels beneath
it and a full evidence timeline. Every item carries an `observed` or `derived`
badge, and indicators that a later scan no longer found are marked *gone* rather
than deleted.

**Global search** (top bar) — type two or more characters to search sites, wallets,
indicators, deposit options, pages and families at once. Results link straight into
the workspace. Escape closes.

The observed/derived distinction has a consistent visual language throughout:
green for things we saw ourselves, blue for things the software concluded.

## v0.3: Discovery Pivot Engine

Earlier versions ran the searches you thought of in advance. v0.3 learns new
searches from what it finds:

```
Seed → Indicators → Pivots → New Sites → New Indicators → More Pivots
```

Each arrow is one wave. The engine starts only from sites that already reached
high confidence on their own evidence, turns their observable indicators into
searchable questions, runs those against passive public sources, and feeds
results back in as new seeds.

### What this claims — and what it doesn't

**Every output is a lead, not a verdict.** That two domains share a TLS
certificate, an analytics ID, an IP or a wallet address is an observed fact
about indicators. It is *not* a finding that they have the same owner, that
anyone controls both, or that a newly-found domain is malicious. Shared
hosting, copied templates, CDN reuse, recycled certificates, compromised sites
and plain coincidence all produce identical signals.

Discovered sites therefore enter the normal pipeline as candidates and must
earn their own confidence through triage and deep analysis. The pivot engine
decides what to *look at next*; it never decides what is true. This is enforced
by a test (`test_convergence_summary_does_not_claim_ownership`) that fails the
build if ownership language appears in generated summaries.

### Pivot types

| Pivot | Question it asks |
|---|---|
| `cert_san` | which other domains appear on this TLS certificate? |
| `wallet_reuse` | which other known sites show this same address? |
| `analytics_reuse` | which other known sites embed this same tag ID? |
| `contact_reuse` | which other known sites publish this handle/number/address? |
| `template_reuse` | which other known sites use this page structure? |
| `favicon_reuse` | which other known sites serve this icon? |
| `ip_neighbour` / `ns_neighbour` | which other known sites share this hosting? |
| `domain_pattern` | do sibling names in the same shape resolve? |

`registrar` and `asn` are deliberately **not** pivotable — they describe the
hosting market, not a site.

### Runaway prevention

Eight independent brakes, each tested in isolation:

1. **Depth limit** — hops from seed to discovered site (default 2)
2. **Candidate budget** — total new sites per run (50)
3. **Lead budget** — total pivots executed per run (200)
4. **Per-lead cap** — one huge certificate can't flood a run (25)
5. **Wall-clock limit** — hard stop (900s)
6. **Cross-run dedup** — a lead executed once is never re-run
7. **Evidence floor** — indicators below 0.40 strength never become pivots
8. **Promiscuity floor** — an IP on 25+ sites describes a host, not a site

Whichever brake fires is recorded as the run's `stopped_reason`.

### Discovery Paths and convergence

Every reached site carries the full chain that found it:

```
seed:seed-a.test → wallet_reuse(wallet=TN3W…) → linked-b.test
                 → contact_reuse(telegram=deep_handle) → deep-d.test
```

When **multiple independent pivots** reach the same domain, that's a materially
stronger lead than any single route, and its connection score rises. Independence
is what counts — five paths resting on the same indicator are one piece of
evidence, not five. Scores are damped by depth, since distant hops are weaker.

The **Pivot Engine** view ranks every reached site by connection score, flags
multi-path sites, and prints each Discovery Path in full.

### Endpoints

```
GET  /api/pivot/stats            engine-wide counters
GET  /api/pivot/leads            ranked worklist with full paths
GET  /api/pivot/paths/<site_id>  every path that reached one site
GET  /api/pivot/runs             run history with the brake that stopped each
GET  /api/pivot/run/<id>         one run: leads, paths, config snapshot
POST /api/pivot/expand           start an expansion
```

---

## v0.4: Autonomous Discovery Intelligence

v0.3 ran every pivot it could generate. v0.4 **decides which pivots are worth
running**, remembers what worked, and stops spending time on what didn't.

The release adds five things: a technique yield ledger, resumable multi-stage
campaigns, family signatures that catch newly appearing related domains,
evidence-gated candidate prioritisation, and a knowledge graph that ties all of
it together in the shape the Main Investigation Platform will consume.

### The standing rule, restated

Everything below produces **leads with recorded reasons**. A shared IP, a
shared certificate, a reused wallet address or an on-chain interaction is an
observation about public indicators. It is **never** treated as proof of shared
ownership, shared control, or that a site is malicious — shared hosting, bought
or stolen templates, recycled certificates, resold contact handles, copied page
text and compromised sites all produce exactly the same signals.

Every score in v0.4 is reconstructable from stored counters, and every
relationship stores the specific indicator that caused it. Four separate tests
(`test_campaign_language_never_claims_shared_ownership`,
`test_match_language_never_claims_shared_ownership`,
`test_graph_language_never_claims_shared_ownership`,
`test_priority_is_not_presented_as_a_judgement_about_the_site`) fail the build
if ownership language appears in generated output or in the source that
produces it.

### 1. Technique learning (`app/discovery/technique_learning.py`)

Each pivot type carries a running ledger. Three ratios combine into one score:

| Ratio | Question | Weight |
|---|---|---|
| uniqueness | of the candidates it returned, how many were genuinely new? | 0.25 |
| survival | of the sites it found first, how many cleared triage? | 0.35 |
| payoff | of those, how many reached high confidence? | 0.40 |

Two guard rails matter more than the formula:

- **Small samples are not judged.** Scores are shrunk toward neutral by an
  evidence weight of `leads / (leads + 4)`, and nothing is throttled below five
  executed leads. Without this, one unlucky first run would permanently
  suspend a good technique — the classic failure of naive bandit scoring.
- **Suspension is reversible.** `suspended` means "stop spending budget here
  for now", never "banned". A suspended technique is re-tried every 25 leads
  run elsewhere, because a technique that is unproductive this month may be
  productive next month.

The learned score becomes a 0.6–1.4 priority multiplier on lead strength when
the queue is ordered — shallower depth still wins first, with technique quality
breaking ties within a depth.

### 2. Discovery campaigns (`app/discovery/campaigns.py`)

A campaign starts from one seed and runs waves of:

```
Seed → Pivot → Candidate → Validate → Expand
```

Seeds can be a **domain**, a **wallet**, a **template hash**, an
**infrastructure indicator (IP)**, or a **keyword theme**. A seed that matches
nothing known says so rather than inventing sites.

**Budgets.** Every consumable is spent through a ledger that refuses to
overrun: candidates, leads, API calls, deep analyses, waves and wall-clock. A
refused spend does not consume budget, which is what keeps the ledger from
drifting. Only techniques that make outbound requests (`cert_san`,
`domain_pattern`) charge the API-call budget; database-only correlation pivots
are free. Whichever budget runs out first is recorded as `stopped_reason`.

**Resumption.** Every stage boundary is written to the database before the next
begins, and each executed lead is recorded as completed work. An interrupted
campaign is marked `interrupted`, not `complete` — so resuming re-enters that
stage and continues from the rest instead of skipping it. Re-running a finished
campaign adds no new work.

### 3. Family signatures and the watch (`app/discovery/cluster_watch.py`)

Clustering answers "which sites I already have belong together?". The watch
answers the forward question: *a new domain appeared — does it match a family
I already know?*

A signature is built only from indicators genuinely shared by two or more
cluster members, with anything too common filtered out. A match then requires
**either** one identity-bound indicator (wallet, contact handle, analytics
property — things an operator supplies rather than inherits) **or** at least
two indicators from different categories. Sharing one nameserver with a family
never flags a site, which is the whole point of requiring a combination.

Every recorded match names the innocent explanations that fit the same evidence
and states in the record that it is not a finding about who runs the site.

### 4. Candidate prioritisation (`app/discovery/candidate_priority.py`)

Deep analysis is the expensive stage and the budget rarely covers every
survivor, so the order matters:

| Factor | Weight | Requires |
|---|---|---|
| connection to the campaign's own evidence | 0.30 | recorded discovery paths |
| wallet observed | 0.22 | an actual wallet observation |
| deposit route found | 0.16 | an actual deposit option |
| independent methods converged | 0.14 | 2+ distinct pivot types |
| newly registered | 0.10 | a retrieved registration date |
| responsive | 0.08 | an HTTP status under 400 |

**Every factor is evidence-gated.** An unknown registration date scores zero —
it does not score "probably new". Absence of evidence never becomes evidence,
because these scores decide where the expensive attention goes, and a score
built partly on guesswork sends it to the wrong place while looking just as
confident.

A promoted site's priority is written to its score with the reasoning stored
alongside, so the shared deep-analysis queue orders by it without ever carrying
an unexplained number.

### 5. The Discovery Knowledge Graph (`app/discovery/knowledge_graph.py`)

One persistent graph over everything: sites, indicators, wallets,
infrastructure, clusters, discovery sources and campaigns, joined by typed
edges.

It is a **view, not a second copy** — every node and edge is assembled from
existing rows on demand, so it cannot drift out of step with the evidence
behind it.

| Node types | Edge types |
|---|---|
| `site`, `indicator`, `wallet`, `infrastructure`, `cluster`, `discovery_source`, `campaign` | `observed_on`, `shares_indicator`, `in_cluster`, `discovered_by`, `pivoted_to`, `matches_family` |

Wallets and infrastructure are **separate node types** on purpose: "same host"
and "same wallet" must never look alike in a graph.

Every node and edge carries `evidence_class`. `GET /api/graph?observed_only=1`
strips every software conclusion and leaves only what was actually seen — the
view to use when the question is "what do we actually know?".

`GET /api/graph/export` emits `scamhunter.knowledge_graph.v1`, which carries
its own evidence policy so a downstream consumer inherits the observed/derived
distinction rather than having to be told about it.

### v0.4 UI

A **Campaigns** view with live counters for active pivots, branches, candidates
found, rejected noise, families and high-confidence results; a live branch feed
that colour-codes stage boundaries, pivots, promotions and discarded noise; a
technique yield panel showing each technique's score, throttle state and the
arithmetic behind it; per-campaign stage and budget tables with every
candidate's full discovery path; and a panel of newly appearing domains that
matched a known family.

### v0.4 endpoints

```
GET  /api/campaigns                       campaign list with live stats
POST /api/campaign/create                 create (and optionally start) a campaign
GET  /api/campaign/<id>                   stages, budgets, ranked candidates, paths
POST /api/campaign/<id>/run               start or resume
GET  /api/campaign/<id>/budget            ledger state and stage history

GET  /api/techniques                      yield ledger with evidence notes
POST /api/techniques/recompute            recompute every score from counters

GET  /api/families/watch                  signatures and newly matched domains
POST /api/families/scan                   refresh signatures and check for arrivals
GET  /api/families/signature/<cluster_id> one family's signature and how it was built

GET  /api/candidate/<site_id>/priority    priority with every factor's evidence
GET  /api/graph                           knowledge graph (?observed_only=1 to strip conclusions)
GET  /api/graph/stats                     cheap counters
GET  /api/graph/site/<id>                 the graph around one site
GET  /api/graph/export                    scamhunter.knowledge_graph.v1
```

### v0.4 configuration

```python
TECHNIQUE_MIN_LEADS_FOR_CONFIDENCE = 5     # never throttle below this
TECHNIQUE_PRIOR_STRENGTH           = 4.0   # shrinkage toward neutral
TECHNIQUE_REDUCED_THRESHOLD        = 0.45
TECHNIQUE_SUSPENDED_THRESHOLD      = 0.25
TECHNIQUE_RETRY_AFTER_LEADS        = 25    # suspension is reversible

CAMPAIGN_MAX_WAVES                 = 3
CAMPAIGN_MAX_CANDIDATES            = 100
CAMPAIGN_MAX_LEADS                 = 150
CAMPAIGN_MAX_API_CALLS             = 300
CAMPAIGN_MAX_SECONDS               = 1800
CAMPAIGN_MAX_DEEP_ANALYSES         = 15
CAMPAIGN_MAX_CONCURRENCY           = 3
CAMPAIGN_PROMOTE_MIN_CONNECTION    = 0.55
```

### What v0.4 still does not do

- It does not bypass CAPTCHA, phone verification, rate limits or any other
  access control. Discovery stays passive and works from publicly accessible
  information.
- It does not conclude anything about ownership, control or intent. It decides
  what to look at next; a human decides what is true.
- It does not submit reports without a human click. Every submission mode still
  ends with a person confirming.

---

## v0.5: Main Platform Integration & Discovery Intelligence

v0.5 changes what Site Finder is *for*. It stops being a self-contained tool
that happens to find scam sites and becomes the specialised discovery engine
of a larger investigation system:

```
Discover → Triage → Correlate → Prioritize → Send to Main Platform
```

Deep website investigation — driving a browser, crawling deposit flows,
capturing page evidence — is **Site Investigator's** work, requested through
the Main Platform. Site Finder does lightweight public triage only, and hands
over.

### The two rules that shape everything here

**1. Site Finder must stay independently usable.** An unreachable platform is
a normal operating state, not an outage. Events queue locally, discovery is
unaffected, deep analysis falls back to running here, and everything
synchronises when the link returns. Nothing is ever lost to a network problem.

**2. Nothing sent asserts ownership or maliciousness.** Every derived event
carries the reasoning that produced it and the innocent explanations that fit
the same evidence. A `relationship.observed` event says two sites show the
same public artifact — which shared hosting, a copied template, a recycled
certificate, a resold handle and a compromised site all produce identically.
Four tests fail the build if ownership language reaches an outbound event.

### The event contract (`app/integration/contract.py`)

Seven event types, one envelope:

| Event | Says |
|---|---|
| `site.discovered` | a new candidate domain exists, and how it was found |
| `site.triaged` | lightweight public validation finished, with its evidence categories |
| `site.high_priority` | it cleared the bar — **this is the request for Site Investigator** |
| `relationship.observed` | two sites share a specific named public artifact |
| `wallet.observed` | a payment address was seen on a page |
| `infrastructure.observed` | where a domain is hosted or served from |
| `campaign.updated` | a discovery campaign changed state |

Every event carries schema version, stable event id, both timestamps, node id,
correlation id, investigation id, full provenance (including complete
discovery paths), `evidence_class`, and the payload.

**Idempotency.** `event_id` is a hash of *the facts the event asserts*, not of
when it was built. Re-emitting the same observation produces the same id, so
the classic failure — the platform got it but the response was lost — is
harmless. Duplicates are prevented twice over: the outbox refuses to queue a
known id, and the platform refuses to store one.

**Versioning.** Site Finder sends its schema; the platform answers with what it
accepts. Same major version proceeds. A newer platform proceeds with a
degraded-mode warning. An older or foreign schema **stops sending** and
surfaces as an integration error rather than shipping events the platform
would misread — events stay queued, not dropped.

### Reliable delivery (`outbox.py` semantics in `db.py`, `client.py`, `sync.py`)

Everything goes into a persistent outbox **first** and is sent from there, so
the emit path is identical whether the platform is up, down, or has never been
configured.

Failures are classified, because retrying is only safe if you know what
happened:

| Kind | Meaning | Action |
|---|---|---|
| `unreachable` | down, slow, 5xx | retry with backoff |
| `ambiguous` | request went out, response lost | **retry** — this is what idempotency is for |
| `rejected` | malformed, unknown type, bad schema | fail and surface; retrying sends the same bad event forever |

Backoff is exponential and **per event**, so one bad event cannot block the
queue behind it. By default nothing is discarded for age or attempt count: an
undeliverable discovery stays queued and visible rather than silently
disappearing.

**Restart safety.** Anything left mid-flight when the process died is returned
to the queue rather than assumed delivered — the receiver deduplicates, so a
re-send costs nothing while assuming success could lose a discovery forever.

### What gets sent (`app/integration/emitter.py`)

The gate is **independent evidence categories, not indicator count**. Fifteen
indicators from one category is one thing shouting; a payment address plus a
contact handle plus a deposit route is three unrelated things agreeing.

```python
SEND_MIN_TRIAGE_SCORE         = 0.35
SEND_MIN_EVIDENCE_CATEGORIES  = 2      # independent categories
SEND_MIN_PRIORITY             = 0.30
SEND_HIGH_PRIORITY_THRESHOLD  = 0.62   # at or above -> site.high_priority
SEND_RELATIONSHIPS_MIN_STRENGTH   = 0.45
SEND_INFRASTRUCTURE_MAX_SITE_COUNT = 25   # a CDN address is noise, not a discovery
```

Both the yes and the no are explained. "Why did this never reach the platform?"
is the question operators ask most, and the hardest to answer after the fact,
so `should_send_site()` returns `reasons` and `blocked_by` in full.

### Division of labour (`app/integration/handoff.py`)

`DEEP_ANALYSIS_MODE` controls who investigates:

- **`handoff`** — always delegate to Site Investigator
- **`local`** — always analyse here (v0.4 behaviour)
- **`auto`** (default) — delegate when the platform is reachable and
  compatible; fall back to local analysis when it is not

The point of `auto` is that a disconnected Site Finder degrades to v0.4
behaviour rather than to no behaviour. When the platform is reachable, the
local deep-analysis stage stands down entirely — crawling a site Site
Investigator is already crawling is duplicated effort and duplicated load on
the target. Every decision is written to the site's timeline.

### Stronger prioritisation (`app/discovery/candidate_priority.py`)

Independent-category corroboration is now the largest single factor:

| Factor | Weight |
|---|---|
| independent evidence categories | 0.22 |
| connection to campaign evidence | 0.24 |
| wallet observed | 0.18 |
| deposit route found | 0.14 |
| independent methods converged | 0.10 |
| newly registered (where known) | 0.07 |
| responsive | 0.05 |

Every factor is still evidence-gated: an unknown registration date scores
zero, never "probably new".

### Budget protection (`app/discovery/indicator_noise.py`)

v0.3's static site-count cap catches shared hosting before any budget is
spent. v0.5 adds a **measured** gate that catches what the static one cannot:
an indicator that looks discriminating by site count but has returned 400
candidates with nothing surviving triage. Such an indicator is retired from
pivoting, with the numbers that justified it.

Retirement is a budget decision, not a verdict: nothing is retired below 30
candidates, the observation itself is never deleted, and a person can put any
indicator back in play with one click.

### Sharper learning

Technique payoff now prefers the harder test — did the discovery clear the
send gate and go to the platform as worth investigating? — over Site Finder's
own opinion of a site. A standalone installation with no platform falls back
to the local high-confidence count, so learning never stops.

Yield is also tracked **per indicator value**, not just per technique: a
productive technique running on one worthless value can now be spotted and
that value retired, without disabling the technique.

### Campaign and source statistics (`app/discovery/discovery_stats.py`)

The whole funnel, per source, per pivot, per campaign, per indicator:

```
candidates → passed triage → high priority → sent to the platform
```

with the conversion rate at each step, plus `cost_per_promoted` for campaigns.
Rows built on fewer than ten candidates are **flagged as unmeasured and sorted
below measured ones** — a source with three candidates and a 100% rate is not
the best source, it is an unknown one, and ranking it first is exactly the
mistake these numbers exist to prevent.

### Better new-site detection

The family watch now distinguishes two things v0.4 conflated:

- **`newly_registered`** — the domain itself is young *and* matches a known
  family. The family is still operating; act on this.
- **`newly_noticed`** — an old domain we happened to scan for the first time.
  Our coverage catching up, not the family expanding.
- **`new_to_us`** — registration date unknown, so which of the two is
  undetermined, and it is not assumed either way.

### The reference platform (`app/integration/reference_platform.py`)

A minimal, compliant Main Platform v4 receiver: handshake, heartbeat, event
intake with deduplication, one investigation per site, and Site Investigator
job creation on a high-priority handoff. It is the **executable form of the
contract** — something a real v4 implementation can be checked against — and
the harness for the end-to-end tests.

`DirectTransport` runs it in-process through `MainPlatformClient`'s real send
path, so the tests exercise production code rather than a parallel test-only
path that could drift from it.

### Pointing this at a real Main Platform v4

```bash
export MAIN_PLATFORM_URL=https://platform.example/          # required
export MAIN_PLATFORM_TOKEN=...                             # bearer token
export SITE_FINDER_NODE_ID=site-finder-1                   # unique per instance
export DEEP_ANALYSIS_MODE=auto                             # auto | handoff | local
```

The real platform needs the four endpoints in `reference_platform.py`
(`/api/v4/handshake`, `/api/v4/heartbeat`, `/api/v4/events`, and optionally
`/api/v4/state`). Press **Connect** in the Platform view: the handshake reports
exactly what the two sides agree on and what, if anything, is being lost.

### End-to-end tests

`tests/test_integration_e2e.py` proves the whole chain and the failure modes:

- discovery → triage → event → platform receives → investigation opened →
  Site Investigator job triggered, carrying the discovery path
- the same observation never queues twice; a redelivered event is deduplicated
- an unreachable platform loses nothing, and everything drains when it returns
- an unconfigured platform is a supported state, not an error
- an interrupted send is requeued, not assumed delivered; a restart does not
  double-deliver
- a single-category candidate never reaches the platform at all
- an incompatible schema stops sending rather than shipping garbage
- no outbound event claims shared ownership or maliciousness; every derived
  event carries its reasoning; every site event declares Site Finder's limited
  role

### v0.5 endpoints

```
GET  /api/integration/status        connection, outbox, failures, recent sends
GET  /api/integration/contract      the contract, as data
POST /api/integration/connect       handshake on demand
POST /api/integration/heartbeat     prove the link
POST /api/integration/sync          drain the outbox now
GET  /api/integration/outbox        queued/sent/failed events
POST /api/integration/retry         clear backoff on everything deferred
POST /api/integration/outbox/<id>/cancel
GET  /api/integration/handoff       who is investigating what
GET  /api/integration/site/<id>     the send decision for one site, explained
POST /api/integration/emit/<id>     offer one site to the platform now

GET  /api/stats/overview            the funnel, best and worst performers
GET  /api/stats/sources             per-source funnel and conversion
GET  /api/stats/pivots              per-technique funnel and learned state
GET  /api/stats/campaigns           per-campaign cost and yield
GET  /api/stats/indicators          retired indicators and the watchlist
POST /api/stats/indicators/sweep    retire anything that has earned it
POST /api/stats/indicators/reinstate
```

### What v0.5 still does not do

- It does not bypass CAPTCHA, phone verification, rate limits or any other
  access control. Discovery stays passive and public.
- It does not perform deep website investigation when a platform is available.
  It requests it.
- It does not conclude anything about ownership, control or intent — not
  locally, and not in anything it sends.
- It does not submit reports without a human click.

---

## v0.6: Production Integration & Discovery Quality

v0.6 does two things. It **replaces Site Finder's own integration standard with
the canonical Main Investigation Platform v4 contract**, and it makes discovery
quality measurable against what happens downstream rather than against Site
Finder's own opinion of itself.

### One wire standard, and it is the platform's

The v0.5 modules that defined a Site-Finder-shaped contract (`contract.py`,
`client.py`, `emitter.py`, `sync.py`, `reference_platform.py`) were **deleted**,
not kept alongside. Everything now lives in `app/integration/v4/`, built on the
platform's own Python SDK — `sdk/python/main_investigation_client.py`, vendored
byte-for-byte and unmodified at
`app/integration/v4/main_investigation_client.py`.

Site Finder defines no endpoint, event type, field, identifier, status value or
schema rule of its own. `app/integration/v4/contract.py` is a transcription of
the platform's `API.md`, `lib/events.ts`, `lib/ingestion.ts`, `lib/platform.ts`
and `lib/domain.mjs` — including `normalizeCanonicalKey`, `schemaCompatibility`
and `retryDelaySeconds`, reimplemented in Python so both sides compute the same
answers.

| | |
|---|---|
| Module name | `site_finder` |
| Auth | `X-API-Key`, plus `OAI-Sites-Authorization` for a private Site deployment |
| Capabilities | `site:discover`, `site:relate` |
| Ingest schema | `1.1` |
| Event schema | `1.0` |
| Job types handled | `FIND_RELATED_SITES`, `RECHECK_TARGET` |

### Why `ingest` is the primary channel

This is the most important design point in the release.

`POST /api/v1/events` only *routes* an event when it carries `entity_id` — and
entity UUIDs are minted by the platform, so a module cannot know one before the
entity exists. `POST /api/v1/ingest/site_finder` solves exactly that: the
compatibility adapter upserts each record into an entity and then publishes the
v4 event **itself**, with the real `entity_id` and `investigation_id` filled in.

So ingesting a `sites` record *is* how Site Finder publishes a properly routed
`site.discovered` — and `site.discovered` is what the platform routes to
`INVESTIGATE_SITE` on `site_investigator`. **That is the handoff, expressed in
the platform's own terms.**

### How Site Finder's old events map onto v4

| v0.5 (removed) | v0.6 (canonical) |
|---|---|
| `site.discovered` | a `sites` record → platform publishes `site.discovered` |
| `site.triaged` | no v4 event; becomes `confidence` + `classification` + passthrough detail on the site record |
| `site.high_priority` | no v4 event; the contract's `priority` field, which `priorityValue()` reads when queueing `INVESTIGATE_SITE` |
| `wallet.observed` | a `wallets` record → `wallet.observed` |
| `relationship.observed` | a `relationships` record, `assertion_kind: "derived"`, with its evidence → `relationship.discovered` |
| `infrastructure.observed` | an `infrastructure_indicators` record — no event, correctly: hosting is context, not a trigger |
| `campaign.updated` | a `module_activity` record |

### Contract Gap Report

Where v4 does not express something Site Finder needs, the answer is to say so
— never to add a field. `docs/CONTRACT-GAP-REPORT.md` (also at
`GET /api/integration/gaps`) records every gap with what Site Finder does
instead, what is lost, and what the contract would need.

**Two real gaps, where information is genuinely lost:**

1. **`discovery-quality-telemetry-has-no-home`** — no record type carries
   per-technique performance, so the platform cannot weigh a candidate by the
   track record of the route that found it. Aggregate counts go in
   `module_activity.metrics`; per-technique detail stays local.
2. **`site-finder-cannot-express-negative-triage`** — ingesting a site always
   publishes `site.discovered`, which routes to `INVESTIGATE_SITE`. There is no
   way to say "examined and dismissed" without also requesting investigation,
   so negative results never reach the platform and another sensor may
   rediscover the same thin candidate.

Three further gaps are cosmetic (expressible but not queryable), and three are
documented as no-gap for completeness.

### Bidirectional integration

- **Register** once at startup with capabilities and supported event types
- **Heartbeat** with `current_job_id` while working, so the platform extends
  the lease rather than treating a slow job as a disconnected worker
- **Claim jobs**: `FIND_RELATED_SITES` (routed by `site:relate` from
  `site.investigated`) runs a real discovery campaign and returns the results
  through ingest; `RECHECK_TARGET` re-triages a known candidate
- **Report** progress, completion, failure or `needs-review`
- **Investigation context** hydrates Site Finder with what other modules found

**The automation policy is enforced, not acknowledged.** Every claimed job is
checked before it runs: a job permitting financial actions, requiring
credentials or authenticated access, or naming prohibited work is returned as
`needs-review` rather than quietly reinterpreted. Site Finder makes
unauthenticated public requests only.

### Reliability

| Concern | How |
|---|---|
| Offline | Everything queues to a local outbox first; the send path is identical whether the platform is up, down, or never configured |
| Idempotency | `batch_id` is a hash of the batch's *content*, so a retry is automatically the same id — API.md says to reuse it, and the platform returns the original result with `replayed: true` |
| Retry classification | `unreachable` and `ambiguous` retry; `rejected` dead-letters and surfaces. Treating ambiguous as permanent loses discoveries; treating permanent as retryable fills the queue forever |
| Backoff | Per batch, on the platform's own `retryDelaySeconds` curve, so one poison batch cannot block the queue behind it |
| Dead letters | Parked locally and surfaced — never silently discarded, never retried forever |
| Restart | Anything mid-flight is requeued, not assumed delivered; held jobs are handed back rather than left to a lease timeout |
| Schema mismatch | The platform's 409 stops sending; batches are held, not dropped |

### Discovery quality from downstream feedback

Everything Site Finder measured before v0.6 was measured by Site Finder — which
is exactly the measurement a drifting system cannot use to notice it is
drifting.

`GET /api/v1/investigations/{id}/context` is the contract's own channel for
shared context, so Site Finder polls the investigations it opened and counts
what **other** modules added: deposit pages, wallets, infrastructure evidence,
relationships. Its own contributions are excluded — crediting a technique for
evidence it supplied itself would be a closed loop.

Outcomes are `useful` / `thin` / `unreachable`, deliberately about the **lead**:

> "Useful" means the candidate contained something worth examining. It never
> means a site is malicious. A legitimate exchange has deposit pages and
> wallets too.

Unreachable results are excluded from scoring entirely — a site being down says
nothing about the technique that found it.

### Dynamic budget allocation

Usefulness moves each technique's share of the discovery budget, bounded on
both sides:

- **runaway winner** — capped at ×2.0, with a share of every campaign reserved
  for unproven techniques, so a lucky early technique cannot starve exploration
- **premature loser** — floored at ×0.35, and nothing moves at all below 8
  judgeable results, so one unlucky run cannot zero out a technique that could
  never then earn its way back

### The rest of the quality work

| Feature | What changed |
|---|---|
| **Multi-indicator convergence** | Independence now counts across *indicator types*, not just pivot types — a wallet path plus a certificate path fail for unrelated reasons; two wallet paths can both come from one copied page. Route quality multiplies the score. |
| **Discovery-path quality** | Scores the *route*: operator-supplied vs inherited indicator, breadth (how many sites carry it), depth, learned technique quality, downstream feedback. Learned factors contribute nothing until proven. |
| **Cross-campaign dedup** | One candidate however many campaigns find it — and rediscovery is kept as *corroboration*, bounded at +0.12 so it cannot dominate real evidence. Subdomains are never merged into their parent. |
| **Pivot noise suppression** | v0.5's measured retirement, now also fed by downstream results. |
| **Rate limiting** | Persistent per-service token bucket: rolling window, daily ceiling, and `Retry-After` obeyed exactly. Counters live in the database, so crash-looping is not a way past a daily limit. Refusal is normal, never an error, and nothing is ever worked around. |
| **Historical tracking** | A dated funnel snapshot, so "is this installation getting better?" is answerable. |

### Discovery Performance view

One page showing the whole funnel end to end: what each source and pivot
produced, how much survived triage, how much reached the platform, and what
investigators found afterwards — with each technique's earned budget
multiplier, the API budget state, and day-by-day history. Rows built on too
little evidence are flagged unmeasured and sorted below measured ones.

### v0.6 endpoints

```
GET  /api/performance/overview       funnel, sources, pivots, feedback, allocation, history
GET  /api/performance/feedback       downstream outcomes and attribution
POST /api/performance/feedback       record an outcome directly
POST /api/performance/poll           poll investigation context for outcomes
GET  /api/performance/allocation     each technique's earned budget, explained
GET  /api/performance/history        dated funnel history
POST /api/performance/snapshot       record today
GET  /api/performance/paths/<id>     every route to a site, scored
GET  /api/performance/dedup          cross-campaign corroboration
GET  /api/performance/rate_limits    API budgets and backoff state

GET  /api/integration/gaps           Contract Gap Report (JSON)
GET  /api/integration/gaps.md        the same, as a document
GET  /api/integration/jobs           claimed jobs and the enforced policy
POST /api/integration/jobs/claim     claim and run one job now
GET  /api/integration/platform_status the platform's own view of this module
```

### Configuration

```bash
export MAIN_PLATFORM_URL=https://platform.example
export MAIN_PLATFORM_TOKEN=...            # the site_finder key from MODULE_API_KEYS
export MAIN_PLATFORM_SITES_TOKEN=...      # only for a private hosted Site deployment
export SITE_FINDER_MODULE_VERSION=0.6.0
export DEEP_ANALYSIS_MODE=auto            # auto | handoff | local
```

### Production end-to-end tests

`tests/test_v4_integration_e2e.py` runs the **real** path: the vendored SDK
makes every call with its own headers, retry policy and error handling, and
only its urllib is pointed at a reference platform implementing the v4 route
handlers. There is no test-only client and no test-only wire format.

Covered: registration and capability advertisement · heartbeat and health ·
schema mismatch (409) · discovery → `site.discovered` → `INVESTIGATE_SITE` on
`site_investigator` · discovery paths surviving the handoff · wallets and
derived relationships as contract records · batch replay returning the original
result · changed observations updating rather than duplicating · conflicting
observations from two modules coexisting on one entity · a local guard refusing
an evidence-less relationship before it is sent · per-record dead-lettering
with the batch still `partial` · offline losing nothing · reconnect draining ·
transient failures absorbed by the SDK's own retry · unconfigured as a
supported state · interrupted sends requeued · restarts not double-delivering ·
held jobs handed back · job claim/run/complete · policy refusals · lease
exclusivity · permanent investigation identity · downstream feedback moving
budget · polling idempotency · and that nothing sent to the platform claims
shared ownership or maliciousness.

### What v0.6 still does not do

- No deep authenticated investigation, no browser wallet collection, no
  blockchain tracing. Those belong to Site Investigator, CryptoWalletLogger and
  Wallet Investigator.
- No credential guessing, no CAPTCHA or MFA bypass, no financial transactions —
  and a job asking for any of them is refused, not reinterpreted.
- No working around a rate limit. A `Retry-After` is obeyed as given.
- No conclusion about ownership, control or intent — not locally, and not in
  anything it sends.

---

## v0.7: Adaptive Discovery & Campaign Intelligence

Full detail in `docs/`: `V06-AUDIT-REPORT.md`, `V07-IMPLEMENTATION-REPORT.md`,
`CONTRACT-COMPLIANCE-REPORT.md`, `CONTRACT-GAP-REPORT.md`,
`DEPRECATED-RESPONSIBILITIES.md`, `MIGRATION-REPORT.md`.

### The v0.6 audit found nine defects — one release-blocking

v0.7 began with an audit of v0.6 for things that existed but did not work. All
nine are fixed with regression tests.

The critical one: **v0.6 could not upgrade an existing database.** Every table
is `CREATE TABLE IF NOT EXISTS`, which silently skips an existing table — so a
column added later never appeared and the first write crashed. Tests never
caught it because every test starts from an empty database.

The rest shared one shape: **built and never called, or computed and
discarded.** Budget allocation was announced and thrown away. The feedback loop
called a function with arguments that made it add zero. The platform link was
never started, so nothing was delivered automatically. See the audit report.

### What is new

| Feature | What it does |
|---|---|
| **Migrations** (`app/migrations.py`) | Checks the live schema rather than a version counter, so a half-upgraded database converges. Runs on startup. |
| **Saturation detection** (`saturation.py`) | Six measurements of branch exhaustion, with a closed vocabulary of stop reasons. Separates "the search finished" from "the budget ran out" — the difference decides whether running it again would find anything. Slows at two signals, stops at three. |
| **Novelty** (`novelty.py`) | A separate score from priority and confidence, because they disagree: a familiar candidate that just grew a wallet is the most valuable thing this module finds, and one blended score buries it. |
| **Candidate memory** (`candidate_memory.py`) | Remembers what it decided. The bar for reconsidering is **new evidence, not elapsed time**. The original decision is superseded, never overwritten. |
| **Why This Site Was Surfaced** (`explain.py`) | One object with origin, every path, convergence, corroboration, indicators, triage, both scores with their factors, decision history, downstream outcomes and technique performance. Every section labelled observed or derived. |
| **Campaign controls** | Pause / Resume / Stop After Current / Change Budget, honoured at wave boundaries so no stage is left half-done. |
| **Operational main screen** | Six panels — Active Campaigns, High-Priority Candidates, New Discoveries, Needs Review, Recent Handoffs, Discovery Performance — replacing six vanity stat tiles. Every candidate has a **Why?** button. |

### Item 1 is blocked, and nothing was invented to hide it

v0.7 asked for canonical support for non-routing observations, first-class
triage, dismissed/inconclusive candidates, push-based feedback and module
metrics. **Those are exactly the five gaps already reported against v4**, and
only the v4 contract is available here.

So v4 remains canonical, the documented in-contract workarounds stay, and no
private event or field was created. Supply the newer SDK and the migration is
mechanical — `contract.py` is a pure transcription and `translator.py` is the
only file mapping internal models onto wire records.

### Tests

**420 passing** in both pytest and the dependency-free runner, including 16
regression tests for the audit fixes and 29 for the new features. The audit
tests assert on *effects* — did the schema change, did the budget bind, did the
counter move — because assertions about return values are exactly what missed
these defects the first time.
