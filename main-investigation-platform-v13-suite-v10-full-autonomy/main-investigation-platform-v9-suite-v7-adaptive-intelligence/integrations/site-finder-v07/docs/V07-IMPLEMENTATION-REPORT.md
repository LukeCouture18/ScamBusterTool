# v0.7 Implementation Report

Site Finder v0.7 — Adaptive Discovery & Campaign Intelligence.
**420 tests passing** in both pytest and the dependency-free runner.

Site Finder's responsibility is unchanged:
**Discover → Triage → Correlate → Prioritize → Handoff.**

---

## 1. Main Platform contract — blocked, and why

**Not implemented. The newer contract was not available.**

Item 1 asked for canonical support for five things: non-routing observations,
first-class triage, dismissed/inconclusive candidates, push-based downstream
feedback, and module/technique metrics.

Those are **exactly the five gaps** reported against v4 in
`CONTRACT-GAP-REPORT.md`. Only the v4 distribution is present in this
environment, and v4 expresses none of them. No newer SDK, schema or endpoint
set was supplied.

So v4 remains canonical, the v0.6 workarounds remain in place because they are
still the only in-contract way to express these things, and **no private event,
field or endpoint was invented to close the gap**. The gap report is unchanged
and still accurate.

**To unblock:** supply the newer SDK/contract and the migration is mechanical —
`app/integration/v4/contract.py` is a pure transcription, and `translator.py`
is the only file that maps internal models onto wire records.

## 2–3. Adaptive discovery and budget allocation

Technique performance was already measured against neutral downstream outcomes
in v0.6. What v0.7 fixes is that **it never actually changed what ran** (audit
findings A1 and A2). Allocation is now persisted and enforced per technique;
downstream usefulness now reaches the technique ledger.

Small-sample protection was already correct and is unchanged: shrinkage toward
neutral, a minimum sample before anything moves, a ×0.35 floor so a weak
technique can recover, a ×2.0 cap, and a reserved exploration share.

## 4. Discovery saturation detection — new

`app/discovery/saturation.py`. Six measurements, each catching a different way
a branch dies: duplicate rate, **indicator** novelty rate, survival rate, dead
rate, downstream usefulness, cost per survivor.

The design point: **budget exhaustion is the worst possible reason to stop** —
it means the money ran out, not that the searching finished. `STOP_REASONS` is
a closed vocabulary, and `why_expansion_stopped()` separates the two cases
explicitly:

> "A limit stopped this campaign before the search was finished. Raising that
> limit and resuming would probably find more."

versus

> "This campaign stopped because the search was finished… Raising the budget
> would buy more of the same; a different seed would not."

No single signal stops a branch — a high duplicate rate early in a campaign is
normal. Branches are **slowed at two signals and stopped at three**, because
saturation is a gradient and the measurement is noisy.

## 5–6. Path quality and multi-pivot convergence

Both existed from v0.5/v0.6 and were strengthened rather than rebuilt. Path
quality scores the *route* (operator-supplied vs inherited indicator, breadth,
depth, learned technique quality, downstream feedback) and explicitly does not
treat long paths as stronger. Convergence counts independence across
**indicator types**, not just pivot types — a wallet path plus a certificate
path fail for unrelated reasons; two wallet paths can both come from one copied
page. The explanation object shows exactly which paths converged.

## 7–8. Cluster intelligence and new-cluster detection

Family signatures already required *combinations* (either one identity-bound
indicator or two independent categories), and v0.6's `assess_newness` already
distinguished `newly_registered` / `newly_noticed` / `new_to_us`. v0.7 adds
`cluster_snapshots`, so "this family just gained a domain" is answerable from
recorded history rather than inferred, and novelty can ask whether a site was
in a family the last time it was recorded.

## 9. Cross-campaign deduplication

Already global in v0.6 via `candidate_registry`. v0.7 fixes two real defects:
existing sites are now backfilled on upgrade (A0), and the corroboration signal
is actually applied to prioritisation (A4).

## 10. Historical candidate memory — new

`app/discovery/candidate_memory.py`. Decisions (`promoted`, `dismissed`,
`inconclusive`, `unreachable`, `deferred`) are recorded with a snapshot of what
was known at the time, and checked before anything is spent again.

**The bar for reconsidering is new evidence, not elapsed time.** A year passing
tells you nothing; a novelty score computed *since the decision* tells you
whether anything changed. One exception: an `unreachable` verdict earns one
cheap recheck after 30 days, because a site being down says nothing durable.

**The original decision survives.** Reconsidering supersedes; it never
overwrites. An analyst asking "why was this dismissed and then promoted?" gets
both halves and the evidence that changed between them.

## 11. Candidate novelty — new

`app/discovery/novelty.py`, deliberately **separate** from priority, confidence
and evidence strength, because they routinely disagree and one blended score
buries the disagreement:

- *high novelty, low priority* — a domain nobody has seen carrying nothing.
  Common, correctly ignored.
- *low novelty, high priority* — a familiar candidate now carrying a wallet it
  did not have last month. The most valuable thing this module finds.

A gap found while testing: the spec's own example is "previously dismissed →
new wallet observation, new deposit page → reconsider", and a deposit route
was not a novelty signal at all. Added, weighted so that example clears the
threshold on its own.

## 12. Why This Site Was Surfaced — new

`app/discovery/explain.py` plus a UI drawer. One object holding origin, every
discovery path, path quality, convergence, cross-campaign corroboration,
observed indicators, triage, priority *and* novelty as separate scores with
their factor lists, cluster, decision history, downstream outcomes, technique
performance, the promotion decision, and the platform association.

Every section carries `evidence_class`. Scores never arrive as bare numbers.

## 13. Campaign controls — new

Pause, Resume, Stop After Current, Change Budget — honoured at **wave
boundaries**, so a control never leaves a stage half-done. State survives in
`campaign_controls`; budget changes apply at the next boundary.

## 14. Main Platform jobs

Already first-class in v0.6 (claim, progress, complete, fail, needs-review,
lease heartbeat, idempotency, policy enforcement). v0.7 fixes A6: orphaned jobs
are now handed back on restart instead of left to time out.

## 15. Rate-limit and provider intelligence

Persistent per-service token bucket from v0.6 (rolling window, daily ceiling,
`Retry-After` obeyed exactly, counters in the database so crash-looping is not
a way past a daily limit). v0.7 wires it into the pivot engine's actual
outbound calls — DNS resolution and certificate reads now acquire a slot, and
a refusal means "not now", not an error.

## 16. Discovery Knowledge Graph

Unchanged from v0.6 and still correct: typed nodes and edges assembled from
existing rows on demand, every row labelled observed or derived, wallets and
infrastructure as separate node types.

## 17. Controlled exploration

All limits from v0.4–v0.6 retained, plus per-technique allocation caps (A1) and
saturation stops (item 4). Budget consumption is visible in the Campaigns view
and on the main screen.

## 18. Noise suppression

v0.5's static caps and measured retirement, unchanged: an indicator is retired
from *pivoting* while the observation itself is kept as evidence. Retirement is
reversible and never claims anything about the sites carrying the indicator.

## 19–20. Discovery Performance and Main Screen

The Performance view gained downstream-outcome columns and budget-share
drill-down. The **main screen was rebuilt** to the six panels asked for —
Active Campaigns (with live controls), High-Priority Candidates, New
Discoveries (most novel first), Needs Review, Recent Handoffs, Discovery
Performance — replacing the six vanity stat tiles. Every candidate row has a
**Why?** button opening the explanation.

## 21. Deep-investigation overlap

No new deep-investigation capability was added. `DEEP_ANALYSIS_MODE` still
stands the local deep stage down when Site Investigator is taking the work.
Deprecated components are listed in `DEPRECATED-RESPONSIBILITIES.md`.

## 22. Reliability

Migrations (A0), the link actually running (A3), orphaned-job return (A6), and
the existing outbox/retry/dead-letter/idempotency machinery. Nothing is
discarded for age or queue depth.

## 23. Testing

420 tests. New: `test_v06_audit_fixes.py` (16) and
`test_v07_adaptive_discovery.py` (29).

---

## Remaining limitations

1. **The contract gaps are unchanged** — the five canonical features in item 1
   need a platform that expresses them.
2. **Feedback is still polled, not pushed** — v4 has no return channel to the
   discovering module.
3. **Saturation is measured per campaign, not per pivot branch, in the running
   loop.** `measure()` and `assess()` both accept a `pivot_type`, and the data
   supports per-branch stops, but the campaign loop currently assesses the
   campaign as a whole between waves. Per-branch throttling inside a wave is
   the obvious next step.
4. **Cluster snapshots are stored but not yet taken automatically** — the table,
   helpers and novelty integration exist; a scheduled snapshot pass does not.
   Snapshots are currently written only when something calls
   `take_cluster_snapshot`.
5. **Provider intelligence is reactive, not predictive.** Failure rate and
   historical usefulness per provider are tracked, but request *scheduling*
   still runs first-come rather than preferring the provider most likely to
   answer usefully.
6. **`DISCOVER_SITES` is not a v4 job type.** v4 routes `FIND_RELATED_SITES`
   and `RECHECK_TARGET` to this module; a general discovery job would need the
   platform to define one.
