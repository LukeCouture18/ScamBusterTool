"""Marginal deployment value. Categories describe discovery quality, never attribution."""
from __future__ import annotations

CATEGORIES = ("novel useful deployment", "already-known deployment", "generic infrastructure neighbor",
              "template-only similarity", "likely unrelated", "dead site", "reappeared site",
              "possible replacement", "needs investigation")

def assess(candidate: dict, keys=(), known_domains=()) -> dict:
    d = candidate.get("details") or {}
    ng = d.get("ng") or {}
    score = d.get("score") or {}
    signals = candidate.get("signals") or []
    groups = {s.get("group") for s in signals if float(s.get("strength") or 0) >= .5}
    observed = {k for k, v in keys if v and k in ("service", "wallet", "asset", "analytics", "san")}
    p = float(candidate.get("p") or 0)
    status = d.get("site_status")
    known = candidate["domain"] in set(known_domains) or bool(ng.get("known_elsewhere"))
    if known:
        category, marginal = "already-known deployment", 0.0
    elif status in ("dead", "gone", "suspended"):
        category, marginal = "dead site", 0.0
    elif ng.get("reappearance_of"):
        category, marginal = "reappeared site", 1.0
    elif ng.get("replacement_of"):
        category, marginal = "possible replacement", .9
    elif groups and groups <= {"infrastructure", "hosting", "dns"} and not score.get("core") and not observed:
        category, marginal = "generic infrastructure neighbor", .02
    elif groups and groups <= {"template", "similarity"} and not score.get("core"):
        category, marginal = "template-only similarity", .08
    elif p < .35:
        category, marginal = "likely unrelated", .02
    elif ng.get("covered_by") and not observed:
        category, marginal = "needs investigation", .15
    elif score.get("core") and p >= .8:
        category, marginal = "novel useful deployment", .8
    else:
        category, marginal = "needs investigation", .5
    if observed and marginal > 0:
        marginal = min(1.0, marginal + .08 * min(2, len(observed)))
    # Deployment continuity can matter even when the wallet differs. Raw wallet keys
    # are observed artifacts, NOT confirmed wallets; WI remains authoritative.
    return {"category": category, "new": not known, "marginal": marginal,
            "observed_artifact_types": sorted(observed), "attribution": "Unknown",
            "next": "Main investigates public evidence within budget" if marginal >= .5 else
                    "Keep as context; do not create routine investigation work",
            "why": "New deployment evidence is compared with known deployments and branch coverage. Shared kit, hosting, or wallet strings do not prove an operator."}

def adjusted_quality(base: float, quality: dict) -> float:
    # Probability still dominates large quality differences. Within close calls,
    # spend scarce slots on new deployments and temporal change, not redundant context.
    return round(base + .12 * (quality["marginal"] - .5), 5)

def branch_factor(state: dict, *, temporal: bool, round_no: int) -> float:
    """Actual marginal yield, with due temporal questions reopening a spent branch."""
    if state.get("generic"):
        return 0.0
    if temporal and round_no - int(state.get("last_round") or 0) >= 2:
        return .6
    if state.get("exhausted") or int(state.get("cooldown_until") or 0) > round_no:
        return 0.0
    if not state:
        return 1.0
    total, new = int(state.get("last_total") or 0), int(state.get("last_new") or 0)
    return max(.05, min(1.0, (new + 1) / (total + 2)))
