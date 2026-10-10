"""
Which sources and which pivots are actually producing anything.

Technique learning (technique_learning.py) answers "should I keep running this
pivot?" as a control decision. This module answers the operator's question:
*where is the useful work coming from?* — across discovery sources, pivot
types, campaigns and individual indicators, in one place, with the funnel
visible at every stage.

THE FUNNEL IS THE POINT
-----------------------
A source that surfaces 800 candidates and gets two past triage is worse than
one that surfaces 20 and gets twelve through, and a raw candidate count hides
that completely. So every row here carries the whole chain:

    candidates -> passed triage -> high priority -> sent to the platform

and the conversion rates between them. Those rates are what tell you where to
spend the next hour of runtime.

SMALL SAMPLES ARE MARKED, NOT HIDDEN
------------------------------------
A source with three candidates and a 100% conversion rate is not the best
source; it is an unmeasured one. Rows built on too little evidence say so
rather than being ranked as though the number meant something.
"""
import logging

from app import db
from app.config import TECHNIQUE_MIN_LEADS_FOR_CONFIDENCE

logger = logging.getLogger("scamhunter.discovery_stats")

# Below this many candidates, a conversion rate is noise dressed as a number.
MIN_CANDIDATES_FOR_RATE = 10


def _rate(numerator, denominator):
    return round(numerator / denominator, 3) if denominator else None


def _confidence_note(candidates: int) -> str:
    if candidates >= MIN_CANDIDATES_FOR_RATE:
        return ""
    return (f"Only {candidates} candidate(s) so far — the rates below are provisional and "
            f"should not be compared against sources with more evidence.")


def source_performance(limit: int = 50) -> dict:
    """
    Every discovery source, ranked by what it actually delivered. Sources with
    too little evidence are listed but flagged and sorted below measured ones,
    because promoting an unmeasured source over a proven one is exactly the
    mistake these numbers exist to prevent.
    """
    rows = []
    for record in db.list_source_yield(limit=limit * 2):
        candidates = record.get("candidates") or 0
        passed = record.get("passed_triage") or 0
        high = record.get("high_priority") or 0
        sent = record.get("sent_to_platform") or 0
        measured = candidates >= MIN_CANDIDATES_FOR_RATE
        rows.append({
            "source": record["source"],
            "candidates": candidates, "passed_triage": passed,
            "high_priority": high, "sent_to_platform": sent,
            "triage_rate": _rate(passed, candidates),
            "priority_rate": _rate(high, passed),
            "send_rate": _rate(sent, candidates),
            "measured": measured,
            "note": _confidence_note(candidates),
            "evidence_class": "derived",
        })

    rows.sort(key=lambda r: (r["measured"], r["send_rate"] or 0, r["passed_triage"]),
              reverse=True)
    return {
        "sources": rows[:limit],
        "note": ("Ranked by how many candidates each source produced that were worth sending "
                 "on, not by how many it produced. A source flagged as unmeasured has too "
                 "few results for its rates to mean anything yet."),
    }


def pivot_performance() -> dict:
    """The same funnel, per pivot technique, joined to what learning decided."""
    from app.discovery.technique_learning import compute_yield, technique_priority

    rows = []
    for stats in db.list_techniques():
        candidates = stats.get("candidates_returned") or 0
        unique_new = stats.get("unique_new_sites") or 0
        passed = stats.get("sites_passing_triage") or 0
        sent = stats.get("sites_sent_to_platform") or 0
        result = compute_yield(stats)
        rows.append({
            "pivot_type": stats["pivot_type"],
            "leads_executed": stats.get("leads_executed") or 0,
            "candidates": candidates, "unique_new": unique_new,
            "passed_triage": passed,
            "high_confidence": stats.get("sites_high_confidence") or 0,
            "sent_to_platform": sent,
            "uniqueness_rate": _rate(unique_new, candidates),
            "triage_rate": _rate(passed, unique_new),
            "send_rate": _rate(sent, unique_new),
            "yield_score": stats.get("yield_score"),
            "throttle_state": stats.get("throttle_state"),
            "priority_multiplier": technique_priority(stats["pivot_type"]),
            "measured": (stats.get("leads_executed") or 0) >= TECHNIQUE_MIN_LEADS_FOR_CONFIDENCE,
            "evidence_note": stats.get("evidence_note") or result["evidence_note"],
            "evidence_class": "derived",
        })

    rows.sort(key=lambda r: (r["measured"], r["send_rate"] or 0, r["yield_score"] or 0),
              reverse=True)
    return {
        "pivots": rows,
        "note": ("A technique's score reflects this installation's own results. Throttling "
                 "is reversible and a technique is never judged on a small sample."),
    }


def campaign_performance(campaign_id: int = None, limit: int = 25) -> dict:
    """
    Per campaign: what it cost, what it produced, and which of its pivots did
    the producing. This is the answer to "was that campaign worth running?".
    """
    campaigns = ([db.get_campaign(campaign_id)] if campaign_id
                 else db.list_campaigns(limit=limit))
    campaigns = [c for c in campaigns if c]

    rows = []
    for campaign in campaigns:
        stats = campaign.get("stats") or {}
        budget = {b["resource"]: b for b in db.campaign_budget_state(campaign["id"])}
        candidates = stats.get("candidates_found") or 0
        new_sites = stats.get("new_sites") or 0
        validated = stats.get("validated") or 0
        promoted = stats.get("promoted") or 0

        rows.append({
            "campaign_id": campaign["id"], "campaign_key": campaign["campaign_key"],
            "name": campaign.get("name"), "status": campaign.get("status"),
            "seed_kind": campaign.get("seed_kind"), "seed_value": campaign.get("seed_value"),
            "stopped_reason": campaign.get("stopped_reason"),
            "leads_executed": stats.get("leads_executed") or 0,
            "candidates": candidates, "new_sites": new_sites,
            "validated": validated, "promoted": promoted,
            "rejected_noise": stats.get("rejected_noise") or 0,
            "new_site_rate": _rate(new_sites, candidates),
            "validation_rate": _rate(validated, new_sites),
            "promotion_rate": _rate(promoted, validated),
            "budget_used": {k: {"used": v.get("used_value"), "limit": v.get("limit_value")}
                            for k, v in budget.items()},
            "cost_per_promoted": (round((stats.get("leads_executed") or 0) / promoted, 1)
                                  if promoted else None),
            "evidence_class": "derived",
        })

    return {
        "campaigns": rows,
        "note": ("cost_per_promoted is leads run per candidate that earned deep "
                 "investigation — the cheapest single measure of whether a campaign shape "
                 "is working."),
    }


def indicator_performance(limit: int = 40) -> dict:
    """Which individual indicator values are earning their budget."""
    from app.discovery.indicator_noise import noise_report
    report = noise_report(limit=limit)
    return {
        "watchlist": report["watchlist"], "retired": report["retired"],
        "thresholds": report["thresholds"], "note": report["note"],
    }


def overview() -> dict:
    """
    One call for the dashboard: the funnel end to end, plus the best and worst
    performers at each level.
    """
    sources = source_performance(limit=10)
    pivots = pivot_performance()
    outbox = db.outbox_stats()

    with db.get_conn() as conn:
        def count(sql):
            return conn.execute(sql).fetchone()["c"]
        total_sites = count("SELECT COUNT(*) c FROM sites")
        triaged = count("SELECT COUNT(*) c FROM triage_results")
        passed = count("SELECT COUNT(*) c FROM triage_results WHERE passed=1")
        sent = count("SELECT COUNT(*) c FROM site_investigations")

    measured_sources = [s for s in sources["sources"] if s["measured"]]
    measured_pivots = [p for p in pivots["pivots"] if p["measured"]]

    return {
        "funnel": {
            "discovered": total_sites, "triaged": triaged, "passed_triage": passed,
            "sent_to_platform": sent, "queued_for_platform": outbox["pending"],
        },
        "conversion": {
            "triage_rate": _rate(passed, triaged),
            "send_rate": _rate(sent, passed),
        },
        "best_source": measured_sources[0] if measured_sources else None,
        "worst_source": measured_sources[-1] if len(measured_sources) > 1 else None,
        "best_pivot": measured_pivots[0] if measured_pivots else None,
        "worst_pivot": measured_pivots[-1] if len(measured_pivots) > 1 else None,
        "retired_indicators": len(db.list_retired_indicators(limit=1000)),
        "note": ("Best and worst are drawn only from sources and pivots with enough results "
                 "to measure. An unmeasured source is not a good one, it is an unknown one."),
    }
