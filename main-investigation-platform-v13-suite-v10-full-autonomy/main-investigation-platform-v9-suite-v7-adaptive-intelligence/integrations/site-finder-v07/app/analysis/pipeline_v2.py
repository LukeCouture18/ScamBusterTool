"""
The quality-over-quantity pipeline.

    Mass discovery -> Fast triage -> Risk scoring -> Deep analysis
                   -> Wallet validation -> High-confidence results

The shape of this is deliberate: each stage is cheaper per-site than the next
and much wider, so the expensive work lands only on candidates that have
already proven themselves. Concretely, for a typical run:

    discovery   : thousands of domains      (~0 cost each, mostly DNS/CT lookups)
    triage      : hundreds-to-thousands     (one small HTTP GET each)
    deep analysis: tens                     (full browser session + enrichment each)
    results     : a handful                 (only those clearing the confidence bar)

That funnel is what produces "fewer, higher-confidence websites with
significantly more useful evidence" rather than a wall of weak keyword hits.
"""
import logging
import time

from app import db
from app.config import (
    TRIAGE_BATCH_SIZE, DEEP_ANALYSIS_BATCH_SIZE, HIGH_CONFIDENCE_THRESHOLD,
)
from app.analysis.triage import triage_site
from app.analysis.deep_analyzer import analyze_site

logger = logging.getLogger("scamhunter.analysis.pipeline")


def run_triage_stage(limit: int = TRIAGE_BATCH_SIZE, progress_cb=None, should_stop=None) -> dict:
    """
    Triages untriaged sites. Cheap and wide — this is the stage that should run
    across the whole discovery pool.
    """
    progress = progress_cb or (lambda event, data: None)
    stop = should_stop or (lambda: False)

    sites = db.sites_awaiting_triage(limit=limit)
    if not sites:
        return {"triaged": 0, "passed": 0, "rejected": 0}

    progress("triage_stage_started", {"count": len(sites)})
    passed = rejected = sent = 0

    for index, site in enumerate(sites, 1):
        if stop():
            break
        result = triage_site(site)
        db.record_triage(
            site["id"], passed=result["passed"], triage_score=result["triage_score"],
            indicator_count=result["indicator_count"], indicators=result["indicators"],
            reject_reason=result["reject_reason"], http_status=result["http_status"],
        )
        # Keep the legacy score column in sync so existing views/sorting still work.
        db.update_site_score(
            site["id"], result["triage_score"],
            "; ".join(i["detail"] for i in result["indicators"]) or result["reject_reason"],
        )
        if result["passed"]:
            passed += 1
            db.set_site_status(site["id"], "queued")
            progress("triage_passed", {
                "site_id": site["id"], "url": site["url"],
                "score": result["triage_score"], "categories": result["indicator_count"],
            })
            # v0.5: triage is the moment the platform should hear about this.
            # Emitting only queues, so a failure here can never stall triage —
            # and an unreachable platform changes nothing about the scan.
            sent += _offer_to_platform(site["id"], progress)
        else:
            rejected += 1
            db.set_site_status(site["id"], "skipped")

        if index % 25 == 0:
            progress("triage_progress", {"done": index, "total": len(sites),
                                          "passed": passed, "rejected": rejected})

    summary = {"triaged": passed + rejected, "passed": passed, "rejected": rejected,
               "offered_to_platform": sent}
    progress("triage_stage_finished", summary)
    logger.info("Triage stage: %d triaged, %d passed, %d rejected, %d offered to the platform",
                summary["triaged"], passed, rejected, sent)
    return summary


def _offer_to_platform(site_id: int, progress) -> int:
    """
    Puts a triage survivor in front of the send gate. Returns 1 if anything was
    queued for the Main Platform, 0 otherwise.

    Wrapped in its own try/except on purpose: the integration is a downstream
    consumer of discovery, and a fault in it must never stop the discovery work
    that has already succeeded.
    """
    try:
        from app.integration.v4.emitter import queue_candidate
        result = queue_candidate(site_id)
        if result.get("sent"):
            progress("platform_offer", {
                "site_id": site_id, "queued": True,
                "high_priority": result.get("high_priority"),
                "summary": result.get("summary")})
            return 1
        progress("platform_offer", {
            "site_id": site_id, "queued": False,
            "summary": result.get("summary")})
        return 0
    except Exception as exc:                      # noqa: BLE001 - deliberately broad
        logger.warning("Could not offer site %s to the platform: %s", site_id, exc)
        progress("platform_offer_error", {"site_id": site_id, "error": str(exc)})
        return 0


def run_deep_analysis_stage(limit: int = DEEP_ANALYSIS_BATCH_SIZE, progress_cb=None,
                             should_stop=None, allow_signup: bool = False,
                             force_local: bool = False) -> dict:
    """
    Deep-analyzes the strongest triage survivors. Expensive and narrow — this is
    where the extra scanning time gets spent, and only on proven candidates.

    From v0.5 this stage stands down when Site Investigator is taking the work:
    running a browser over a site the investigator is already crawling is
    duplicated effort and duplicated load on the target. `force_local` overrides
    that for the times you want Site Finder's own look regardless.
    """
    progress = progress_cb or (lambda event, data: None)
    stop = should_stop or (lambda: False)

    if not force_local:
        try:
            from app.integration.handoff import decide_mode
            decision = decide_mode()
            if decision["mode"] == "handoff":
                progress("deep_stage_skipped", {"reason": decision["reason"]})
                return {"analyzed": 0, "high_confidence": 0, "skipped": True,
                        "reason": decision["reason"],
                        "note": ("Deep investigation is being handled by Site Investigator "
                                 "through the Main Platform. Run with force_local to "
                                 "analyse here as well.")}
        except Exception as exc:                  # noqa: BLE001 - deliberately broad
            # If the integration cannot answer, do the work locally. Failing
            # closed here would mean a broken integration silently stops
            # investigation altogether.
            logger.warning("Could not determine handoff mode, analysing locally: %s", exc)

    sites = db.sites_passing_triage_awaiting_deep(limit=limit)
    if not sites:
        return {"analyzed": 0, "high_confidence": 0}

    progress("deep_stage_started", {"count": len(sites)})
    analyzed = high_confidence = 0

    for site in sites:
        if stop():
            break
        profile = analyze_site(site, progress_cb=progress_cb, should_stop=should_stop,
                                allow_signup=allow_signup)
        analyzed += 1
        if profile.get("confidence_score", 0) >= HIGH_CONFIDENCE_THRESHOLD:
            high_confidence += 1
            # A high-confidence profile becomes a reviewable finding automatically.
            _ensure_finding_for_profile(site["id"], profile)

    summary = {"analyzed": analyzed, "high_confidence": high_confidence}
    progress("deep_stage_finished", summary)
    logger.info("Deep analysis stage: %d analyzed, %d high-confidence",
                analyzed, high_confidence)
    return summary


def _ensure_finding_for_profile(site_id: int, profile: dict):
    """Creates a review-queue finding for a high-confidence profile, if absent."""
    with db.get_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM findings WHERE site_id=? LIMIT 1", (site_id,)
        ).fetchone()
    if existing:
        return existing["id"]

    lines = [
        f"Site: {profile.get('full_url')}",
        f"Confidence: {profile.get('confidence_score', 0):.0%}",
        f"Risk score: {profile.get('risk_score')}",
        "",
        profile.get("evidence_summary", ""),
        "",
        "Why it was flagged:",
    ]
    lines.extend(f"  - {reason}" for reason in profile.get("flag_reasons", [])[:15])
    return db.create_finding(site_id, "\n".join(lines))


def run_full_quality_pipeline(triage_limit: int = TRIAGE_BATCH_SIZE,
                               deep_limit: int = DEEP_ANALYSIS_BATCH_SIZE,
                               progress_cb=None, should_stop=None,
                               allow_signup: bool = False) -> dict:
    """Runs triage then deep analysis back to back. Discovery is run separately."""
    started = time.time()
    triage_summary = run_triage_stage(limit=triage_limit, progress_cb=progress_cb,
                                       should_stop=should_stop)
    deep_summary = run_deep_analysis_stage(limit=deep_limit, progress_cb=progress_cb,
                                            should_stop=should_stop, allow_signup=allow_signup)
    return {
        "triage": triage_summary,
        "deep": deep_summary,
        "elapsed_seconds": round(time.time() - started, 1),
    }


def funnel_stats() -> dict:
    """The headline numbers showing the quality funnel working."""
    triage = db.triage_stats()
    deep = db.deep_profile_stats()
    with db.get_conn() as conn:
        total_sites = conn.execute("SELECT COUNT(*) c FROM sites").fetchone()["c"]
    return {
        "discovered": total_sites,
        "triaged": triage["total_triaged"],
        "passed_triage": triage["passed_triage"],
        "rejected_at_triage": triage["rejected_at_triage"],
        "awaiting_triage": triage["awaiting_triage"],
        "deep_analyzed": deep["total_profiles"],
        "high_confidence_results": deep["high_confidence_profiles"],
        "deep_running": deep["running"],
        "deep_failed": deep["failed"],
    }
