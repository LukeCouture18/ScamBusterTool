# Candidate selection release evidence

The previous v2 delivery and inbox both sorted on `p` alone. A single review
slot could therefore go to a near-identical site even when a different eligible
site had corroborating evidence. The upstream eligibility gate (`p_gate`, a
core observation and completed enrichment) remains unchanged. The new selector
uses bounded independent-evidence and discovery-route terms, then penalizes a
same-cluster shortlist choice by at most 0.085; a clearly stronger candidate
can still win. Existing feedback is already bounded inside the probability
model and is not counted a second time. Evidence and the explanation are saved
under candidate `details.selection` and exposed in the existing Why/Details UI.

Paired simulated comparison: `python -m benchmark.selection_ab --split eval
--seeds 101 202 303 --rounds 5 --summary`, repeated with `--split stress`.
Each old/new pair receives the *same eligible candidate pool* captured immediately
before delivery. Counts are summed over 15 five-slot rounds per split.

| Split | Selector | Useful@3 | Useful@5 | DCG@5 | Same-cluster slots | Distinct clusters | Useful pool members below cutoff |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| eval | old | 44/45 | 73/75 | 43.3406 | 2 | 73 | 550 |
| eval | new | 45/45 | 74/75 | 43.8406 | 0 | 75 | 550 |
| stress | old | 44/45 | 73/75 | 43.3406 | 3 | 72 | 394 |
| stress | new | 45/45 | 75/75 | 44.2275 | 0 | 75 | 394 |

These are modest simulated improvements, not evidence of a dramatic precision
gain or production validation. The earlier 226-useful-domain pool and its
75/75 review result were not persisted as a replayable, individually labelled
candidate snapshot. Its 75/75 result is already the ceiling for useful@5;
the extra useful domains below the cutoff cannot raise that metric at the same
slot volume. This new paired evaluation must not be represented as a replay of
those exact 1,534 domains. The `missed_useful` count uses raw simulated labels,
not independent human judgments of incremental investigative value.

Adversarial tests cover repeated signals from one group/source, independent
signals, close-cluster substitution, large quality gaps, and selection reasons.
No live candidate pool has been human-labelled for this change.
