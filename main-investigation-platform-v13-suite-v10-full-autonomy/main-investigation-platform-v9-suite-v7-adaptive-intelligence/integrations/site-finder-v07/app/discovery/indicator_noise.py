"""
Stopping the engine from spending its budget on indicators that never pay.

v0.3 had a static defence: an indicator on more than N sites is infrastructure,
so don't pivot on it. That catches the obvious cases and misses the expensive
ones — an indicator that looks discriminating by site count but has, in
practice, returned two hundred candidates and never once produced something
that survived triage. The static rule cannot see that, because it is a
statement about the indicator's shape rather than about its results.

So v0.5 adds a measured defence alongside the static one. Every indicator that
generates leads accumulates its own record: how many candidates it returned,
how many were new, how many survived triage, how many were worth sending on.
An indicator with a large sample and nothing to show for it is retired.

TWO GATES, DIFFERENT JOBS
-------------------------
  static    cheap, applies immediately, catches shared hosting and CDNs before
            any budget is spent
  measured  needs evidence, catches the ones that look fine and aren't

RETIREMENT IS REVERSIBLE AND EXPLAINED
--------------------------------------
Retiring is "stop spending here", not a verdict about the indicator. It is
recorded with the numbers that justified it, and the observation itself is
never deleted — an indicator that is useless for *finding* new sites can still
be exactly the evidence that matters when an investigator looks at one.

A SMALL SAMPLE IS NOT EVIDENCE
------------------------------
Nothing is retired before INDICATOR_NOISE_MIN_CANDIDATES results have come in.
Retiring on a handful of unlucky lookups would remove good indicators, and the
whole point of measuring is to do better than guessing.
"""
import logging

from app import db
from app.config import (
    INDICATOR_NOISE_SITE_COUNT, INDICATOR_NOISE_MIN_CANDIDATES,
    INDICATOR_NOISE_MAX_SURVIVAL, PIVOT_MAX_INDICATOR_SITE_COUNT,
)

logger = logging.getLogger("scamhunter.indicator_noise")


def should_pivot_on(indicator_type: str, value: str, site_count: int = None) -> tuple:
    """
    The gate applied before an indicator becomes a lead.
    Returns (allowed, reason). A refusal always says which gate refused and why.
    """
    record = db.get_indicator_yield(indicator_type, value)
    if record and record.get("retired"):
        return False, (record.get("retired_reason")
                       or "retired earlier for producing no useful discoveries")

    # Static gate: the type-specific cap, then a global backstop.
    limit = PIVOT_MAX_INDICATOR_SITE_COUNT.get(indicator_type)
    if limit and site_count and site_count > limit:
        return False, (f"{indicator_type} appears on {site_count} sites, over the "
                       f"{limit}-site cap for this type — it describes hosting, not this site")
    if site_count and site_count > INDICATOR_NOISE_SITE_COUNT:
        return False, (f"{indicator_type} appears on {site_count} sites, over the global "
                       f"{INDICATOR_NOISE_SITE_COUNT}-site noise ceiling")

    # Measured gate: enough evidence, and nothing to show for it.
    if record:
        candidates = record.get("candidates_returned") or 0
        passed = record.get("sites_passing_triage") or 0
        if candidates >= INDICATOR_NOISE_MIN_CANDIDATES:
            survival = passed / candidates
            if survival <= INDICATOR_NOISE_MAX_SURVIVAL:
                return False, (
                    f"{candidates} candidate(s) have come from this indicator and "
                    f"{passed} survived triage ({survival:.1%}, at or below the "
                    f"{INDICATOR_NOISE_MAX_SURVIVAL:.1%} floor). It is returning volume "
                    "without results.")

    return True, ""


def evaluate_and_retire(progress_cb=None) -> dict:
    """
    Sweeps every measured indicator and retires the ones that have earned it.
    Called after a campaign so the next one starts with what was learned.
    """
    progress = progress_cb or (lambda e, d: None)
    retired, kept, insufficient = [], 0, 0

    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM indicator_yield WHERE retired=0").fetchall()
        records = [dict(r) for r in rows]

    for record in records:
        candidates = record.get("candidates_returned") or 0
        passed = record.get("sites_passing_triage") or 0
        sent = record.get("sites_sent_to_platform") or 0

        if candidates < INDICATOR_NOISE_MIN_CANDIDATES:
            insufficient += 1
            continue

        survival = passed / candidates
        if survival > INDICATOR_NOISE_MAX_SURVIVAL or sent > 0:
            kept += 1
            continue

        reason = (
            f"Retired from pivoting: {record['leads_executed']} lead(s) returned "
            f"{candidates} candidate(s), of which {passed} cleared triage ({survival:.1%}) "
            f"and {sent} were worth sending on. That is volume without results, so it "
            "stops consuming discovery budget. The observation itself is kept — an "
            "indicator that is useless for finding new sites can still be evidence about "
            "a site already found.")
        db.retire_indicator(record["indicator_type"], record["indicator_value"], reason)
        retired.append({"indicator_type": record["indicator_type"],
                         "value": record["indicator_value"],
                         "candidates": candidates, "passed_triage": passed,
                         "reason": reason})
        progress("indicator_retired", {
            "indicator_type": record["indicator_type"],
            "value": str(record["indicator_value"])[:48], "reason": reason})

    return {
        "retired": len(retired), "kept": kept,
        "too_little_evidence": insufficient, "details": retired[:50],
        "note": (f"{len(retired)} indicator(s) retired from pivoting, {kept} still earning "
                 f"their budget, {insufficient} with fewer than "
                 f"{INDICATOR_NOISE_MIN_CANDIDATES} candidates so far — too little evidence "
                 "to judge, and left alone."),
    }


def reinstate(indicator_type: str, value: str) -> bool:
    """
    Puts a retired indicator back in play. Retirement is a budget decision, not
    a verdict, so a person can always overrule it.
    """
    with db.get_conn() as conn:
        cur = conn.execute(
            "UPDATE indicator_yield SET retired=0, retired_reason=NULL "
            "WHERE indicator_type=? AND indicator_value=?", (indicator_type, value))
        return cur.rowcount > 0


def noise_report(limit: int = 50) -> dict:
    """What has been retired, and what is closest to it."""
    retired = db.list_retired_indicators(limit=limit)
    with db.get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM indicator_yield
               WHERE retired=0 AND candidates_returned > 0
               ORDER BY (CAST(sites_passing_triage AS REAL) /
                         NULLIF(candidates_returned,0)) ASC,
                        candidates_returned DESC
               LIMIT ?""", (limit,)).fetchall()
        watchlist = []
        for row in rows:
            record = dict(row)
            candidates = record["candidates_returned"] or 0
            passed = record["sites_passing_triage"] or 0
            watchlist.append({
                **record,
                "survival_rate": round(passed / candidates, 3) if candidates else None,
                "evidence_class": "derived",
                "status": ("watching" if candidates >= INDICATOR_NOISE_MIN_CANDIDATES
                            else "too little evidence to judge"),
            })

    return {
        "retired": retired, "watchlist": watchlist,
        "thresholds": {
            "min_candidates_before_judging": INDICATOR_NOISE_MIN_CANDIDATES,
            "max_survival_rate": INDICATOR_NOISE_MAX_SURVIVAL,
            "site_count_ceiling": INDICATOR_NOISE_SITE_COUNT,
        },
        "note": ("Retirement stops an indicator generating new leads. It does not delete the "
                 "observation or say anything about the sites carrying it, and it can be "
                 "reversed."),
    }
