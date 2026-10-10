# Platform v5 · Operations — v4 vs v5 Benchmark

`npm run benchmark:v5` runs `node --experimental-sqlite tests/bench-v5.mjs --seeds 5 --budget 12 --discovery 8`. Raw per-seed results are in `tests/results/eval_v5.json`.

## Setup: identical in both arms

- **Same world and same budgets.**
  - The same synthetic world per seed: `makeWorld` from the v4 benchmark, with operators running kits of cloned sites that share templates, hosting, name servers and often a deposit wallet; dead and login-walled sites; unrelated sites on a large CDN; and sites that only discovery can find.
  - The same **5 simulated days × 8 ticks**.
  - The same budgets: **12 investigations, 8 discovery requests, 60 module jobs**.
- **Temporal dynamics, the same in both arms** (a deterministic function of seed and day):
  - login-walled sites open their deposit pages;
  - live sites die and dead sites return;
  - operators rotate deposit wallets;
  - kits register new sites.
- **Site Finder's baseline supply** (the new registrations it surfaces each day) and its **watch re-deliveries** of surfaced sites that changed are identical in both arms.
- **Module and Site Finder answers** are a deterministic hash of (seed, request, site), so the same request gets the same answer in both arms. The simulated person resolves every checkpoint and contradiction.
- **Real platform code in both arms.** Real route handlers, real ingestion, the real v3 investigator, v4 campaigns, the v5 scheduler and the real job lifecycle. No model provider is configured (deterministic paths), which is the default.

**v4 arm.** v4's operating mode: on day 1 a person starts one campaign from the seed site. The campaign associates linked sites, prioritizes, tests hypotheses with pivots and stops at its budget. Nothing else runs; the v5 scheduler is paused.

**v5 arm.** The autonomous scheduler, with no human start:
- typed work from candidates, gaps and changes;
- automatic campaign formation, merge and split;
- revisits of changed sites;
- discovery cycles and pivots.

**Two wall-clock settings are scaled for compressed time** (disclosed, and applied to both arms):
- `disagreement_window_seconds=0`. Otherwise observations made seconds apart, simulating days apart, would look simultaneous.
- `revisit_cooldown_hours=0`. Otherwise a 24 h cooldown would span the whole run.

Nothing was tuned to the benchmark.

- **Code changes made during benchmark development.** Three were made. Each is a general correctness fix, and all are covered by tests:
  - budget is charged only when module work actually starts;
  - the contradiction detector uses the same configurable window;
  - auto-formed campaigns contain only their validated group instead of growing into each other.
- **One change affects prioritization.** The candidate "relevance to proven sites" factor, the v5 counterpart of v4's `proven_link`, was added. It improved v5 and is described in the implementation report.
- **v4 numbers.** The v4 arm runs on the v5 codebase with the scheduler paused, so its numbers moved slightly (10.8 → 10.4 investigations on average) as shared code changed. Per seed, the arms are deterministic.

## Results (mean of 5 seeds)

| Metric | v4 | v5 | Change |
| --- | ---: | ---: | --- |
| **Unique wallets revealed (useful unique results)** | 9.4 | **14.8** | **+57%** |
| Sites that yielded a new wallet | 9.4 | 12.2 | +30% |
| Useful evidence items | 9.6 | **17.0** | +77% |
| Investigations started (budget 12) | 10.4 | 12.0 | v5 uses the whole budget |
| Duplicate investigations | 0.8 | 1.2 | **worse** |
| Duplicate rate | 0.077 | 0.100 | **worse** |
| Dead / non-scam site jobs | 0.2 | 1.6 | **worse** |
| Non-scam investigations | 0 | 0 | same |
| Module jobs | 28.0 | 42.4 | +51% (more work done) |
| Wasted jobs (dup/non-scam investigations, fruitless revisits, zero-yield discovery) | 6.0 | 7.0 | slightly worse in absolute terms |
| **Module jobs per useful result** | 3.01 | **2.91** | −3% (about the same efficiency) |
| **Human interventions** | 1.2 | **0.4** | −67% (no human start; checkpoints only) |
| Discovery requests | 8 | 8 | same budget |
| New scam sites found by discovery | 7.2 | 9.0 | +25% |
| Discovery saturation (zero-yield share) | 0.600 | **0.425** | better |
| Time to first useful result (tick) | 1 | 1 | same |
| Mean tick of useful results | 4.7 | 8.3 | later: v5 keeps finding after day 1 |
| Useful results after day 1 | 1.8 | **5.6** | ×3 |
| Revisits / useful revisits | 0 / 0 | 7.8 / 5.6 | v4 has no revisits |
| Useful revisit rate | — | 0.72 | |
| World changes on surfaced sites re-observed by modules | 0 of 17.2 | 5.0 of 18.2 | |
| Campaigns (formed / completed) | 1 / 0 | 4.4 / 3.2 | v4's single campaign ends at its budget |
| Model calls / tokens / cost | 0 | 0 | no provider configured |
| Useful results per tick | 0.235 | **0.370** | +57% |

Per seed, unique wallets revealed were v4 `10, 8, 11, 10, 8` and v5 `17, 14, 14, 18, 11`. v5 was higher on every seed.

## Reading the results

**Where v5 is better, and why.** Most of the gain comes from **time**:
- **Changes.** After day 1, the world keeps changing: deposit pages open, wallets rotate, sites return. v4 cannot see this. Its campaign finished its budget on day 1, and nothing revisits.
- **Revisits.** v5 turns Site Finder's watch re-deliveries into typed changes and then into revisits. 72% of revisits revealed a new deposit wallet.
- **Discovery.** v5 spends discovery on infrastructure that already produced wallets, so its discovery has lower saturation.
- **People.** It needed no human start.

**Where v5 is worse (regressions, reported as found).**
- **More duplicates and more dead or low-value jobs.**
  - v5 investigates candidates that v4's single campaign would have set aside as near-duplicate mirrors, because the global queue only knows duplication through clusters and sibling wallets.
  - Some v5 revisits hit sites that died meanwhile, and a few dead-site jobs are the price of watching.
- **More total module work (+51%).** v5 finds more, but the cost per useful result is only about equal (2.91 vs 3.01), not substantially lower. Efficiency per unit of *machine* effort did not improve meaningfully in this world. The improvement is in total useful output per budget, in human effort, and in results over time.
- **Later average discovery of useful results.** This is expected, because most extra results come from later changes. Time to the *first* useful result is the same.
- **Many small auto campaigns.** v5 formed 4.4 campaigns on average and completed 3.2. Most are small groups. The operator sees more campaigns than in v4.

**Not measured here.**
- Model routing quality. No provider was configured, which is the default; routing, fallback and budget refusal are covered by the acceptance suite.
- Precision against real sites. The world is synthetic.
- Site Finder's real discovery engine. The platform benchmark simulates Site Finder answers; the real engine's continuous cycles are exercised by `test_v5_continuous.py` against the simulated internet in `benchmark/world.py`.
