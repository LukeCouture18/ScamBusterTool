"""Evidence-aware, bounded shortlist selection over already eligible candidates.

This never overrides the probe gate or manufactures evidence.  The probability
remains the dominant term; independent corroboration and diversity break close
calls, while a large quality gap always wins over variety.
"""
from __future__ import annotations

def evaluate_v3(candidate: dict, sightings: list | None = None, keys: list | None = None) -> dict:
    signals = candidate.get("signals") or []
    groups = {s.get("group") for s in signals if s.get("group") and s.get("strength", 0) >= 0.5}
    routes = {s.get("strategy") for s in (sightings or []) if s.get("strategy") and s.get("strategy") != "recheck"}
    routes.update(candidate.get("strategies") or [])
    # A hundred hits from one source are still one source.  A kit's shared IP
    # or page template is context, not an independent endorsement.
    strong_keys = {k for k, v in (keys or []) if k in ("wallet", "service", "san", "favtmpl") and v}
    score = candidate.get("details", {}).get("score", {})
    p = float(candidate.get("p") or 0)
    evidence = min(0.075, max(0, len(groups) - 1) * 0.025)
    convergence = min(0.025, max(0, len(routes) - 1) * 0.0125)
    distinct = 0.015 if strong_keys else 0
    investigation = candidate.get("details", {}).get("investigation_context") or {}
    # This records a real, independently probed path. It is a small tie-breaker
    # after eligibility and page evidence, never a substitute for either.
    path_credit = min(.02, .01 * int(investigation.get("depth") or 0)) if investigation.get("provenance") else 0
    # Next gen: new operation / reappearance / new wallets (bounded, <= 0.05). Never overrides p.
    novelty = candidate.get("details", {}).get("ng") or {}
    ng_bonus = min(0.05, max(-0.08, float(novelty.get("bonus") or 0)))
    # Learning is already bounded in p; never count it a second time here.
    quality = round(p + evidence + convergence + distinct + path_credit + ng_bonus, 5)
    reasons = []
    if len(groups) > 1:
        reasons.append(f"{len(groups)} distinct evidence types")
    if len(routes) > 1:
        reasons.append(f"{len(routes)} independent discovery routes")
    if strong_keys:
        reasons.append("distinctive infrastructure evidence")
    if path_credit:
        reasons.append(f"validated through a {investigation['depth']}-step investigation path")
    for fact in (novelty.get("facts") or [])[:1]:
        reasons.append(fact[0].lower() + fact[1:].rstrip("."))
    if not reasons:
        reasons.append("strongest available on-page evidence")
    # v3: expected investigation value (probability it is worth your time x what investigating it
    # would add: a new site family, a return after a takedown, a deeper find). Reported, and used only
    # through the bounded novelty bonus above, so it never outranks clearly stronger evidence.
    ev = novelty.get("expected_value")
    hunt = ((novelty.get("explain") or {}).get("hunt_id")) or None
    if novelty.get("new_family"):
        reasons.insert(0, "possibly a new kind of scam site")
    return {"quality": quality, "probability": p, "evidence_groups": sorted(groups),
            "expected_value": ev, "hunt": hunt,
            "routes": sorted(routes), "keys": sorted(strong_keys),
            "gate_probability": score.get("p_gate"), "investigation_credit": path_credit,
            "investigation_path": investigation.get("path_id"), "novelty": ng_bonus, "reasons": reasons}


def evaluate(candidate: dict, sightings: list | None = None, keys: list | None = None) -> dict:
    import os
    result = evaluate_v3(candidate, sightings, keys)
    if os.environ.get("SITE_FINDER_POLICY") == "v3":
        return result
    from app.v2.discovery_v4 import assess, adjusted_quality
    quality = assess(candidate, keys or [])
    result["discovery_quality"] = quality
    result["quality"] = adjusted_quality(result["quality"], quality)
    result["reasons"].insert(0, quality["category"])
    return result


def shortlist(candidates: list[dict], limit: int, observations=None, existing: list[dict] | None = None) -> list[dict]:
    """Return candidates with selection details, keeping diversification local.

    `observations` returns (sightings, keys). Existing ready slots count toward
    variety at delivery time; no historical site is ever made eligible here.
    """
    observations = observations or (lambda c: ([], []))
    pending = []
    for cand in candidates:
        sights, keys = observations(cand)
        pending.append((cand, evaluate(cand, sights, keys)))
    chosen = list(existing or [])
    output = []
    while pending and len(output) < limit:
        def adjusted(item):
            cand, analysis = item
            cluster = cand.get("_campaign") or cand.get("cluster_id")
            redundancy = 0.0
            for prior in chosen:
                if cluster and cluster == (prior.get("_campaign") or prior.get("cluster_id")):
                    redundancy = max(redundancy, 0.085)
                elif (set(analysis["evidence_groups"]) == set(prior.get("_selection_groups", []))
                      and set(analysis["routes"]) == set(prior.get("_selection_routes", []))
                      and analysis["evidence_groups"]):
                    redundancy = max(redundancy, 0.025)
                if (analysis.get("investigation_path") and
                        analysis["investigation_path"] == prior.get("_selection_investigation_path")):
                    redundancy = max(redundancy, 0.025)
                if analysis.get("hunt") and analysis["hunt"] == prior.get("_selection_hunt"):
                    redundancy = max(redundancy, 0.02)      # one line of inquiry should not take every slot
            return (round(analysis["quality"] - redundancy, 5), analysis["quality"], cand["domain"])
        winner = max(pending, key=adjusted)
        pending.remove(winner)
        cand, analysis = winner
        cluster = cand.get("_campaign") or cand.get("cluster_id")
        close_cluster = any(cluster and cluster == (x.get("_campaign") or x.get("cluster_id")) for x in chosen)
        reason = "; ".join(analysis["reasons"])
        if chosen and not close_cluster:
            reason += "; adds a different discovery cluster to the shortlist"
        if cand.get("_campaign"):
            reason += f"; related to {cand['_campaign']}"
        analysis["why_selected"] = f"Selected for review: {reason}."
        output.append({**cand, "selection": analysis})
        chosen.append({**cand, "_selection_groups": analysis["evidence_groups"],
                       "_selection_routes": analysis["routes"],
                       "_selection_investigation_path": analysis.get("investigation_path"),
                       "_selection_hunt": analysis.get("hunt")})
    return output
