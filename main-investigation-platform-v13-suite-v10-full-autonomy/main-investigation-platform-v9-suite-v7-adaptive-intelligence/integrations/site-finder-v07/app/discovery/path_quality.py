"""
Scoring the route, not just the destination.

Convergence already asks "how many independent ways did we reach this domain?".
This module asks a different and equally important question: *how good was each
of those routes?*

Two candidates can both be reached by exactly one pivot and be completely
different propositions. One hop from a confirmed site on a shared wallet
address is a strong route. Three hops through a nameserver used by 40,000
domains is a route that means almost nothing — and before v0.6 both arrived
looking the same.

WHAT MAKES A PATH GOOD
----------------------
  indicator quality   is the linking indicator something an operator supplies
                      (a wallet, a contact handle, an analytics property) or
                      something they inherit from a host?
  breadth             how many other sites carry the same indicator? An
                      indicator on 12 sites is a weaker link than one on 2,
                      and one on 4,000 is not a link at all.
  depth               every hop compounds uncertainty, so distance costs.
  technique quality   what has this pivot type actually produced before?
  feedback            did candidates found this way turn out to contain
                      anything worth examining?

The first three are properties of the evidence and are known immediately. The
last two are learned, and contribute nothing until there is enough evidence to
support them — an unproven technique neither helps nor hurts a path's score.

WHAT A HIGH SCORE MEANS
-----------------------
That the route is worth following, and nothing else. A strong path to a domain
is still only a reason to look at that domain. It is not evidence that the two
sites share an operator, that either is malicious, or that anything has been
established about either one.
"""
import logging

from app import db
from app.db import INDICATOR_STRENGTH, STRONG_INDICATOR_TYPES
from app.config import (
    PATH_DEPTH_PENALTY, PATH_BREADTH_PENALTY_AT, PATH_MIN_USEFUL_QUALITY,
)

logger = logging.getLogger("scamhunter.path_quality")

# Indicators an operator supplies rather than inherits. A path resting on one
# of these is a materially different kind of lead from one resting on hosting.
OPERATOR_SUPPLIED = set(STRONG_INDICATOR_TYPES) | {
    "wallet", "telegram", "whatsapp", "email", "phone",
    "analytics_id", "adsense_id", "gtag_id",
}


def score_path(path: dict) -> dict:
    """
    Scores one discovery path. Returns component scores plus an explanation
    that states each contribution, so the total is never an opaque number.
    """
    indicator_type = path.get("indicator_type") or ""
    indicator_value = path.get("indicator_value") or ""
    depth = path.get("depth") or 0
    pivot_type = path.get("pivot_type") or ""

    # --- indicator quality ---
    base_strength = INDICATOR_STRENGTH.get(indicator_type, 0.3)
    operator_supplied = indicator_type in OPERATOR_SUPPLIED
    indicator_quality = base_strength * (1.15 if operator_supplied else 0.85)
    indicator_quality = min(1.0, indicator_quality)

    # --- breadth penalty ---
    site_count = 0
    if indicator_type and indicator_value:
        with db.get_conn() as conn:
            row = conn.execute(
                "SELECT site_count FROM indicators WHERE indicator_type=? AND value=?",
                (indicator_type, indicator_value)).fetchone()
            site_count = (row["site_count"] if row else 0) or 0

    breadth_penalty = 0.0
    if site_count > PATH_BREADTH_PENALTY_AT:
        # Logarithmic: going from 12 to 24 sites matters more than 4,000 to 8,000,
        # because by then the indicator has already stopped being a link.
        import math
        breadth_penalty = min(0.6, 0.18 * math.log2(site_count / PATH_BREADTH_PENALTY_AT + 1))

    # --- depth penalty ---
    depth_penalty = min(0.6, PATH_DEPTH_PENALTY * depth)

    # --- learned technique quality (contributes only when proven) ---
    technique_quality = 0.0
    technique_note = "no learned adjustment for this technique yet"
    stats = db.get_technique(pivot_type) if pivot_type else None
    if stats and (stats.get("leads_executed") or 0) > 0:
        yield_score = stats.get("yield_score")
        if yield_score is not None and stats.get("throttle_state") != "normal" or (
                yield_score is not None and (stats.get("leads_executed") or 0) >= 5):
            technique_quality = round((yield_score - 0.5) * 0.2, 3)
            technique_note = (f"technique yield {yield_score:.2f} "
                              f"({'+' if technique_quality >= 0 else ''}{technique_quality:.3f})")

    # --- downstream feedback (contributes only when confident) ---
    feedback_bonus = 0.0
    feedback_note = "no downstream feedback for this technique yet"
    attribution = db.get_attribution("pivot", pivot_type) if pivot_type else None
    if attribution and (attribution.get("budget_multiplier") or 1.0) != 1.0:
        usefulness = attribution.get("usefulness_score") or 0.5
        feedback_bonus = round((usefulness - 0.5) * 0.3, 3)
        feedback_note = (f"downstream usefulness {usefulness:.2f} over "
                         f"{attribution.get('candidates_examined', 0)} examined "
                         f"({'+' if feedback_bonus >= 0 else ''}{feedback_bonus:.3f})")

    quality = indicator_quality - breadth_penalty - depth_penalty \
        + technique_quality + feedback_bonus
    quality = round(max(0.0, min(1.0, quality)), 3)

    explanation = (
        f"Path quality {quality:.2f}. "
        f"Linking indicator is {indicator_type or 'unknown'} "
        f"({'operator-supplied' if operator_supplied else 'inherited from hosting'}, "
        f"base strength {base_strength:.2f} → {indicator_quality:.2f}). "
        + (f"It appears on {site_count} site(s), costing {breadth_penalty:.2f} — the more "
           "sites carry an indicator, the less it links any two of them. "
           if breadth_penalty else
           f"It appears on {site_count} site(s), narrow enough not to cost anything. ")
        + (f"{depth} hop(s) from the seed costs {depth_penalty:.2f}. " if depth_penalty
           else "Directly from the seed, so no distance penalty. ")
        + f"Learned: {technique_note}; {feedback_note}. "
        + ("This scores how good the ROUTE is, not what it found. A strong route is a "
           "reason to look at the domain — not evidence that two sites share an operator "
           "or that either is doing anything wrong.")
    )

    return {
        "quality_score": quality,
        "indicator_quality": round(indicator_quality, 3),
        "breadth_penalty": round(breadth_penalty, 3),
        "depth_penalty": round(depth_penalty, 3),
        "technique_quality": technique_quality,
        "feedback_bonus": feedback_bonus,
        "site_count": site_count,
        "operator_supplied": operator_supplied,
        "explanation": explanation,
        "useful": quality >= PATH_MIN_USEFUL_QUALITY,
        "evidence_class": "derived",
    }


def rescore_all(limit: int = 5000) -> dict:
    """Recomputes quality for every stored discovery path."""
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM discovery_paths ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        paths = [dict(r) for r in rows]

    scored = weak = 0
    for path in paths:
        result = score_path(path)
        db.save_path_quality(path["id"], path["site_id"], result, result["explanation"])
        scored += 1
        if not result["useful"]:
            weak += 1

    return {"scored": scored, "below_useful_threshold": weak,
            "threshold": PATH_MIN_USEFUL_QUALITY,
            "note": (f"{weak} of {scored} path(s) scored below {PATH_MIN_USEFUL_QUALITY:.2f}. "
                     "A weak path is still recorded — it explains how a domain was reached "
                     "— it just should not be the reason anyone spends time on it.")}


def site_path_summary(site_id: int) -> dict:
    """
    The best route to a site and how it compares to the others. This is what
    prioritisation should read rather than the raw path count.
    """
    rows = db.path_quality_for_site(site_id)
    if not rows:
        return {"site_id": site_id, "best_quality": None, "paths": [],
                "note": "No scored discovery paths for this site."}

    best = rows[0]
    useful = [r for r in rows if (r["quality_score"] or 0) >= PATH_MIN_USEFUL_QUALITY]
    return {
        "site_id": site_id,
        "best_quality": best["quality_score"],
        "useful_paths": len(useful), "total_paths": len(rows),
        "paths": [
            {"path_text": r.get("path_text"), "pivot_type": r.get("pivot_type"),
             "depth": r.get("depth"), "quality_score": r.get("quality_score"),
             "explanation": r.get("explanation"), "evidence_class": "derived"}
            for r in rows
        ],
        "note": (f"{len(useful)} of {len(rows)} route(s) to this domain are strong enough to "
                 "act on. Route quality describes the link, not the site."),
    }
