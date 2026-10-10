"""
Spending more where it works, without starving everything else.

Technique learning decides whether a pivot is worth running at all. This
module decides how much of a campaign's budget each one gets — a softer,
continuous version of the same judgement, driven by the downstream verdict
rather than by Site Finder's own opinion.

THE TWO WAYS THIS GOES WRONG
----------------------------
Both failure modes are about feedback loops, and both are guarded explicitly:

  runaway winner   the technique that happens to do well early takes the whole
                   budget, so no other technique ever gets the results it would
                   need to compete. The multiplier is capped, and a share of
                   every campaign is reserved for unproven techniques.

  premature loser  one unlucky run pushes a technique's share toward zero, and
                   with no budget it can never earn its way back. The multiplier
                   has a floor, and nothing moves at all until there is enough
                   feedback to judge.

The floor and the exploration reserve are what keep this a learning system
rather than a system that locks in its first impression.

ALLOCATION IS EXPLAINED
-----------------------
Every allocation states the numbers behind it. "Why is cert_san only getting
12% of this campaign?" always has an answer, and that answer is checkable
against the stored feedback counts.
"""
import logging

from app import db
from app.config import (
    BUDGET_MIN_MULTIPLIER, BUDGET_MAX_MULTIPLIER, BUDGET_EXPLORATION_FLOOR,
    FEEDBACK_NEUTRAL_SCORE,
)

logger = logging.getLogger("scamhunter.budget_allocator")


def multiplier_for(usefulness_result: dict) -> float:
    """
    Maps a usefulness score onto a budget multiplier. An unconfident score
    returns exactly 1.0 — no evidence means no reallocation, in either
    direction.
    """
    if not usefulness_result.get("confident"):
        return 1.0

    score = usefulness_result["usefulness_score"]
    # Neutral maps to 1.0; the span above and below is scaled independently so
    # a good technique can double while a poor one is only ever reduced to the
    # floor, never removed.
    if score >= FEEDBACK_NEUTRAL_SCORE:
        span = (score - FEEDBACK_NEUTRAL_SCORE) / (1.0 - FEEDBACK_NEUTRAL_SCORE)
        return round(1.0 + span * (BUDGET_MAX_MULTIPLIER - 1.0), 3)
    span = (FEEDBACK_NEUTRAL_SCORE - score) / FEEDBACK_NEUTRAL_SCORE
    return round(1.0 - span * (1.0 - BUDGET_MIN_MULTIPLIER), 3)


def pivot_multiplier(pivot_type: str) -> float:
    """The stored multiplier for one technique, or 1.0 if nothing is known."""
    row = db.get_attribution("pivot", pivot_type)
    if not row:
        return 1.0
    return row.get("budget_multiplier") or 1.0


def allocate(total_budget: int, pivot_types: list) -> dict:
    """
    Splits a campaign's lead budget across techniques.

    Returns {"allocation": {pivot_type: leads}, "explanation": str,
             "reserved_for_exploration": int}.
    """
    if total_budget <= 0 or not pivot_types:
        return {"allocation": {}, "reserved_for_exploration": 0,
                "explanation": "Nothing to allocate."}

    pivot_types = list(dict.fromkeys(pivot_types))

    # Anything with no confident feedback is unproven and draws from the
    # reserved exploration share, not from the performance split. Otherwise a
    # newly added technique could never accumulate the evidence to be judged.
    proven, unproven = [], []
    for pivot_type in pivot_types:
        row = db.get_attribution("pivot", pivot_type)
        if row and (row.get("candidates_examined") or 0) > 0 and (
                row.get("budget_multiplier") or 1.0) != 1.0:
            proven.append(pivot_type)
        else:
            unproven.append(pivot_type)

    reserved = int(round(total_budget * BUDGET_EXPLORATION_FLOOR)) if unproven else 0
    # Never reserve so much that proven techniques get nothing.
    reserved = min(reserved, max(0, total_budget - len(proven)))
    performance_pool = total_budget - reserved

    allocation = {}
    if proven and performance_pool > 0:
        weights = {p: max(BUDGET_MIN_MULTIPLIER, pivot_multiplier(p)) for p in proven}
        total_weight = sum(weights.values()) or 1.0
        for pivot_type, weight in weights.items():
            allocation[pivot_type] = max(1, int(performance_pool * weight / total_weight))
    elif performance_pool > 0 and unproven:
        # Nothing proven yet: split evenly and let the results decide.
        per = max(1, performance_pool // len(unproven))
        for pivot_type in unproven:
            allocation[pivot_type] = per

    if unproven and reserved > 0:
        per = max(1, reserved // len(unproven))
        for pivot_type in unproven:
            allocation[pivot_type] = allocation.get(pivot_type, 0) + per

    parts = []
    for pivot_type in sorted(allocation, key=lambda p: -allocation[p]):
        row = db.get_attribution("pivot", pivot_type)
        if row and row.get("candidates_examined"):
            parts.append(f"{pivot_type} {allocation[pivot_type]} "
                         f"(usefulness {row.get('usefulness_score', 0.5):.2f} over "
                         f"{row['candidates_examined']} examined)")
        else:
            parts.append(f"{pivot_type} {allocation[pivot_type]} (unproven, exploring)")

    explanation = (
        f"{total_budget} lead(s) split across {len(allocation)} technique(s): "
        + "; ".join(parts) + "."
        + (f" {reserved} lead(s) reserved for techniques with no downstream results yet, so "
           "a new or unlucky technique can still earn its way back."
           if reserved else "")
    )

    return {"allocation": allocation, "reserved_for_exploration": reserved,
            "explanation": explanation, "evidence_class": "derived"}


def allocation_report() -> dict:
    """What the allocator currently believes, and why."""
    rows = db.list_attributions(key_kind="pivot")
    out = []
    for row in rows:
        examined = row.get("candidates_examined") or 0
        out.append({
            "pivot_type": row["key_value"],
            "candidates_examined": examined,
            "useful": row.get("useful") or 0,
            "thin": row.get("thin") or 0,
            "unreachable": row.get("unreachable") or 0,
            "usefulness_score": row.get("usefulness_score"),
            "budget_multiplier": row.get("budget_multiplier"),
            "evidence_note": row.get("evidence_note") or "",
            "status": ("proven" if (row.get("budget_multiplier") or 1.0) != 1.0
                       else "unproven — no budget moved"),
            "evidence_class": "derived",
        })
    out.sort(key=lambda r: -(r["budget_multiplier"] or 1.0))
    return {
        "pivots": out,
        "bounds": {"min_multiplier": BUDGET_MIN_MULTIPLIER,
                   "max_multiplier": BUDGET_MAX_MULTIPLIER,
                   "exploration_floor": BUDGET_EXPLORATION_FLOOR},
        "note": ("Budget follows downstream usefulness, bounded on both sides: a strong "
                 "technique cannot take everything, and a weak one is never reduced to zero "
                 "— it keeps a share so it can earn its way back if the web changes."),
    }
