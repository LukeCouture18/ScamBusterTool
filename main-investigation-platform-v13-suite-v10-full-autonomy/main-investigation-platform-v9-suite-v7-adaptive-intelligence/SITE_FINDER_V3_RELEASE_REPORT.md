# Site Finder v3 · Discovery Pursuit & Campaign Hunting — release report

**Standard:** give Site Finder one clue and it hunts until it finds something genuinely new, or it
knows when to stop.

**Result:** on an independent adversarial benchmark with identical budgets, information and reviewer,
v3 finds **2.5× as many new useful sites** as v2.1 (hard difficulty: 16.6 vs 6.7 per run). Its
shortlist is more precise (0.93 vs 0.80), it reaches **8.7× as many sites 2+ pivots away** (4.5 vs
0.9), and it reports **zero false cross-operation relationships** (v2.1: 0.6 per run). The cost:
**+33% total requests** and about **3× as many dead-end searches**. Queries per useful site are at
parity. Both the wins and the losses are listed below.

Design detail: `integrations/site-finder-v07/docs/PURSUIT.md`.

---

## 1. What changed

### Site Finder: `app/v2/pursuit/` (new)

* **Pursuit engine.** Hunts replace the per-round pivot list. A hunt is a persistent, branching line
  of inquiry with its own branches, momentum and stop reason.
  * Branches are ranked by expected information gain: route yield learned on a decayed ledger with
    Thompson sampling, artifact tier, novelty, momentum, depth decay, an uncertainty bonus and cost.
  * Dead branches die (generic or junk results), dry ones are exhausted, and idle hunts are parked
    and later exhausted, each with a plain reason.
  * Chains are at most 5 pivots deep, and every discovered site keeps its lineage.
* **"How did you find this site?"** Every candidate carries a *Found this because…* line and a
  readable chain. Each step names the site, the public artifact that was followed and where it was
  searched, then gives the number of pivots and a caveat.
* **Fingerprint intelligence.** Artifacts come from the page and its public bundle: API hosts,
  support-chat endpoints, analytics IDs, contacts, linked domains, kit files, and DOM and sign-up
  form signatures. Each is tiered **generic → kit family → kit variant → deployment → possible
  operator reuse**, from how many sites share it, whether non-scam sites carry it, and how many
  unrelated wallet groups it spans.
* **Evidence rule.** Using the same kit never equals the same operator. Kit-level evidence never
  counts as independent evidence in the investigation graph. A link needs a shared wallet or two or
  more operator-level categories.
* **Campaign hunting.** `FIND_RELATED_SITES` from Main or Operation Hunter becomes a hunt titled
  *"Looking for new deployments related to Operation X"*, seeded with the operator artifacts Hunter
  sent. It produces candidates, not relationships.
* **Temporal.** Tracks each site's lifecycle (new → active → changed → gone → back).
  * A useful site going dark starts a capped reappearance watch with backoff (*"Watching for the x
    site family to reappear"*).
  * Three or more new scam sites sharing a kit artifact within two rounds start a wave hunt
    (*"Exploring a newly discovered pattern: …"*).
* **Memory v2.** The ledger remembers:
  * what was searched, with a result cache (never paid twice);
  * routes that went dry, junk and mirror-farm name stems;
  * saturated and generic artifacts;
  * what Main already holds (anchor probes of Main-held sites teach their artifacts);
  * delayed downstream value from Main outcomes.

  Route learning decays by 0.85 per round and gate priors are bounded, so it does not overfit to
  recent feedback.
* **Unknown-unknowns.** 20% of page-search and DNS allowance is reserved for exploration:
  scam-vocabulary title scans plus title templates learned from confirmed sites.
* **Candidate Intelligence v3.** Each candidate carries an explicit expected investigation value,
  the "new family" and "returned" flags and its hunt. Selection prefers diversity across hunts.
  Mirror copies (three or more shared deployment artifacts and no new wallet) do not take review
  slots. The same kit with different operator identifiers is treated as a distinct deployment and
  is still shown.
* **Finder ↔ Investigation.** When a site investigation completes in Main, its public artifacts
  become one deduplicated, depth-bounded hunt (`investigation:<site>`). A site already at maximum
  depth does not start one, so the loop cannot recurse without end.
* **Finder ↔ Hunter.** Hunter's evidence-gap proposals carry its operator-level indicators.
  Site Finder returns candidates with lineage and uncertainty. The same request twice repeats no
  work.

### Main

* Migration `0014_finder_hunts` (additive) and `POST /api/v1/finder/hunts`. Site Finder reports its
  hunts there.
* `lib/ops/finder-loop.ts`: turns a completed investigation's artifacts into Site Finder work.
  Sanitized, deduplicated by fingerprint.
* The executor passes artifacts and the operation name with related-site requests.
* **UI.** The five-tool shell is unchanged; no new primary navigation. Site Finder has three
  tabs: **Find sites | Investigate | Hunts**.
  * Candidates show *Found this because…* and a *How was it found?* chain.
  * Hunts show plain states and reasons, with internals behind *Details*.

### Operation Hunter (modest)

* Proposals to find related sites now carry operator-level artifacts (wallets, API hosts, analytics
  IDs, contacts), so Site Finder hunts from evidence instead of only domain names.

### Other tools

* Unchanged apart from the contract additions above, so the other tools did not consume the release.

---

## 2. Benchmark

### Independence

The benchmark (`bench-v3/`, shipped in `benchmark/pursuit/`) was written by a separate agent
**without reading the v3 engine**. Its README carries the independence statement, and it models
ground truth from its own world.

* It covers every requested condition: certificate search down or flaky, tracked operations' DNS
  pivots exhausted, CDN-fronted sites, copied templates used by unrelated operators, sites that
  disappear and return, naming mutation between waves, chains of 2–5+ pivots, strategy collapse
  mid-run, huge duplicate mirror farms, Main already holding the obvious candidates, and kit
  families never seen before.
* Both engines get identical budgets, starting knowledge, Hunter gap requests, investigation
  artifacts and simulated reviewer.
* Tuning used dev seeds **101–104** only. The numbers below are on **held-out seeds 1–6**:
  8 scenarios × 10 rounds, 48 paired runs per difficulty.
* The engine is deterministic, and the noise floor measured across hash seeds is 0 on every metric.

### Overall (mean per run)

| metric | normal v2.1 | normal v3 | **hard v2.1** | **hard v3** | brutal v2.1 | brutal v3 |
|---|---|---|---|---|---|---|
| New useful sites | 8.6 | **18.0** | 6.7 | **16.6** | 5.6 | **14.9** |
| Share of reachable useful found | 17% | **37%** | 14% | **36%** | 12% | **31%** |
| Shortlist precision | 0.89 | **0.95** | 0.80 | **0.93** | 0.75 | **0.92** |
| Useful sites ≥2 pivots away | 1.8 | **5.3** | 0.9 | **4.5** | 0.8 | **3.9** |
| Median pivots of useful sites | 1.1 | 1.1 | 1.0 | 1.0 | 1.0 | 1.1 |
| Distinct operations reached | 5.4 | **8.4** | 4.5 | **7.8** | 3.7 | **7.3** |
| Unknown-family sites | 1.5 | **2.6** | 1.1 | **2.6** | 1.0 | **2.3** |
| Reappearances caught | 0.1 | **0.7** | 0.0 | **0.8** | 0.0 | **0.8** |
| Downstream value | 28.5 | **60.7** | 21.3 | **52.7** | 16.6 | **46.2** |
| False cross-operation relationships | 0.9 | **0.0** | 0.6 | **0.0** | 0.8 | **0.0** |
| Requests per useful site | 418 | **219** | 534 | **241** | 582 | **258** |
| Queries per useful site | **11.1** | 12.3 | 12.9 | 12.8 | **13.1** | 13.6 |
| Total requests | **2819** | 3595 | **2580** | 3420 | **2521** | 3357 |
| Dead-end queries | **69** | 179 | **56** | 165 | **51** | 159 |
| Repeated queries | **34** | 40 | **25** | 36 | **24** | 37 |
| Requests spent on mirrors | **103** | 130 | 122 | **118** | 140 | **112** |
| Junk page fetches | **208** | 224 | **170** | 197 | **172** | 197 |
| Round of first useful site | 0.4 | **0.0** | 0.9 | **0.1** | 1.0 | **0.2** |
| Requests to first useful site | 357 | **274** | 517 | **315** | 532 | **344** |

Useful sites found by only one engine (same seed and scenario, all 48 runs):

| | normal | hard | brutal |
|---|---|---|---|
| only v2.1 | 129 | 83 | 63 |
| only v3 | 581 | 557 | 512 |

### Where v3 wins

Every scenario at every difficulty, on:

* new useful sites;
* precision;
* multi-hop discoveries;
* operations reached;
* unknown families;
* reappearances;
* downstream value;
* requests per useful site;
* false relationships.

The margin is largest where v2.1's pivots fail: `dark_family` (hard: 17.5 vs 6.8, unknown-family
5.0 vs 2.3), `migration` (19.3 vs 7.3, reappearances 1.8 vs 0), `cert_blackout` (18.7 vs 7.2) and
`collapse` (14.8 vs 6.0). The `mirror_flood` precision problem is fixed: 0.87 vs 0.64 at hard and
0.80 vs 0.45 at brutal, where v2.1 reviewed mirror after mirror.

### Where v3 loses

* **Search volume.** Dead-end queries are about 3× v2.1's in every scenario, and repeated queries
  are +20–100%. Pursuing branches means trying many that turn out empty. The result cache and caps
  stop paying twice for one search, but "repeated" in this benchmark also counts the same value
  searched on a different route.
* **Total requests: +27% to +33%.** Each useful site costs about half the requests v2.1 needs, but
  the absolute spend per round is higher. v3 uses more of the allowance because it has more
  worthwhile branches.
* **Queries per useful site.** Worse at normal (12.3 vs 11.1) and brutal (13.6 vs 13.1), and at
  parity at hard. Per scenario, v3 is clearly worse in `cert_blackout` (hard 10.7 vs 6.9): v2.1's
  few successful searches there are very efficient.
* **Junk fetches.** +8% to +16%, and more mirror requests in `copycat`, `collapse` and `migration`.
  The mirror check needs the page first.
* **Median pivots are unchanged at about 1.** Most useful sites in these worlds are one pivot away.
  v3's multi-hop gain shows in the count of ≥2-pivot finds, not the median.
* **Per-run losses.** v3 found fewer useful sites than v2.1 in 3 of 144 paired runs:
  * normal, seed 1, `mirror_flood`: 9 vs 10;
  * hard, seed 4, `migration`: 7 vs 9;
  * hard, seed 6, `mirror_flood`: 11 vs 13.

  It tied in 4 more.
* **Coverage is still partial.** Even at normal difficulty v3 finds 37% of the reachable useful
  sites in 10 rounds.

### Caveats

* The benchmark is synthetic. It is adversarial and independent, but it is a model of the internet.
  Real-world yield depends on public page-search and passive-DNS coverage.
* "False relationships" includes the evidence-rule change in the investigation graph. That rule is
  part of this release but is not the pursuit engine itself.

---

## 3. Performance

Traced discovery round (same fixture as 2.1):

| | v2.1 | v3 |
|---|---|---|
| SQLite connections | 41 | **41** (kept) |
| Statements | 7708 | 8616 |
| Commits | 2562 | 2963 |

* The extra statements come from the ledger (branch, result and artifact writes). In-memory caches
  of lead and seed domains removed about 190 per round.
* A benchmark run takes about 11 s per 10 rounds (v2.1: 5 s), all in-process.

---

## 4. Tests and gate

| Area | Result |
|---|---|
| Site Finder full suite | **548 / 548** |
| Pursuit tests | 18 tests: multi-hop lineage, depth bounds, dead branches, parking with reasons, deduplicated requests, platform artifacts, mirror vs distinct deployment, farm memory, bounded gate prior, reappearance, exploration, restart persistence, rollback, the off switch, delayed value, the hunts view and endpoint, and a long-running Finder → Investigation → Finder loop on the hard world that stays bounded without rediscovery |
| Main unit and migration tests | 31 / 31 (new: 0014 additive, required by the schema gate, rollback restores the exact schema) |
| Operation Hunter | 45 / 45, typecheck clean |
| Joined loops (`loops` group) | Finder → Main → Hunter → Finder and Finder → Investigation Mode → Finder, run as separate processes with restarts. Both produce new hunts and candidates; repeating the loop adds no duplicate work |
| Unified gate (`node scripts/run-tests.mjs all`) | Every group passes except `startup:modules` steps 2–4 (see below) |
| Browser UI checks (`suite`) | 39 checks: Find sites / Investigate / Hunts tabs, the *Found this because* line and chain, internals under Details |

**`startup:modules` steps 2–4** start the Site Investigator, Wallet Investigator and Form
Submitter servers. They need packages this sandbox cannot install (`fastapi`, `express`, the real
`sql.js`). They fail identically on the untouched v2.1 baseline, and v3 does not change those
modules. On a normal machine with `npm install` and `pip install -r requirements.txt` done, they
run as before.

**Two test changes, both extensions:**

* `wallet-key-migration.test.mjs` now applies 0013 alone, because 0014 exists.
* The 0012 schema-gate test applies the later ordered migrations before asserting the gate passes.

A dedicated 0014 test was added. Two investigation-graph fixtures were moved to operator-level
evidence so they keep testing what they were written for under the new evidence rule. New tests
show that kit-level evidence alone no longer links operators.

---

## 5. Preserved

* The five-tool shell, Investigation Mode and the Main feedback feed.
* Migration 0013 and every earlier migration.
* 2.1 performance (41 connections), provenance, contracts (`sdk/contracts/v6.json`) and launcher
  paths (`integrations/`, `scripts/start-production.mjs`, Hunter as a sibling folder).
* Switches: `SITE_FINDER_PURSUIT=0` returns to the 2.1 planner and `SITE_FINDER_NG=0` to 2.0.
  Rollback drops only the `pu_*` tables, and dropping `finder_hunts` restores Main's v2.1 schema.

## 6. Safety

Unchanged boundary: public and passive, or already-authorized normal investigation behaviour only.
Discovery uses DNS, passive DNS, certificate transparency, public page-search indexes, and one
unauthenticated GET of a public page and its public bundle. There are no credential attacks,
authentication bypass, CAPTCHA or MFA bypass, exploitation, destructive actions or financial
activity. Shared infrastructure and kits are never treated as proof of ownership, and the UI says
so on every chain.

## 7. Limitations

* The Next.js production build and the full TypeScript typecheck of Main were not run: this sandbox
  lacks the npm packages. The changed routes and components are exercised through the esbuild-based
  test harness and the browser suite.
* Hunt titles and chains are in English only, like the rest of the UI.
* The benchmark is synthetic (see Caveats in section 2).
