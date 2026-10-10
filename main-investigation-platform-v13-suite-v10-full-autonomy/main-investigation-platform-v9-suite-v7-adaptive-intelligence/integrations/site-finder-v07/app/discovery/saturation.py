"""
Knowing when a branch has stopped being worth searching.

A pivot engine that only knows how to expand will expand forever. Budgets
eventually stop it, but budget exhaustion is the worst possible reason to stop:
it means the money ran out, not that the searching was finished. By then the
last hundred lookups were probably rediscovering the same domains behind the
same CDN.

Saturation detection is the difference between "we stopped because we hit the
cap" and "we stopped because this branch had nothing left". The second is a
result; the first is a bill.

WHAT SATURATION LOOKS LIKE
--------------------------
Six measurements, each catching a different way a branch dies:

  duplicate rate    the same domains keep coming back
  novelty rate      the domains are new but the INDICATORS are not — same
                    hosting, same template, same everything
  survival rate     candidates arrive and none clear triage
  dead rate         the domains do not resolve or do not respond
  usefulness        downstream examination keeps finding nothing
  cost per find     API calls per surviving candidate is climbing

No single one stops a branch on its own. A high duplicate rate early in a
campaign is normal — you are re-reaching the seed's own neighbourhood. It is
the combination, measured over enough results to mean something, that says the
branch is done.

EVERY STOP IS EXPLAINED
-----------------------
The whole point is that "Why Expansion Stopped" is a real answer with numbers
behind it, not a status code. An operator looking at a finished campaign should
be able to tell at a glance whether to raise the budget and run it again, or
whether raising the budget would just buy more of the same.

SLOWING BEFORE STOPPING
-----------------------
A saturating branch is throttled before it is stopped, because saturation is a
gradient and the measurement is noisy. A branch that looks done at 20 results
sometimes is not; one that still looks done at 60 is.
"""
import logging

from app import db
from app.config import (
    SATURATION_MIN_SAMPLES, SATURATION_DUPLICATE_RATE, SATURATION_NOVELTY_RATE,
    SATURATION_SURVIVAL_RATE, SATURATION_DEAD_RATE, SATURATION_SIGNALS_TO_STOP,
    SATURATION_SIGNALS_TO_THROTTLE,
)

logger = logging.getLogger("scamhunter.saturation")

# The vocabulary for why expansion stopped. Closed on purpose: an operator
# should be able to learn six reasons, not read free text every time.
STOP_REASONS = (
    "duplicate_saturation",      # the same domains keep coming back
    "low_novelty",               # new domains, nothing new about them
    "low_survival",              # candidates arrive, none clear triage
    "mostly_dead",               # the domains do not resolve or respond
    "low_downstream_usefulness", # investigated candidates keep containing nothing
    "candidate_budget",          # the candidate allowance ran out
    "lead_budget",               # the lead allowance ran out
    "api_budget",                # the external-call allowance ran out
    "time_limit",                # wall clock
    "depth_limit",               # as far from the seed as configured
    "exhausted_leads",           # nothing left to try
    "stopped",                   # a person stopped it
)

# The ones that mean "this branch is finished" rather than "we ran out of
# resources". The difference decides whether raising the budget would help.
EXHAUSTION_REASONS = ("duplicate_saturation", "low_novelty", "low_survival",
                      "mostly_dead", "low_downstream_usefulness", "exhausted_leads")


def measure(campaign_id: int, pivot_type: str = None) -> dict:
    """
    Measures a branch. `pivot_type` narrows it to one technique within the
    campaign; omitted, it measures the campaign as a whole.

    Returns the six rates plus the samples behind them, so a caller can see
    whether the numbers mean anything yet.
    """
    campaign = db.get_campaign(campaign_id)
    run_key = f"campaign-{campaign_id}"
    with db.get_conn() as conn:
        run = conn.execute("SELECT id FROM pivot_runs WHERE run_key=?", (run_key,)).fetchone()
        run_id = run["id"] if run else None

        if not run_id:
            return {"samples": 0, "measurable": False,
                    "note": "This campaign has not executed any leads yet."}

        clause = "AND pivot_type=?" if pivot_type else ""
        params = [run_id] + ([pivot_type] if pivot_type else [])

        leads = conn.execute(
            f"""SELECT COUNT(*) c, COALESCE(SUM(candidates_found),0) candidates,
                       COALESCE(SUM(new_sites),0) new_sites
                FROM pivot_leads
                WHERE run_id=? AND status='executed' {clause}""", params).fetchone()

        reached = conn.execute(
            f"""SELECT COUNT(DISTINCT dp.site_id) c FROM discovery_paths dp
                WHERE dp.run_id=? {clause.replace('pivot_type', 'dp.pivot_type')}""",
            params).fetchone()["c"]

        # Of the sites this branch reached, how many cleared triage, how many
        # were unreachable, and how many indicators were new to us.
        survived = conn.execute(
            f"""SELECT COUNT(*) c FROM triage_results t
                WHERE t.passed=1 AND t.site_id IN (
                    SELECT dp.site_id FROM discovery_paths dp
                    WHERE dp.run_id=? {clause.replace('pivot_type', 'dp.pivot_type')})""",
            params).fetchone()["c"]

        dead = conn.execute(
            f"""SELECT COUNT(*) c FROM triage_results t
                WHERE (t.http_status IS NULL OR t.http_status >= 400)
                  AND t.site_id IN (
                    SELECT dp.site_id FROM discovery_paths dp
                    WHERE dp.run_id=? {clause.replace('pivot_type', 'dp.pivot_type')})""",
            params).fetchone()["c"]

    executed = leads["c"] or 0
    candidates = leads["candidates"] or 0
    new_sites = leads["new_sites"] or 0
    triaged = survived + dead

    duplicate_rate = (1.0 - (new_sites / candidates)) if candidates else 0.0
    survival_rate = (survived / reached) if reached else 0.0
    dead_rate = (dead / triaged) if triaged else 0.0

    # Novelty here is about INDICATORS, not domains: a branch returning new
    # domains that all carry indicators we already had is not finding anything.
    novelty_rate = _indicator_novelty_rate(campaign_id, pivot_type)

    usefulness = None
    if pivot_type:
        attribution = db.get_attribution("pivot", pivot_type)
        if attribution and (attribution.get("candidates_examined") or 0) >= 3:
            examined = attribution["candidates_examined"]
            usefulness = (attribution.get("useful") or 0) / examined

    return {
        "campaign_id": campaign_id, "pivot_type": pivot_type,
        "samples": candidates, "leads_executed": executed,
        "sites_reached": reached, "new_sites": new_sites,
        "duplicate_rate": round(duplicate_rate, 3),
        "novelty_rate": round(novelty_rate, 3) if novelty_rate is not None else None,
        "survival_rate": round(survival_rate, 3),
        "dead_rate": round(dead_rate, 3),
        "downstream_usefulness": round(usefulness, 3) if usefulness is not None else None,
        "cost_per_survivor": (round(executed / survived, 1) if survived else None),
        "measurable": candidates >= SATURATION_MIN_SAMPLES,
        "campaign_key": (campaign or {}).get("campaign_key"),
    }


def _indicator_novelty_rate(campaign_id: int, pivot_type: str = None):
    """
    Of the indicators observed on sites this branch reached, how many were
    ones we had never seen before? Returns None when there is nothing to
    measure rather than a misleading zero.
    """
    run_key = f"campaign-{campaign_id}"
    with db.get_conn() as conn:
        run = conn.execute("SELECT id FROM pivot_runs WHERE run_key=?", (run_key,)).fetchone()
        if not run:
            return None
        clause = "AND dp.pivot_type=?" if pivot_type else ""
        params = [run["id"]] + ([pivot_type] if pivot_type else [])
        row = conn.execute(
            f"""SELECT COUNT(*) total,
                       SUM(CASE WHEN i.site_count <= 1 THEN 1 ELSE 0 END) novel
                FROM site_indicators si
                JOIN indicators i ON i.id = si.indicator_id
                WHERE si.site_id IN (
                    SELECT dp.site_id FROM discovery_paths dp
                    WHERE dp.run_id=? {clause})""", params).fetchone()
    total = row["total"] or 0
    if not total:
        return None
    return (row["novel"] or 0) / total


def assess(campaign_id: int, pivot_type: str = None) -> dict:
    """
    Decides whether a branch should continue, slow down, or stop — and says
    exactly why, with the numbers.
    """
    metrics = measure(campaign_id, pivot_type)
    if not metrics.get("measurable"):
        return {
            **metrics, "state": "running", "stop_reason": None, "signals": [],
            "explanation": (
                f"Only {metrics.get('samples', 0)} candidate(s) so far — fewer than the "
                f"{SATURATION_MIN_SAMPLES} needed to judge whether this branch is "
                "saturating. Continuing at full rate."),
        }

    signals = []

    if metrics["duplicate_rate"] >= SATURATION_DUPLICATE_RATE:
        signals.append({
            "signal": "duplicate_saturation",
            "detail": (f"{metrics['duplicate_rate']:.0%} of candidates were domains already "
                       f"on record ({metrics['new_sites']} new out of {metrics['samples']}).")})

    if metrics["novelty_rate"] is not None and metrics["novelty_rate"] <= SATURATION_NOVELTY_RATE:
        signals.append({
            "signal": "low_novelty",
            "detail": (f"Only {metrics['novelty_rate']:.0%} of the indicators on sites this "
                       "branch reached were new. The domains differ; what is on them does "
                       "not.")})

    if metrics["sites_reached"] >= 3 and metrics["survival_rate"] <= SATURATION_SURVIVAL_RATE:
        signals.append({
            "signal": "low_survival",
            "detail": (f"{metrics['survival_rate']:.0%} of the {metrics['sites_reached']} "
                       "site(s) reached cleared triage.")})

    if metrics["dead_rate"] >= SATURATION_DEAD_RATE:
        signals.append({
            "signal": "mostly_dead",
            "detail": (f"{metrics['dead_rate']:.0%} of triaged candidates did not respond or "
                       "returned an error.")})

    if metrics["downstream_usefulness"] is not None and metrics["downstream_usefulness"] <= 0.1:
        signals.append({
            "signal": "low_downstream_usefulness",
            "detail": (f"Only {metrics['downstream_usefulness']:.0%} of candidates from this "
                       "branch contained anything when they were examined downstream.")})

    if len(signals) >= SATURATION_SIGNALS_TO_STOP:
        state, stop_reason = "saturated", signals[0]["signal"]
    elif len(signals) >= SATURATION_SIGNALS_TO_THROTTLE:
        state, stop_reason = "slowing", None
    else:
        state, stop_reason = "running", None

    if state == "saturated":
        explanation = (
            f"Stopping this branch: {len(signals)} saturation signal(s) over "
            f"{metrics['samples']} candidate(s). "
            + " ".join(s["detail"] for s in signals)
            + " Raising the budget would buy more of the same; a different seed or "
              "technique would not.")
    elif state == "slowing":
        explanation = (
            f"Slowing this branch: {len(signals)} saturation signal(s) over "
            f"{metrics['samples']} candidate(s). "
            + " ".join(s["detail"] for s in signals)
            + f" One more signal stops it. Saturation is a gradient and the measurement is "
              "noisy, so a branch is throttled before it is abandoned.")
    else:
        explanation = (
            f"This branch is still productive over {metrics['samples']} candidate(s): "
            f"{metrics['new_sites']} new domain(s), "
            f"{metrics['survival_rate']:.0%} cleared triage.")

    return {**metrics, "state": state, "stop_reason": stop_reason,
            "signals": signals, "explanation": explanation,
            "evidence_class": "derived"}


def record_stop(campaign_id: int, reason: str, explanation: str,
                pivot_type: str = None, metrics: dict = None):
    """
    Records why expansion stopped, so a finished campaign can be read without
    reconstructing it from logs.
    """
    if reason not in STOP_REASONS:
        logger.warning("Unknown stop reason %r recorded for campaign %s", reason, campaign_id)
    db.record_expansion_stop(campaign_id, pivot_type or "", reason, explanation,
                             metrics or {})


def why_expansion_stopped(campaign_id: int) -> dict:
    """
    The answer, per branch and for the campaign as a whole, in a form an
    operator can act on: was this finished, or did it run out of money?
    """
    stops = db.expansion_stops(campaign_id)
    campaign = db.get_campaign(campaign_id) or {}
    overall = campaign.get("stopped_reason") or "unknown"

    exhausted = overall in EXHAUSTION_REASONS
    if overall in ("candidate_budget", "lead_budget", "api_budget", "time_limit",
                   "depth_limit") or str(overall).startswith("budget:"):
        verdict = ("A limit stopped this campaign before the search was finished. Raising "
                   "that limit and resuming would probably find more.")
    elif exhausted:
        verdict = ("This campaign stopped because the search was finished, not because a "
                   "limit was reached. Raising the budget would buy more of the same; a "
                   "different seed would not.")
    else:
        verdict = f"Campaign ended: {overall}."

    return {
        "campaign_id": campaign_id,
        "campaign_stop_reason": overall,
        "was_exhausted": exhausted,
        "verdict": verdict,
        "branches": [
            {"pivot_type": s["pivot_type"] or "(whole campaign)",
             "reason": s["reason"], "explanation": s["explanation"],
             "metrics": s["metrics"], "recorded_at": s["recorded_at"],
             "evidence_class": "derived"}
            for s in stops
        ],
        "note": ("Stop reasons distinguish a finished search from an exhausted budget. "
                 "That difference decides whether running this again would find anything."),
    }
