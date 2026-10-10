"""
Why this site was surfaced — the whole answer, in one object.

An analyst receiving a candidate should be able to understand it without
reading logs, without querying six tables, and without trusting a number. This
module assembles everything that went into surfacing one candidate: where it
came from, every route that reached it, what was observed on it, what was
concluded from those observations, what was decided before, and which
thresholds it cleared.

WHY THIS IS NOT A SCORE
-----------------------
Scores are how a machine ranks. Explanations are how a person checks. A single
number tells an analyst nothing about whether to trust it, and a ranked list of
opaque numbers is exactly the artifact that trains people to stop checking.

So every figure in here arrives with the evidence behind it and the arithmetic
that produced it, and the separate scores stay separate — priority, novelty,
convergence and evidence strength answer different questions and often
disagree, which is itself informative.

WHAT IT CLAIMS
--------------
Nothing about the site. This is a record of why Site Finder thought a domain
was worth an investigator's time. Shared indicators are observations; families
are groupings this software derived; downstream outcomes describe what someone
else found. None of it says a site is malicious, and the object is structured
so a reader cannot mistake a derivation for an observation.
"""
import logging

from app import db

logger = logging.getLogger("scamhunter.explain")


def why_surfaced(site_id: int) -> dict:
    """The complete explanation for one candidate."""
    from app.discovery import candidate_priority as cp
    from app.discovery import novelty as nov
    from app.discovery import path_quality as pq
    from app.discovery.dedup import corroboration_bonus
    from app.integration.v4.emitter import should_send_site

    site = db.get_site(site_id)
    if not site:
        return {"error": f"No site {site_id}."}

    domain = site["domain"]
    paths = db.paths_for_site(site_id)
    registration = db.get_candidate_registration(domain)
    convergence = db.get_convergence(site_id)
    cluster = db.cluster_for_site(site_id)
    triage = db.get_triage(site_id)
    link = db.get_site_investigation(site_id)

    decision = should_send_site(site_id)
    priority = decision.get("priority") or cp.score_candidate(site_id)
    novelty = nov.score(site_id)
    path_summary = pq.site_path_summary(site_id)
    corroboration = corroboration_bonus(site["url"])

    # --- the seed this ultimately came from ---
    origins = []
    for path in paths:
        if path.get("origin_domain") and path["origin_domain"] not in origins:
            origins.append(path["origin_domain"])

    # --- which indicators reached it, and were they independent? ---
    by_indicator_type = {}
    for path in paths:
        key = path.get("indicator_type") or "unknown"
        by_indicator_type.setdefault(key, []).append(path)
    independent_types = sorted(by_indicator_type)

    # --- what the techniques that found it have been worth ---
    technique_performance = []
    for pivot_type in sorted({p["pivot_type"] for p in paths if p.get("pivot_type")}):
        stats = db.get_technique(pivot_type) or {}
        attribution = db.get_attribution("pivot", pivot_type) or {}
        technique_performance.append({
            "pivot_type": pivot_type,
            "yield_score": stats.get("yield_score"),
            "throttle_state": stats.get("throttle_state"),
            "downstream_examined": attribution.get("candidates_examined"),
            "downstream_useful": attribution.get("useful"),
            "budget_multiplier": attribution.get("budget_multiplier"),
            "evidence_class": "derived",
        })

    return {
        "domain": domain, "url": site["url"], "site_id": site_id,

        # ---- where it came from ----
        "origin": {
            "discovery_source": site.get("source"),
            "discovery_reason": site.get("discovery_reason"),
            "discovery_confidence": site.get("discovery_confidence"),
            "seed_domains": origins,
            "first_seen_at": site.get("added_at"),
            "first_campaign": (registration or {}).get("first_campaign_key"),
            "evidence_class": "observed",
        },

        # ---- every route that reached it ----
        "discovery_paths": [
            {"path_text": p.get("path_text"), "pivot_type": p.get("pivot_type"),
             "indicator_type": p.get("indicator_type"),
             "indicator_value": p.get("indicator_value"),
             "depth": p.get("depth"), "link_strength": p.get("link_strength"),
             "origin_domain": p.get("origin_domain"),
             "evidence_class": "observed"}
            for p in paths
        ],
        "path_quality": {
            "best": path_summary.get("best_quality"),
            "useful_paths": path_summary.get("useful_paths"),
            "total_paths": path_summary.get("total_paths"),
            "detail": path_summary.get("paths", [])[:5],
            "note": path_summary.get("note"),
            "evidence_class": "derived",
        },

        # ---- convergence: independent agreement, not repetition ----
        "convergence": {
            "connection_score": (convergence or {}).get("connection_score"),
            "independent_indicator_types": independent_types,
            "paths_per_indicator_type": {k: len(v) for k, v in by_indicator_type.items()},
            "distinct_pivot_types": (convergence or {}).get("distinct_pivot_types"),
            "summary": (convergence or {}).get("summary"),
            "interpretation": (
                f"Reached through {len(independent_types)} independent indicator type(s). "
                + ("Several unrelated indicators agreeing is stronger than the same one "
                   "found repeatedly, because they fail for unrelated reasons."
                   if len(independent_types) > 1 else
                   "A single indicator type reached this candidate, so there is no "
                   "independent corroboration in the routes themselves.")),
            "evidence_class": "derived",
        },

        # ---- cross-campaign corroboration ----
        "corroboration": {
            "distinct_campaigns": (registration or {}).get("distinct_campaigns"),
            "distinct_sources": (registration or {}).get("distinct_sources"),
            "times_rediscovered": (registration or {}).get("times_rediscovered"),
            "bonus": corroboration.get("bonus"),
            "explanation": corroboration.get("explanation"),
            "evidence_class": "derived",
        },

        # ---- what was actually observed on it ----
        "observed_indicators": [
            {"indicator_type": r["indicator_type"], "value": r["value"],
             "source_url": r.get("source_url"), "source_method": r.get("source_method"),
             "site_count": r.get("site_count"),
             "still_present": bool(r.get("still_present", 1)),
             "evidence_class": "observed"}
            for r in db.indicators_for_site(site_id, only_current=True)
        ],
        "evidence_categories": sorted(decision.get("categories") or {}),

        # ---- triage ----
        "triage": ({
            "passed": bool(triage["passed"]),
            "score": triage.get("triage_score"),
            "indicator_count": triage.get("indicator_count"),
            "http_status": triage.get("http_status"),
            "reject_reason": triage.get("reject_reason"),
            "method": ("one unauthenticated HTTP GET; no browser, no crawl, no "
                       "authenticated access"),
            "evidence_class": "observed",
        } if triage else None),

        # ---- the separate scores, kept separate ----
        "priority": {
            "score": priority.get("priority"),
            "factors": priority.get("factors"),
            "explanation": priority.get("explanation"),
            "evidence_class": "derived",
        },
        "novelty": {
            "score": novelty.get("novelty"),
            "factors": novelty.get("factors"),
            "explanation": novelty.get("explanation"),
            "evidence_class": "derived",
        },

        # ---- family ----
        "cluster": ({
            "cluster_id": cluster["id"], "label": cluster.get("label"),
            "site_count": cluster.get("site_count"),
            "summary": cluster.get("summary"),
            "caveat": ("A family is a grouping this software derived from shared public "
                       "indicators. Shared hosting, copied templates, recycled "
                       "certificates and compromised sites all produce the same grouping."),
            "evidence_class": "derived",
        } if cluster else None),

        # ---- what we decided before, and what has changed ----
        "history": {
            "decisions": [
                {"decision": d["decision"], "reason": d.get("reason"),
                 "decided_at": d["decided_at"],
                 "superseded_by": d.get("superseded_by"),
                 "superseded_reason": d.get("superseded_reason")}
                for d in db.candidate_decision_history(domain)
            ],
            "downstream_outcomes": [
                {"outcome": f["outcome"], "deposit_pages": f["deposit_pages_found"],
                 "wallets": f["wallets_found"], "relationships": f["relationships_found"],
                 "detail": f["detail"], "received_at": f["received_at"],
                 "evidence_class": "observed"}
                for f in db.feedback_for_site(site_id)
            ],
            "timeline": db.timeline_for_site(site_id, limit=50),
        },

        # ---- how the techniques that found it have performed ----
        "technique_performance": technique_performance,

        # ---- the promotion decision itself ----
        "promotion": {
            "would_send": decision.get("send"),
            "high_priority": decision.get("high_priority"),
            "reasons_passed": decision.get("reasons"),
            "blocked_by": decision.get("blocked_by"),
            "evidence_class": "derived",
        },

        # ---- where it went ----
        "platform": ({
            "investigation_id": link.get("investigation_id"),
            "correlation_id": link.get("correlation_id"),
            "investigator_job_id": link.get("investigator_job_id"),
            "state": link.get("platform_state"),
            "events_sent": link.get("events_sent"),
            "last_sent_at": link.get("last_sent_at"),
        } if link else None),

        "note": (
            "This records why Site Finder judged this domain worth an investigator's time. "
            "Rows marked observed were recorded from public sources and are checkable; "
            "rows marked derived are conclusions this software reached by comparing them. "
            "Nothing here is a finding about the site or about anyone connected with it — "
            "Site Finder performed discovery and one unauthenticated triage fetch, and has "
            "not crawled the site."),
    }


def summary_line(site_id: int) -> str:
    """One sentence, for a list view."""
    full = why_surfaced(site_id)
    if full.get("error"):
        return full["error"]
    return (
        f"{full['domain']}: reached by "
        f"{len(full['convergence']['independent_indicator_types'])} independent indicator "
        f"type(s) from {', '.join(full['origin']['seed_domains']) or full['origin']['discovery_source']}; "
        f"priority {full['priority']['score']}, novelty {full['novelty']['score']}"
        + (f", {len(full['evidence_categories'])} evidence categories"
           if full["evidence_categories"] else "")
        + ".")
