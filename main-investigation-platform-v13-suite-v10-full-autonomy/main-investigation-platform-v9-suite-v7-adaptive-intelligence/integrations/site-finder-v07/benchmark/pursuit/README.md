# Pursuit benchmark (bench-v3)

> Shipped with Site Finder 3.0. From `integrations/site-finder-v07`:
> `python3 benchmark/pursuit/pursuit_bench.py --tree <v2.1 tree> --compare . --seeds 1 2 3 4 5 6 --rounds 10 --scenario all --difficulty hard`.
> The release numbers are in `results/` (held-out seeds 1–6; tuning used seeds 101–104).

An adversarial, independent benchmark for the Site Finder discovery engine.

**Independence statement.** This benchmark was written without reading the new
engine's internals. Nothing under `app/v2/ng/`, `app/v2/planner*`, any `ng_*` or
`*pursuit*` engine file, `benchmark/ng_ab.py` or `benchmark/hard_world.py` was
opened. The only sources consulted were the simulation substrate
(`benchmark/world.py`, `benchmark/simnet.py`, `benchmark/run.py`) and the
signatures and bodies of the public entry points (`engine.DEFAULTS`,
`engine.run_round`, `engine.configure_for_benchmark`, `platform_bridge.pull_context`,
`platform_bridge.run_related_job`, `outcomes.apply_outcome`, `inbox`, `netio` and
the `store` schema). The request formats the engine sends to page search and
passive DNS were learned by logging requests in a smoke run, not by reading
engine code.

## Files

| file | purpose |
|---|---|
| `pursuit_world.py` | `PursuitWorld(World)`: the adversarial world and its ground truth |
| `pursuit_bench.py` | runner, simulated reviewer, metrics, tree comparison, report |
| `README.md` | this file |

Nothing is written inside either engine tree. Each run uses a fresh temporary
SQLite directory (via the tree's own `benchmark.run._fresh_finder_state`).

## How to run

```
python3 pursuit_bench.py --tree /home/claude/v3/base/integrations/site-finder-v07 \
    --compare /home/claude/v3/main/integrations/site-finder-v07 \
    --seeds 1 2 3 4 5 6 --rounds 10 --scenario all --difficulty hard --json out.json
```

| option | meaning |
|---|---|
| `--tree PATH` | engine tree to run |
| `--compare PATH` | optional second tree. Every run of every tree is its own subprocess, so imports never mix |
| `--labels A B` | names for the two trees (default: first differing path component, e.g. `base` / `main`) |
| `--seeds ...` | world seeds (default 1..6) |
| `--rounds N` | rounds per run (default 10) |
| `--scenario all\|NAME ...` | scenarios (see below) |
| `--difficulty normal\|hard\|brutal` | default `hard` |
| `--quick` | 2 seeds, 4 scenarios (mixed, cdn_maze, copycat, mirror_flood), 8 rounds |
| `--jobs N` | parallel subprocesses (default: min(4, CPUs)) |
| `--no-noise-floor` | skip the repeated runs with different `PYTHONHASHSEED` |
| `--json OUT` | full results: summary plus every run (verdicts, traces, metrics) |

A run takes about 3–6 s. The full default (6 seeds × 8 scenarios × 10 rounds) is
48 runs per tree, roughly 2–3 minutes per tree on 2 CPUs.

## Protocol (identical for every tree)

Budgets are set through `engine.DEFAULTS` (so they also apply to the rounds that
`run_related_job` starts): `fetch_budget 60, dns_budget 220, crtsh_budget 6,
rdap_budget 30, max_deliver 5`. Passive DNS is enabled
(`netio.PASSIVE_DNS_URL = https://passivedns.example.test`).

Each round:
1. `world.advance()` (from round 1 onward).
2. `platform_bridge.pull_context(stub)`: the stub client (`configured=True`, `sdk.finder_context(since, limit)`
   with an integer cursor) returns the sites Main holds, meaning the world's Main-known set up to this round plus every
   site the reviewer confirmed in earlier rounds.
3. Delayed downstream outcomes (`outcomes.apply_outcome(..., basis="observed")`) arrive 2–3 rounds after a site
   was marked useful: `dead_site` if the site is gone by then, `low_evidence` for "hollow" sites (useful-looking,
   nothing behind them), `wallet_evidence` if it contributes wallets not reported before, otherwise
   `meaningful_evidence` or `investigation_completed`.
4. Hunter gap requests at fixed rounds 1, 4, 7: `run_related_job` with `source="hunter"` and seeds that are
   Main-known sites of a tracked operation. When that operation's sites have died, the reason says it moved.
5. Investigation artifacts: if sites were marked useful in the previous round, one `run_related_job` with
   `source="investigation"`, those sites as domain/seeds, and their true public artifacts
   (`asset`, `title`, `favicon`, `support_host`, `api_host`, `analytics_id`, `wallet`, `linked_domain`).
6. `engine.run_round(fetch_budget=60, max_deliver=5)`.
7. The simulated reviewer takes up to 5 candidates from `inbox.next_candidate()`. It marks a candidate useful only
   when ground truth says the site is a live scam, and the site is new: not Main-known, not already reviewed, and
   not a mirror of an original that was already reviewed or is Main-known (unless it adds new wallets). Otherwise it
   skips with `duplicate`, `dead_or_parked`, `not_a_scam` or `not_useful`.

## World model

Built on the substrate `World`: DNS, HTTP, crt.sh, RDAP, feed and passive DNS
answers, plus all ordinary noise (parked, for sale, dead, placeholder,
coming-soon, legit crypto, informational/reviews/monitors, PR, vendor script
demos, non-crypto, generic). The substrate's own positive kits are removed, and
brand typosquats are background (defensively owned) rather than targets.
Reviews, monitors and PR pages only mention sites Main already knows.

The scam ecosystem:

* **Families** (scam kits): page template class and variant, kit bundle
  (fingerprintable `chunk-vendors.<hash>.js` or a generic name shared with the
  whole web), default favicon, title template. Vendor demo sites carry a
  family's kit bundle and favicon too.
* **Operations** (operators): belong to one family. Each has wallets and up to
  three deployment **waves**. Each wave has its own naming stem and TLD pool,
  brand/title, build file (`/assets/index-NNNNNNNN.js`), favicon, support chat
  host, API backend and analytics id. Consecutive waves share exactly one
  "bridge" artifact, and only some sites of the new wave carry it.
* **Sites**: each exposes a random subset of its wave's artifacts in public HTML
  (title, favicon, inline `__CFG__` with API/support hosts, gtag id, script tags)
  and in its build bundle (`appConfig` with backend, support and backup-domain
  list). Backend and support hosts resolve as operator infrastructure (not
  scams).
* **Page search** (`https://urlscan.io/api/v1/search/?q=...&size=N`): answers by
  field: `filename:`, `hash:` (favicon sha256, prefix match), `page.title:`
  (phrase), `domain:`/`page.domain:` (the site or a host it contacts),
  `page.ip:`/`ip:`, and free text (analytics ids). Only indexed ("scanned") sites
  appear, with a 0–1 round lag. Results are capped at 100, newest first, and
  carry true totals. Generic values (jQuery builds, `app.js`, `main.js`, short
  titles, CDN IPs, short text) return totals of 5,000–250,000 with unrelated
  sites in the results.
* **Passive DNS**: the substrate's (names seen on an IP or NS so far).

Ground truth per scam domain (`world.gt[domain]`): family, variant, operation,
role (member, chain hop, returned, mirror, mirror primary), useful, wallets,
downstream value, born round, death round, `returned_from`, `mirror_of`, hollow,
unknown-family flag, public artifacts, and **`min_pivots`**.

### Minimum pivots

This is computed from the world's own pivot graph before the run. An edge A→B
exists when an artifact observable on A (title, favicon hash, build or
fingerprintable kit file, support/API host, analytics id, dedicated IP or NS,
naming stem, certificate name or co-listed SAN, backup link in the bundle) can
be searched to return B. That requires B to be indexed for that field, the
source to be up at the time (certificate search or filename indexing may be
down), and the artifact not to be generic (more than 150 matching sites). Main-known
round-0 sites and gap seeds are at distance 0. Exploration entry points (keyword-named
sites findable by certificate keyword search, community-feed reports) are at
distance 1. BFS gives each site's minimum number of public pivots, or
"unreachable". The graph ignores time windows (a site that dies before its
neighbour is born is still counted as a link), so `min_pivots` is a lower bound.

### Hard conditions (every world mixes them; scenarios emphasise some)

| condition | how it is modelled |
|---|---|
| certificate search unavailable | `crt` = flaky (25% 502/timeout) or down for the whole run, or down from round k (`collapse`) |
| obvious DNS pivots exhausted | tracked operations keep their old dedicated IP/NS, which host only Main-known sites plus 25–40 parked/placeholder/dead junk names. New sites are elsewhere |
| sites behind shared CDN | 70–97% of operation sites on the substrate's CDN IPs and Cloudflare NS (thousands of neighbours) |
| copied kits | several unrelated operations use the same family (kit bundle, template, default favicon, title template); vendor demos use the kit too |
| disappear and return | sites of tracked operations die at round k and return 1–2 rounds later on a new name, IP, favicon and build, carrying some wallets and support host, sometimes the analytics id or title |
| naming mutation | each operation has up to three waves with new stems, TLD pools and brands |
| deep chains (2–5 pivots) | chain operations: each hop shares exactly one artifact (build file → support host → analytics id → favicon → backup link → API host → title) with the previous hop and nothing else; CDN-hosted, stem-free names |
| strategy collapse | from round k: page-search `filename:` stops matching, the feed returns nothing, crt.sh fails, or operators randomise favicons |
| mirror floods | 75–525 identical clones per cluster (same page, wallets, favicon, title, build, dedicated IPs, numbered stem), part of them reported to the feed. Half the clusters copy an original Main already knows |
| Main knows the obvious | tracked operations' first sites and 55–95% of all "obvious" sites (keyword names, feed reports) are Main-known, the latter a round after birth |
| unknown families | families with no seed, Main-known site or gap request. Entry only through exploration (keyword name or feed), then pivots |
| noise | substrate noise, generic JS libraries on all kinds of pages, hollow scams (`low_evidence`), scam infrastructure hosts |

### Scenarios

| name | emphasis |
|---|---|
| `mixed` | a bit of everything (baseline configuration) |
| `cert_blackout` | crt.sh down for the whole run, 80% CDN, feed dries up at round 4 |
| `cdn_maze` | 92% CDN, four deep-chain operations with 3–5 hops, more DNS junk |
| `copycat` | 3 families shared by about 10 unrelated operations |
| `migration` | five migrating operations, favicons randomised from round 4 |
| `mirror_flood` | two mirror clusters (350 and 220 at `hard`), Main knows 90% of obvious sites |
| `collapse` | filename search and feed die at round 3, crt.sh dies at round 5 |
| `dark_family` | three unknown families, Main tracks fewer operations but knows 85% of obvious sites |

Difficulty `normal` lowers the CDN share and Main's knowledge, halves the
mirrors and shortens chains. `brutal` does the opposite and adds one extra
chain operation.

## Metrics (per run; aggregated per tree and per scenario)

| column | meaning |
|---|---|
| `useful` | new useful sites confirmed by the reviewer |
| `found%` | useful / reachable useful units in that world |
| `pool` | useful new units among candidates the engine judged eligible (`v2_candidates.status` in ready, presented, useful, delivered), whether or not they were reviewed |
| `prec` | shortlist precision = useful / review slots used |
| `multihop`, `medpiv` | useful sites with ground-truth `min_pivots` ≥ 2; median `min_pivots` of useful sites |
| `ops`, `unkfam`, `return` | distinct operations among useful sites; unknown-family finds; returned (migrated) domains found |
| `value` | sum of ground-truth downstream value of sites marked useful |
| `requests`, `req/use`, `q/use` | all simulated requests (http, dns, crtsh, rdap, feed, page_search, passive_dns); per useful find; search queries (crtsh + page search + passive DNS) per useful find |
| `deadQ` | search queries that exposed no domain the engine had not seen before |
| `repeatQ` | byte-identical search queries repeated within the run |
| `mirrorReq` | HTTP and DNS requests spent on mirror clones |
| `junkGET` | HTTP requests to anything that is not a scam site |
| `falseRel` | edges in `ig_relationships` joining sites of different operations (also recorded: edges touching non-scam sites, same-operation edges) |
| `1stR`, `1stReq` | round and cumulative request count of the first useful confirmation |

With `--compare`, the report also shows useful sites found by only one tree
(same seed and scenario), both among reviewed sites and over each engine's
eligible pool. It also lists, per scenario, the metrics where each tree is
better by more than the noise floor. The noise floor reruns the first
seed and scenario with `PYTHONHASHSEED` 1 and 2 (plus the normal 0 run) and
reports the spread per metric. The JSON holds every verdict (with operation and
`min_pivots`), per-round traces, skip reasons, outcomes sent and engine errors.
An engine exception is recorded as a result and does not stop the run.

## Caveats

* `min_pivots` ignores time windows (see above), so it is a lower bound.
* The review budget (5 per round) caps confirmations at 5 × rounds. The `pool`
  column shows what an engine found beyond that cap.
* Page-search semantics are simplified: exact or phrase match per field, AND
  between fields.
* The runner forces `max_deliver=5` and `requested=5` for related jobs, so
  every tree gets the same inbox pressure.
