# Site Finder 2.1 · next-generation discovery

Site Finder's job is unchanged: bring the operator sites worth investigating that they would not
have found themselves. 2.1 changes how it spends its discovery effort. Instead of searching more
sources, it pivots from what it already knows, remembers what every search produced, stops
spending on routes that have gone dry, and skips anything the rest of the suite already holds.

The loop is **Discover → Evaluate → Pivot → Investigate → Learn → Find something new.**

Everything new lives in `app/v2/ng/` and is hooked into the existing engine at five points
(`leads`, `probe_keys`, `after_probe`, `after_decision`, delivery veto/annotation). Every hook is
wrapped so that a failure in the new layer falls back to the previous behaviour for that round.

## What is new

| Piece | File | What it does |
|---|---|---|
| Discovery memory | `ng/memory.py` | Tables `ng_external`, `ng_indicators`, `ng_lineage`, `ng_action_stats`, `ng_seeds`, `ng_watches`, `ng_rounds` (schema v5, additive). Records every search indicator and what it yielded, how each site was reached (route, parent, depth), the yield of every route, seeds requested by Main or Hunter, sites to watch, and the sites Main/Hunter already hold. |
| Page-build fingerprints | `ng/fingerprints.py` | From the page Site Finder already fetches: the operator's own build files (bundler hashes, excluding shared libraries such as jQuery or Bootstrap), the page title without the domain, and a 64-bit SimHash of the visible text for near-duplicate detection. |
| Public page search | `ng/pagesearch.py` | One urlscan.io-compatible search per chosen indicator (same build file, same title, same icon, same server). Plain public GET, no cookies; optional API key. Uses the same circuit breaker, budget and provider-health table as every other source. |
| Planner | `ng/planner.py` | Value-of-information planning. Each round it ranks candidate pivots from useful and eligible sites (build file, title, icon, server, certificate names, private name servers, name patterns) by expected new useful sites per unit of cost, learned per route (Beta posteriors with Thompson sampling for exploration). Routes below a value floor are not run; indicators that return nothing are cooled down (2ⁿ rounds) and retired after three empty or generic results; result sets that are too large are marked generic and never become leads. |
| Novelty | `ng/novelty.py` | Before a site takes one of your review slots: vetoes sites Main or Hunter already hold, near-duplicates of reviewed sites that add no new wallet (SimHash ≤ 4 bits), and mirrors within the same batch. Explains in plain words what is new ("may belong to an operation you have not seen yet", "loads the same build file as X, which you marked useful — similar build, not proof of the same operator", "reappeared after X went dark"). |
| Feedback | `ng/__init__.py`, `platform_bridge.py`, `outcomes.py` | Your USEFUL/SKIP decisions and Main's downstream outcomes credit the route and indicator that produced the site (delayed credit). Hunter's evidence gaps ("find more like these") arrive as `FIND_RELATED_SITES` jobs and become high-priority seeds. Main's `GET /api/v1/finder/context` tells Site Finder which sites are already held elsewhere. |
| Liveness & reappearance | `ng/planner.py` | Every few rounds, useful sites are re-resolved; a site that has gone dark is marked, and new sites sharing its build or title are flagged as a possible reappearance. |

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `SITE_FINDER_NG` | `1` | `0` switches the whole layer off; the engine behaves exactly as 2.0. |
| `SITE_FINDER_PAGE_SEARCH_URL` | `https://urlscan.io/api/v1/search/` | Page-search endpoint (urlscan-compatible). Empty disables page search; the other pivots still run. |
| `URLSCAN_API_KEY` | — | Optional. Sent as `API-Key`; raises urlscan's rate limits. |

`GET /api/v2/discovery/next-generation` (also linked from Advanced → "Pivot routes") shows the
routes, their yield, pending seeds and the last plan.

## Safety and wording

* Discovery stays passive and public: DNS, one unauthenticated GET of the public page (plus its
  public script bundle and icon), certificate transparency, RDAP, public page-search indexes. No
  logins, no form submission, no crawling behind authentication.
* Shared hosting, CDNs, templates, kits, support desks and payment addresses are reported as
  similarities. A single shared support/chat service no longer links two sites on its own in the
  campaign graph: it needs a second, independent category (a shared wallet still links by itself).
* Every lead keeps its lineage (route, parent, depth) so an analyst can see why a site was found.

## Upgrade and rollback

* The upgrade is automatic and additive (new `ng_*` tables, schema version 5). No existing table or
  row is changed.
* To switch off: `SITE_FINDER_NG=0`. To remove the new tables:
  `python -c "from app.v2.ng import memory; memory.rollback(confirm=True)"` (drops only `ng_*`).

## Benchmark

`python -m benchmark.ng_ab --seeds 1 2 3 4 5 6 --rounds 8 --difficulty 0.7 --compare <previous tree>`
runs the previous engine and this one on identical synthetic hard worlds (`benchmark/hard_world.py`:
operations invisible to certificate search, CDN-fronted sites, successor sites after takedowns,
vendor demo sites, shared libraries, sites Main already holds, Hunter gap requests). Add
`--scenario no_ct` for a certificate-transparency outage with no passive DNS. Results are in the
release report at the Main root (`NG_RELEASE_REPORT.md`).
