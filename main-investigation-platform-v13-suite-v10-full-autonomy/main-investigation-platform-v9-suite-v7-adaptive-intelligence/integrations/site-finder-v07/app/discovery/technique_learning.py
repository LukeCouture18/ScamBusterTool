"""
Technique learning: the engine's memory of what actually works.

v0.3 ran every pivot it could generate. v0.4 keeps a ledger of how each
technique has performed and uses that history to decide what to run next —
preferring techniques that have produced unique, high-quality sites and
throttling ones that mostly return noise.

HOW A TECHNIQUE IS SCORED
-------------------------
Three ratios, each measuring something different, combined into one 0..1 score:

  uniqueness  — of the candidates it returned, how many were domains we didn't
                already have? A technique that keeps rediscovering known sites
                is doing no work.
  survival    — of the sites it found first, how many cleared triage? This is
                the quality signal: finding 100 dead parked domains is not a
                contribution.
  payoff      — of those, how many reached high confidence? This is the rarest
                and most valuable outcome, so it carries the most weight.

v0.5 SHARPENS WHAT "PAYOFF" MEANS
--------------------------------
"Reached high confidence" was measured locally, against Site Finder's own
opinion of a site. From v0.5 the more meaningful outcome is available: did the
discovery clear the send gate and go to the Main Platform as something worth
investigating? That is a judgement made against independent evidence
categories rather than against one scanner's scoring, so it is the harder and
more honest test. Where that signal exists it is used; where it does not — a
standalone installation with no platform configured — the local high-confidence
count still stands in, so learning never stops just because nothing is
listening.

Every score is computed from stored counters and is fully explainable: the
ledger keeps an evidence_note recording the arithmetic behind the current
number, so "why is this technique suspended?" always has a concrete answer.

CONFIDENCE IN THE SCORE ITSELF
------------------------------
A technique that has run twice has not earned a strong opinion either way, so
scores are shrunk toward neutral until there is enough evidence. Without this,
one unlucky first run would suspend a good technique permanently — the classic
failure of naive bandit scoring.

THROTTLING IS REVERSIBLE
------------------------
'suspended' means "stop spending budget here for now", never "this is banned".
A suspended technique is re-tried periodically, because the web changes and a
technique that was useless last month may be productive today.
"""
import logging

from app import db
from app.config import (
    TECHNIQUE_MIN_LEADS_FOR_CONFIDENCE, TECHNIQUE_REDUCED_THRESHOLD,
    TECHNIQUE_SUSPENDED_THRESHOLD, TECHNIQUE_RETRY_AFTER_LEADS,
    TECHNIQUE_PRIOR_STRENGTH,
)

logger = logging.getLogger("scamhunter.technique_learning")

# Weights: payoff matters most because high-confidence sites are the point.
W_UNIQUENESS = 0.25
W_SURVIVAL = 0.35
W_PAYOFF = 0.40

NEUTRAL_SCORE = 0.5


def compute_yield(stats: dict) -> dict:
    """
    Pure function over a technique's counters. Returns the score plus the
    arithmetic behind it, so the result is always explainable.
    """
    leads = stats.get("leads_executed", 0) or 0
    candidates = stats.get("candidates_returned", 0) or 0
    unique_new = stats.get("unique_new_sites", 0) or 0
    passed = stats.get("sites_passing_triage", 0) or 0
    high_conf = stats.get("sites_high_confidence", 0) or 0
    sent = stats.get("sites_sent_to_platform", 0) or 0

    uniqueness = (unique_new / candidates) if candidates else 0.0
    survival = (passed / unique_new) if unique_new else 0.0

    # v0.5: payoff prefers the harder test — discoveries that cleared the send
    # gate and went to the platform as worth investigating. A standalone
    # installation has no such signal, so the local high-confidence count
    # stands in and learning continues either way.
    payoff_numerator = max(sent, high_conf)
    payoff_basis = ("sent to the platform" if sent >= high_conf and sent > 0
                    else "reached high confidence locally")
    payoff = (payoff_numerator / unique_new) if unique_new else 0.0

    raw = (W_UNIQUENESS * uniqueness) + (W_SURVIVAL * survival) + (W_PAYOFF * payoff)

    # Shrink toward neutral until there's enough evidence to trust the ratios.
    # With few leads the prior dominates; with many, the observed data does.
    weight = leads / (leads + TECHNIQUE_PRIOR_STRENGTH) if leads else 0.0
    score = (weight * raw) + ((1 - weight) * NEUTRAL_SCORE)
    score = round(max(0.0, min(1.0, score)), 3)

    confident = leads >= TECHNIQUE_MIN_LEADS_FOR_CONFIDENCE

    note = (
        f"{leads} lead(s) run, {candidates} candidate(s) returned. "
        f"uniqueness {unique_new}/{candidates or 0} = {uniqueness:.2f}; "
        f"survival {passed}/{unique_new or 0} = {survival:.2f}; "
        f"payoff {payoff_numerator}/{unique_new or 0} = {payoff:.2f} "
        f"({payoff_basis}). "
        f"Weighted raw = {raw:.3f}; shrunk toward neutral by evidence weight "
        f"{weight:.2f} → {score:.3f}."
        + ("" if confident else
           f" Fewer than {TECHNIQUE_MIN_LEADS_FOR_CONFIDENCE} leads, so this score is "
           "provisional and the technique is not throttled on it yet.")
    )

    return {
        "yield_score": score, "raw": round(raw, 3), "confident": confident,
        "uniqueness": round(uniqueness, 3), "survival": round(survival, 3),
        "payoff": round(payoff, 3), "evidence_note": note, "leads": leads,
    }


def decide_throttle(result: dict, current_state: str, leads_since_suspend: int = 0) -> tuple:
    """
    Returns (throttle_state, reason). Only throttles once there is enough
    evidence — a technique is never suspended on a small sample.
    """
    score = result["yield_score"]

    if not result["confident"]:
        return "normal", (
            f"Only {result['leads']} lead(s) so far — too little evidence to judge. "
            "Running at normal priority until there is more.")

    if score < TECHNIQUE_SUSPENDED_THRESHOLD:
        return "suspended", (
            f"Yield {score:.2f} is below the suspend threshold "
            f"{TECHNIQUE_SUSPENDED_THRESHOLD:.2f} over {result['leads']} leads. "
            "Paused to stop it consuming budget. It will be re-tried "
            f"after {TECHNIQUE_RETRY_AFTER_LEADS} leads elsewhere, since a technique "
            "that is unproductive now may become productive later.")

    if score < TECHNIQUE_REDUCED_THRESHOLD:
        return "reduced", (
            f"Yield {score:.2f} is below the healthy threshold "
            f"{TECHNIQUE_REDUCED_THRESHOLD:.2f} over {result['leads']} leads. "
            "Still run, but at lower priority than better-performing techniques.")

    return "normal", f"Yield {score:.2f} over {result['leads']} leads — performing well."


def update_all_scores() -> list:
    """Recomputes every technique's score from its stored counters."""
    updated = []
    for stats in db.list_techniques():
        result = compute_yield(stats)
        state, reason = decide_throttle(result, stats.get("throttle_state", "normal"))
        db.set_technique_score(stats["pivot_type"], result["yield_score"],
                                state, reason, result["evidence_note"])
        updated.append({
            "pivot_type": stats["pivot_type"], "yield_score": result["yield_score"],
            "throttle_state": state, "reason": reason,
            "evidence_note": result["evidence_note"],
        })
    return updated


def technique_priority(pivot_type: str) -> float:
    """
    Multiplier applied to a lead's strength when ordering the queue. This is
    how learning actually changes behaviour: a proven technique's leads rise,
    a noisy technique's sink, and a suspended one drops out entirely.
    """
    stats = db.get_technique(pivot_type)
    if not stats:
        return 1.0  # never run — no reason to prefer or avoid it yet
    state = stats.get("throttle_state", "normal")
    if state == "suspended":
        return 0.0
    if state == "reduced":
        return 0.5
    # Map yield 0..1 onto a 0.6..1.4 multiplier so a good technique is preferred
    # without a mediocre one being effectively silenced.
    return round(0.6 + (stats.get("yield_score", 0.5) * 0.8), 3)


def should_skip_technique(pivot_type: str) -> tuple:
    """Returns (skip, reason) — the gate applied before spending budget."""
    stats = db.get_technique(pivot_type)
    if not stats:
        return False, ""
    if stats.get("throttle_state") == "suspended":
        executed_elsewhere = sum(
            t["leads_executed"] for t in db.list_techniques()
            if t["pivot_type"] != pivot_type)
        if executed_elsewhere % max(1, TECHNIQUE_RETRY_AFTER_LEADS) == 0 and executed_elsewhere > 0:
            return False, "suspended, but due for a periodic re-try"
        return True, stats.get("throttle_reason") or "technique is suspended for low yield"
    return False, ""


def rank_leads(leads: list) -> list:
    """
    Orders a batch of queued leads by learned priority. Shallower depth still
    wins first — closer to the seed means better-evidenced — with learned
    technique quality breaking ties within a depth.
    """
    def key(lead):
        multiplier = technique_priority(lead["pivot_type"])
        return (lead["depth"], -(lead.get("strength", 0.5) * multiplier))
    return sorted([l for l in leads if technique_priority(l["pivot_type"]) > 0], key=key)


def learning_report() -> list:
    """Everything the engine has learned, in a form a human can check."""
    out = []
    for stats in db.list_techniques():
        result = compute_yield(stats)
        out.append({
            "pivot_type": stats["pivot_type"],
            "leads_executed": stats["leads_executed"],
            "candidates_returned": stats["candidates_returned"],
            "unique_new_sites": stats["unique_new_sites"],
            "sites_passing_triage": stats["sites_passing_triage"],
            "sites_high_confidence": stats["sites_high_confidence"],
            "yield_score": stats["yield_score"],
            "throttle_state": stats["throttle_state"],
            "throttle_reason": stats["throttle_reason"],
            "priority_multiplier": technique_priority(stats["pivot_type"]),
            "uniqueness": result["uniqueness"],
            "survival": result["survival"],
            "payoff": result["payoff"],
            "evidence_note": stats.get("evidence_note") or result["evidence_note"],
            "evidence_class": "derived",
        })
    return out
