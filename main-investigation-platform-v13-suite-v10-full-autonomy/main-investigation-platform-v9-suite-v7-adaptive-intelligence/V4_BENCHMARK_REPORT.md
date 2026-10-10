# v3 vs v4 benchmark

v4's goal is to be **better at deciding what is worth investigating**, not to do more work. This benchmark measures that. Both arms run the **real platform code** (real routes, the real v3 investigator and, in the v4 arm, the real campaign orchestrator), each in its own process and database, against the same synthetic world, with the same investigation budget.

| Arm | What drives the work |
| --- | --- |
| **v3** | The inbox as v3 shipped it. A simulated person works the inbox top-down and marks candidates Useful when the card's score is ≥ 0.7, otherwise Skip. Each Useful starts the v3 AI investigator. It investigates the site, analyses wallets and makes one classic related-sites request to Site Finder. |
| **v4** | One campaign started from the same seed site. It uses association, the deterministic priority engine, hypotheses tested by contextual pivots, the Reviewer, saturation and budgets. The only human work is the checkpoints. |

**The world.** It is generated per seed in `tests/lib/bench-v4-arm.mjs` and is pure ground truth:

- Three operators run kits of cloned sites. The sites share page templates, hosting IPs and name servers.
- About 70% of clones reuse a kit's deposit wallet.
- 15% of sites are dead and about 15% are behind a login.
- About half of the operator sites are not in the inbox yet. They can only be reached by discovery.
- 28 legitimate sites and some scams share one big CDN IP. This is the "generic hosting" trap.

Module workers answer from that truth. When a person is asked to sign in, the simulation does so and CryptoWalletLogger records the wallet behind the login.

**Site Finder in this benchmark.** Site Finder is a small truth-driven service here:

- v4 pivots find undiscovered sites that share the pivoted indicator, with a per-kind probability.
- The CDN IP yields nothing, as Finder's generic-hosting gate would ensure.
- v3's classic related round finds kit siblings with probability 0.5, plus sometimes a non-scam look-alike.

The real Site Finder v4 pivot engine (contextual allocation, saturation, passive DNS) is exercised separately against the simulated internet in `integrations/site-finder-v07/tests/test_v4_context.py`.

## Reproduce

```
node --experimental-sqlite tests/bench-v4.mjs --seeds 5 --budget 10                    # npm run benchmark:v4
node --experimental-sqlite tests/bench-v4.mjs --seeds 5 --budget 20
node --experimental-sqlite tests/bench-v4.mjs --seeds 5 --budget 20 --discovery 16
```

The raw per-seed results are in these files:

- `tests/results/eval_v4.json`
- `tests/results/eval_v4_budget20.json`
- `tests/results/eval_v4_budget20_discovery16.json`

## Metric definitions

- **Useful unique investigation:** an investigation that revealed a deposit wallet no earlier investigation had revealed. The count uses ground truth, in reveal order.
- **Duplicate investigation:** a live scam site whose investigation revealed nothing new.
- **Wasted module jobs:** site, wallet and recheck jobs spent on duplicate, dead or non-scam sites.
- **Human interventions:** inbox decisions plus checkpoints resolved.
- **Model cost:** zero model calls. Both arms ran the deterministic planners (`AI_PROVIDER` unset), so only the decision logic is compared.

## Results: investigation budget 10, 5 seeds (means)

| Metric | v3 | v4 |
| --- | ---: | ---: |
| Investigations run | 10.0 | 9.4 |
| **Useful unique investigations** | 7.2 | **8.4** |
| Useful evidence items | 7.4 | 8.6 |
| **Useful evidence per module job** | 0.273 | **0.331** |
| **Duplicate investigations** | 1.2 | **0.4** |
| **Dead / non-scam investigations** | 1.6 | **0.6** |
| Module jobs | 27.0 | 26.0 |
| **Actions per useful investigation** | 3.85 | **3.10** |
| **Wasted module jobs** | 2.8 | **1.4** |
| **Human interventions** | 10.2 | **0.2** |
| Discovery requests | 10.0 | 8.0 |
| New scam sites found by discovery | 7.8 | 8.0 |
| Discovery requests that found nothing | 3.6 | 4.2 |
| Coverage of the target operator's wallets | 0.46 | 0.49 |
| Hypotheses supported / disproved | – | 3.6 / 4.4 |
| Model calls | 0 | 0 |

With the same budget, v4:

- found 17% more unique wallets;
- ran a third of the duplicate investigations and 40% of the dead or non-scam ones;
- spent half the wasted module work;
- needed no inbox decisions at all.

It also stopped itself slightly before the budget (9.4 of 10) when nothing left in the campaign was worth doing.

## Results: investigation budget 20 (the trade-off)

| Metric | v3 | v4 (discovery 8) | v4 (discovery 16) |
| --- | ---: | ---: | ---: |
| Investigations run | 20.0 | 9.6 | 10.2 |
| Useful unique investigations | **10.2** | 8.6 | 9.2 |
| Useful evidence per module job | 0.217 | **0.333** | 0.287 |
| Duplicate investigations | 2.0 | **0.4** | **0.4** |
| Dead / non-scam investigations | 8.2 | **0.6** | **0.6** |
| Module jobs | 49.6 | **26.4** | 32.8 |
| Actions per useful investigation | 4.91 | **3.08** | 3.57 |
| Wasted module jobs | 9.8 | **1.4** | **1.4** |
| Human interventions | 20.8 | **0.2** | **0.2** |
| Discovery requests that found nothing | 9.8 | **4.0** | 7.6 |
| Coverage of the target operator's wallets | **0.61** | 0.49 | 0.51 |
| Hypotheses supported / disproved | – | 3.8 / 4.2 | 5.4 / 7.8 |

**This is not a clean win, and the report says so.** Given twice the budget, v3 keeps going until the budget is spent:

- a person grinds through 20 inbox cards;
- its 20 investigations include 8 dead or non-scam sites;
- it finds more unique wallets in total (10.2).

v4 stops at about 10 investigations. By then every remaining lead in its campaign is either a duplicate, saturated, or cut off by the discovery budget. Raising the discovery budget to 16 buys a little more (9.2), at a lower yield per job.

There are two reasons for the gap:

- **A campaign is scoped to one connected operator.** v3's inbox-order process also reached the unrelated operators' sites in the inbox. The v4 campaign, by design, did not.
- **The Reviewer and the saturation rules are deliberately conservative.** They are tuned to stop low-value expansion, which is what the metrics reward per unit of work, not total volume.

In practice, run the inbox (or a second campaign) for sites outside the campaign. Raise `max_discovery_requests` when a campaign is still producing supported hypotheses.

## Caveats

- **The world is synthetic and was written by the same author as v4.** Its parameters (clone rate, wallet reuse, dead and login rates, the discovery probabilities) were fixed before the v4 numbers were seen and were not tuned afterwards. They still encode assumptions about how operators behave. The v3 arm's "person" is a simple score threshold, and a skilled analyst would skip more of the non-scam cards.
- **One harness bug was fixed after the first runs.** The simulated workers did not send the idle heartbeat real workers send. After one failed job, Site Investigator therefore looked unavailable, and most v3 runs stalled (an early draft showed v3 at 2.6 useful investigations). The published numbers are with the heartbeat in place, and that fix helped v3, not v4.
- **Finder behaviour is simulated in both arms.** The real Finder v4 context learning (the allocation change by context, bounded exploration and saturation) is proven in its own tests, not in these numbers.
- **Both arms ran without a model.** Model-assisted planning in either version is not measured here.
- **Five seeds is small.** Per-seed results are in the JSON files. At budget 10, v4 was better or equal on every seed for useful evidence per module job, actions per useful investigation, duplicate investigations, wasted module jobs and human interventions. On useful unique investigations it was better on 4 of 5 seeds; seed 1 was 8 against v3's 9.
- **Investigation time** is shown only as platform ticks and wall time in the JSON. In the simulation both are dominated by harness overhead and are not meaningful as a speed claim.
