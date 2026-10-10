"""
Site Finder v2 — the precision engine.

One goal: raise the share of surfaced sites that are actually worth a person's
time. Everything in this package serves that, and everything it decides is
recorded with its reasons so the advanced view can show why.

    strategies  ->  intake (normalise, collapse, dedupe)  ->  cheap probes
                ->  gates (dead / parked / placeholder / legit / informational)
                ->  evidence (typed, context-aware signals)
                ->  clustering (one candidate per operator kit)
                ->  calibrated score (+ what your decisions taught it)
                ->  inbox (only what clears the bar)

Outcomes (USEFUL / SKIP) flow back into strategy budgets, signal weights and
cluster priors, so productive discovery methods get more effort over time.

Passive and public only: DNS lookups, single unauthenticated GETs of public
pages and their public assets, Certificate Transparency, RDAP. Nothing here
logs in, submits forms, solves CAPTCHAs or moves money.
"""
V2_VERSION = "2.0.0"
