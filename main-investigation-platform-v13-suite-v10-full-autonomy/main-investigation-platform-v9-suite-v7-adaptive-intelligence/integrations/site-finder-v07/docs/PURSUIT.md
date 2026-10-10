# Site Finder v3 · Discovery Pursuit & Campaign Hunting

Give Site Finder one clue and it keeps hunting until it finds something genuinely new, or it knows
when to stop. v3 replaces the 2.1 per-round pivot list with **hunts**: persistent, branching lines of
inquiry that remember what they tried, follow the promising branches deeper, and give up on the dead
ones with a reason.

The loop is **Discover → Understand the clue → Generate pivots → Pursue branches → Evaluate → Learn →
Abandon weak → Deepen strong → Surface new.**

Everything new lives in `app/v2/pursuit/` and sits on the 2.1 next-generation layer (`app/v2/ng/`),
which still supplies page search, novelty checks, and the gap and liveness logic. Every hook is wrapped.
If the pursuit layer fails in a round, that round falls back to the 2.1 planner.

## Pieces

| Piece | File | What it does |
|---|---|---|
| Ledger | `pursuit/ledger.py` | Stores everything in `pu_*` tables (schema v6, additive): hunts, branches, a result cache, artifacts per site, a decayed route ledger, each site's lifecycle, and the lineage node that says how each site was reached. |
| Artifacts & tiers | `pursuit/artifacts.py` | Reads a page Site Finder already fetched (and its public bundle) for API hosts, support chat endpoints, analytics IDs, Telegram/WhatsApp contacts, linked domains, hashed kit files, a DOM signature and a sign-up form signature. Each artifact is then tiered: **generic** technology, common scam-kit **family**, specific kit **variant**, **deployment**-specific, or possible **operator** reuse. The tier comes from how many sites share the artifact, whether non-scam sites carry it, and how many unrelated wallet groups it spans. |
| Planner | `pursuit/planner.py` | Ranks open branches by expected information gain: route yield from Thompson sampling on a decayed ledger, tier value, the hunt's momentum, novelty, a depth decay, an uncertainty bonus and cost. Branches below a value floor wait. 20% of the page-search and DNS allowance is reserved for exploration (unknown families). |
| Temporal | `pursuit/temporal.py` | Tracks each site's lifecycle (new → active → changed → gone → back). A site going dark starts a capped reappearance watch (backoff 3/6/12 rounds). Three or more new scam sites sharing a kit artifact within two rounds start a **wave** hunt. |
| Explanations | `pursuit/explain.py` | Answers "How did you find this site?" with the origin of the chain ("Found this because you marked x useful"). Every step names the site, the public artifact and where it was searched, followed by the number of pivots and a plain caveat. |
| Hooks | `pursuit/__init__.py` | `leads`, `observe`, `observe_gated`, `gate_prior`, `filter_leads`, `mirror_of`, `distinct_deployment`, `request`, `annotate`, `on_decision`, `on_outcome`, `hunts_view`, `status`. |

## Hunt kinds

| Kind | Started by | Title shown in Main |
|---|---|---|
| clue | a site you marked useful | "Following up on x" |
| campaign | Main or Operation Hunter asking for more sites like an operation (`FIND_RELATED_SITES`) | "Looking for new deployments related to Operation X" |
| investigation | public artifacts returned by an investigation in Main | "Following what the investigation of x found" |
| reappearance | a useful site going dark | "Watching for this site family to reappear" |
| wave | a burst of new sites sharing a kit artifact | "Exploring a newly discovered pattern" |
| lead / anchor | a promising unreviewed site; a site Main already holds (read once for its artifacts) | — |
| explore | the exploration reserve (scam-vocabulary page titles, learned title templates) | "Exploring for new site families" |

## Stop rules and bounds

* A branch that returns a generic result set (more than 60 sites) is dead. A branch that returns
  nothing new is exhausted. Results are cached and never paid for twice. Re-searches of confirmed
  operator identifiers are limited to one every 3 rounds and 4 in total.
* A hunt with no new eligible site for 3 rounds is **parked** with a reason, and later **exhausted**.
  Hunts that are merely outranked wait without being counted as failures, and they wake only when
  there is room (at most 40 active hunts).
* Chains are at most 5 pivots deep. Investigation requests on a site that is already at maximum depth
  do not start a hunt, so the Finder → Investigation → Finder loop cannot recurse without end.
  Repeating a request repeats no work: hunt ids are `campaign:<operation>` and
  `investigation:<seed>`, and branches are unique per (hunt, route, value).
* Mirror farms are remembered by name stem. A copy of a reviewed site takes no review slot when it
  shares at least 3 deployment artifacts and adds no new wallet. A site on the same kit with
  different operator identifiers (chat, API host, analytics, contact) is a distinct deployment and
  is still shown.

## Evidence rule (Main relationships)

Similarity is not ownership. Kit-level evidence (same kit, build, icon, layout or title, and a shared
support widget) never counts as independent evidence of the same operator. The investigation graph
(`app/v2/intelligence.py`) links two sites as one operator only on a shared wallet or on **two or
more** operator-level categories. Campaign hunts therefore bring *candidates* to Main; they do not
add relationships.

## Settings and endpoints

| Variable | Default | Meaning |
|---|---|---|
| `SITE_FINDER_PURSUIT` | `1` | `0` returns to the 2.1 pivot planner. The `pu_*` tables stay in place but go unused. |
| `SITE_FINDER_NG` | `1` | `0` switches off the whole next-generation layer, pursuit included. |

* `GET /api/v2/discovery/hunts` returns every hunt, its state and stop reason, the route ledger and
  the last plan.
* Site Finder reports its hunts to Main (`POST /api/v1/finder/hunts`, migration `0014_finder_hunts`).
  Main shows them under **Site Finder → Hunts** and keeps the internals under *Details*.

**Rollback:** `python -c "from app.v2.pursuit import ledger; ledger.rollback()"` drops only the
`pu_*` tables. Main's `finder_hunts` table is additive; dropping it restores the v2.1 schema exactly
(covered in `tests/v5-hunter.test.mjs`).

## Safety

Every step is public and passive: DNS, passive DNS, certificate transparency, public page-search
indexes, and one unauthenticated GET of a public page and its public script bundle. There are no
logins, form submissions, credential attacks, authentication/CAPTCHA/MFA bypass, exploitation,
destructive actions or financial activity. Everything v3 learns from Main and Investigation Mode
comes from artifacts those already-authorized workflows produced.
