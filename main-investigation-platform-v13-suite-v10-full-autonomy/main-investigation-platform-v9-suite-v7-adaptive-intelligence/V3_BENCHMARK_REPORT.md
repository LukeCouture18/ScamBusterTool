# v2 vs v3 evaluation

Both halves run on the same simulated internet as the v1-vs-v2 benchmark. The
**discovery** half runs the real Site Finder engine and the real v3
outcome-learning code (`app/v2/outcomes.py`, the exploration/anti-collapse
allocator); downstream outcomes are derived from the world's ground truth. The
**investigation** half is modelled with the same planner logic the real runner
uses (`lib/agent/rules_planner.ts`, proven end to end in `tests/v3-agent.mjs`)
applied to ground truth, so the action / evidence / intervention counts reflect
the real decision rules rather than any model's prose.

Reproduce:

```
cd integrations/site-finder-v07
python -m benchmark.eval_v3 --split eval   --seeds 101 202 303 --rounds 6
python -m benchmark.eval_v3 --split stress --seeds 101 202 303 --rounds 6
```

Raw results: `integrations/site-finder-v07/benchmark/results/eval_v3*.json`.

## Results (3 seeds × 6 rounds)

| Metric | eval v2 | eval v3 | stress v2 | stress v3 |
| --- | ---: | ---: | ---: | ---: |
| Candidate usefulness (precision) | 98.6% | 99.3% | 100.0% | 100.0% |
| Useful-evidence yield / surfaced site | 2.641 | 2.453 | 2.573 | 2.449 |
| Duplicate rate | 1.4% | 0.7% | 0.0% | 0.0% |
| Wasted-investigation rate | 6.6% | 6.7% | 8.7% | 8.8% |
| Actions per successful investigation | 3.83 | 3.65 | 3.82 | 3.68 |
| Human interventions | 0 | 0 | 0 | 0 |

Per-round precision trend (all seeds pooled):

* eval  — v2 [1.0, 1.0, 0.982, 0.961, 0.979, 1.0], v3 [1.0, 1.0, 1.0, 0.979, 0.977, 1.0]
* stress — v2 [1.0, 1.0, 1.0, 1.0, 1.0, 1.0], v3 [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]

## Reading this honestly

* **Precision is already saturated in v2** (~99–100%), because v2's precision
  work was the whole point of the v2 upgrade. v3 does not, and is not meant to,
  move precision much; it matches or slightly improves it.
* **Where v3 wins is efficiency and control**, not raw precision: it spends
  fewer module actions per successful investigation (it caps redundant wallet
  analysis, skips duplicates up front using cross-investigation memory, and
  only expands to related sites when there was real evidence), and it carries a
  lower duplicate rate. Useful-evidence yield per site is marginally lower for
  v3 precisely because it stops doing low-value redundant work.
* **Human interventions are 0 in this simulation** because the finder surfaces
  sites with *public* evidence, and login-wall ("stealth") kits are gated
  before they are ever surfaced. The barrier pause-and-resume path is therefore
  proven directly in `tests/v3-agent.mjs`, not here.
* **The main value of v3 is qualitative** and is proven by the acceptance
  tests, not by a precision delta on an already-precise benchmark: autonomous
  planning with typed, budgeted, auditable actions; safe human checkpoints;
  hallucination and provenance guarantees; and discovery that now learns from
  what investigations actually find, not only from clicks.

## Caveats

The world is synthetic and built by the same author as v2/v3. The discovery and
learning code is real; the investigation metrics are a rule-faithful model of
the planner, not a live run of the TypeScript runner (which is exercised
separately, end to end, in the acceptance suite). Treat these as evidence that
the mechanisms behave as intended, not as a live production forecast.
