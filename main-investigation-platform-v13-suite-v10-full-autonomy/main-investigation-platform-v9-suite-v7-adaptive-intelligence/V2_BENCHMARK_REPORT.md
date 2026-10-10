# v1 vs v2 discovery benchmark

**Question:** of the sites each pipeline puts in front of you, how many are worth checking by hand?

## Headline

| Split | v1 precision | v2 precision | Useful sites, v1 → v2 | Noise v1 showed you |
| --- | ---: | ---: | ---: | --- |
| **eval** (held out) | 40.6% (39/96) | **99.1%** (447/451) | 39 → 447 | parked 26, brand-owned redirects 18, articles/reviews 8, legit crypto 3, duplicates 2 |
| **stress** (built to break v2) | 32.5% (25/77) | **100.0%** (347/347) | 25 → 347 | parked 28, redirects 13, articles/reviews 9, legit crypto 2 |
| dev (used while building) | 40.8% (49/120) | **98.3%** (400/407) | 49 → 400 | parked 27, redirects 18, articles/reviews 14, duplicates 5, legit 4, for-sale 3 |

With **v1's crt.sh budget** (one query per round, which is what v1 actually makes), v2 on eval surfaced **182 sites, all useful (100%)**. It used 1,371 HTTP requests against v1's 4,096. The precision comes from the gates and evidence rules, not from extra queries.

v2's residual noise is almost entirely *duplicates*: a clone of a kit already shown whose wallet was not visible on its public page.

## How it was run

* **Both pipelines run their real code.** v1 is the unmodified v0.7 path exactly as `runner.py` drives it (`DiscoveryEngine().run()` → `run_collectors()` → `run_triage_stage(limit=200)`). v2 is `app/v2/engine.run_round()`. Only the network is replaced: `requests.get` and `socket.gethostbyname` are routed into a simulated internet (`benchmark/world.py`, `benchmark/simnet.py`), which also serves crt.sh JSON, RDAP and a public scam-report feed.
* **What "surfaced" means.** v1 has no inbox, so its surfaced set is everything that clears its triage quality gate (those become "queued", high-priority and offered to the platform). v2's is exactly what its inbox shows.
* **What "useful" means.** A live crypto scam at the time it is shown, and not a duplicate of something already shown: same registrable domain, an infrastructure subdomain (mail./cpanel.), or a clone of an already-shown kit without new wallets. A clone with new wallets counts as useful.
* **Your decisions.** For v2, a simulated you answers each inbox item with the ground truth and a **3% error rate**. v1 has no channel for decisions.
* **World.** Each round is one day. New registrations arrive each day in realistic proportions: roughly 1 in 11 new crypto-flavoured domains is a live scam (about 1 in 20 of all new registrations in the world). The rest are parked, for sale, dead, server defaults, suspended, coming-soon, brand-owned typo redirects, legitimate crypto, news, reviews, HYIP monitors, and non-crypto businesses matching CT keywords (investment, trading, exchange). cPanel AutoSSL certificates carry mail./cpanel./webmail./autodiscover. SANs. CDN and shared-hosting IPs are shared by unrelated sites. Scam kits clone across domains, sometimes with the same wallet. Pig-butchering apps are often empty SPA shells whose UI strings sit in the JS bundle. Parked domains sometimes go live, and live scams die.
* **Splits.** `dev`: template variants 0–1 and one name vocabulary; v2 was developed against it. `eval`: variants 2–3 and a different vocabulary, not used for tuning. `stress`: all variants plus cases designed to fool v2 — paid press releases repeating a scam's promises, white-label exchange-script vendor demos, parking pages from unknown providers, and "stealth" scams that show almost nothing before login.
* **Budgets.** Both pipelines had about 200 HTTP requests per round. v2 additionally uses RDAP (≈18 lookups per round on average) and, by default, 12 crt.sh queries per round against v1's effective 1; see the fairness run above.

## Results

### Split: `eval` — 5 seeds × 6 rounds

| Pipeline | Surfaced | Useful | Precision | Per-seed precision | What the noise was |
| --- | ---: | ---: | ---: | --- | --- |
| v1 (v0.7 pipeline) | 96 | 39 | **40.6%** | 0.27, 0.56, 0.42, 0.39, 0.27 | parked 26, brand_owned_redirect 18, informational 8, legit_crypto 3, duplicate 2 |
| v2 | 451 | 447 | **99.1%** | 1.00, 0.99, 0.99, 0.99, 0.99 | duplicate 4 |
| v2, decisions withheld | 462 | 456 | **98.7%** | 0.98, 0.98, 1.00, 0.99, 0.99 | duplicate 5, dead 1 |

Per round (all seeds pooled):

| Round | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v1 (v0.7 pipeline) useful/surfaced | 3/41 (7%) | 8/12 (67%) | 5/9 (56%) | 7/12 (58%) | 7/10 (70%) | 9/12 (75%) |
| v2 useful/surfaced | 73/73 (100%) | 80/81 (99%) | 87/88 (99%) | 64/64 (100%) | 77/78 (99%) | 66/67 (99%) |

Requests made (all seeds): v1: crtsh 30, dns 12300, feed 30, http 4096; v2: crtsh 360, dns 12670, feed 30, http 4117, rdap 554

### Split: `stress` — 5 seeds × 6 rounds

| Pipeline | Surfaced | Useful | Precision | Per-seed precision | What the noise was |
| --- | ---: | ---: | ---: | --- | --- |
| v1 (v0.7 pipeline) | 77 | 25 | **32.5%** | 0.46, 0.28, 0.23, 0.47, 0.21 | parked 28, brand_owned_redirect 13, informational 9, legit_crypto 2 |
| v2 | 347 | 347 | **100.0%** | 1.00, 1.00, 1.00, 1.00, 1.00 | none |
| v2, decisions withheld | 340 | 339 | **99.7%** | 1.00, 1.00, 1.00, 0.99, 1.00 | dead 1 |

Per round (all seeds pooled):

| Round | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v1 (v0.7 pipeline) useful/surfaced | 3/30 (10%) | 5/12 (42%) | 3/8 (38%) | 6/11 (55%) | 6/10 (60%) | 2/6 (33%) |
| v2 useful/surfaced | 55/55 (100%) | 51/51 (100%) | 68/68 (100%) | 74/74 (100%) | 50/50 (100%) | 49/49 (100%) |

Requests made (all seeds): v1: crtsh 30, dns 12114, feed 30, http 4174; v2: crtsh 360, dns 12998, feed 30, http 4150, rdap 484

### Split: `dev` — 5 seeds × 6 rounds

| Pipeline | Surfaced | Useful | Precision | Per-seed precision | What the noise was |
| --- | ---: | ---: | ---: | --- | --- |
| v1 (v0.7 pipeline) | 120 | 49 | **40.8%** | 0.42, 0.28, 0.46, 0.37, 0.60 | parked 27, brand_owned_redirect 18, informational 14, duplicate 5, legit_crypto 4, for_sale 3 |
| v2 | 407 | 400 | **98.3%** | 0.98, 0.97, 0.99, 1.00, 0.97 | duplicate 6, dead 1 |
| v2, decisions withheld | 418 | 413 | **98.8%** | 0.99, 0.99, 0.99, 1.00, 0.97 | duplicate 5 |

Per round (all seeds pooled):

| Round | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v1 (v0.7 pipeline) useful/surfaced | 8/49 (16%) | 7/11 (64%) | 7/14 (50%) | 8/15 (53%) | 10/15 (67%) | 9/16 (56%) |
| v2 useful/surfaced | 77/77 (100%) | 59/60 (98%) | 63/64 (98%) | 67/68 (99%) | 65/68 (96%) | 69/70 (99%) |

Requests made (all seeds): v1: crtsh 30, dns 12300, feed 30, http 4113; v2: crtsh 360, dns 12572, feed 30, http 3999, rdap 527

## Ablation: does learning from your decisions help?

"v2, decisions withheld" runs the same engine without your USEFUL/SKIP feedback. In this simulation the two are statistically indistinguishable on precision. The gates and evidence rules carry precision, and learning is deliberately prevented from lowering it: it may demote freely but can only nudge a candidate upward, and delivery is decided on the page's own evidence.

Building this ablation caught two design errors, both fixed and covered by tests:

1. **Every skip was treated as "not a scam".** Duplicates therefore penalised real scam signals and hid whole kits. Skip reasons now carry different weight.
2. **Learning could *promote* weak pages.** "Found by the route that usually works" plus "has the signals that usually mean scam" lifted a paid press release from 0.23 to 0.85. Delivery is now gated on page evidence plus demotions only, and signal weights move only on statistically significant differences (binomial test), so one stray click can't demote a class of real scams.

What learning *does* in v2 is move budget: which strategies and CT terms get queries and probes, and which kits get suppressed. Its value shows up on live data, where the mix of noise differs from any simulation.

## v1 contract bugs, reproduced with the original v6.1 code

A v0.7 promotion batch built by the original emitter (`triage_score = 11.5`, two evidence categories), sent to the original platform ingest route:

| Wire | Result |
| --- | --- |
| schema `1.1` (what the bundled SDK sends) | `partial`: **site and evidence records rejected** (`confidence ≤ 1`), 2 dead letters, 0 `site.triaged`, 0 jobs |
| schema `3.0`, raw score | same rejection |
| schema `1.1`, confidence fixed | site stored, but **0 `site.triaged`, 0 jobs**: 1.x promotion needs `triage.passed`, which the strict schema forbids |
| schema `3.0`, confidence fixed | 1 `site.triaged`, 1 `INVESTIGATE_SITE` job ✔ |

In the benchmark v1's cold-discovery path also sent **0** candidates to the platform: its send gate requires two indicator categories that only campaign runs produce.

## Caveats

* The world is synthetic and I built it and v2. Held-out and stress splits limit, but do not remove, the risk of fitting my own model of the world. Treat these as evidence that the mechanisms work and that v1's failure modes are fixed, not as a live precision forecast.
* Recall is not the target, but it is reported: v2 surfaces many more useful sites mainly because it rotates CT terms, uses feeds and review-page mentions, and wastes nothing on noise.
* Not modelled: rate limiting and outages of crt.sh or RDAP, cloaking by user-agent or geography, scams hosted on compromised legitimate sites.

## Reproduce

```
cd integrations/site-finder-v07
python -m benchmark.run --split eval --seeds 101 202 303 404 505 --rounds 6 --ablation --json eval.json
python -m benchmark.run --split eval --only v2 --v2-crtsh 1 --seeds 101 202 303 404 505
python -m benchmark.report eval.json
```

Raw results: `integrations/site-finder-v07/benchmark/results/`.

## Live A/B (recommended next step)

```
python -m benchmark.live_ab run --rounds 1      # v1 and v2 on the live internet, isolated databases, blind sheet
# label live_ab/sheet.csv: useful / skip
python -m benchmark.live_ab score live_ab/sheet.csv
```

After deployment, `GET /api/v1/inbox` reports running precision (overall and over your last 50 decisions) and per-strategy outcomes.
