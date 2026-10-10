"""
Discovery campaigns: resumable, budgeted, multi-stage investigations.

A campaign starts from one seed of any supported kind and runs waves of:

    Seed → Pivot → Candidate → Validate → Expand

    Seed      resolve the starting point into concrete site(s)
    Pivot     turn those sites' indicators into searchable leads, ordered by
              what the technique ledger says actually works
    Candidate execute the best leads, collecting candidate domains with paths
    Validate  cheap triage on the candidates; only survivors go further, and
              only the strongest are promoted to expensive deep analysis
    Expand    validated survivors become seeds for the next wave

Every stage boundary is written to the database before the next begins, so an
interrupted campaign resumes exactly where it stopped rather than redoing
completed work. Every consumable — API calls, candidates, leads, deep
analyses, wall-clock — is spent through a ledger that refuses to overrun.

WHAT A CAMPAIGN CONCLUDES
-------------------------
Nothing, on its own. A campaign produces ranked *candidates* with explained
discovery paths. Shared infrastructure, a shared certificate, a reused wallet
or an on-chain interaction are observations about indicators — they are not
evidence of common ownership, control, or wrongdoing, and the engine never
records them as such. Each candidate still has to earn its own confidence
through the normal triage and deep-analysis pipeline.
"""
import logging
import time
import uuid

from app import db
from app.config import (
    CAMPAIGN_MAX_WAVES, CAMPAIGN_MAX_CANDIDATES, CAMPAIGN_MAX_LEADS,
    CAMPAIGN_MAX_API_CALLS, CAMPAIGN_MAX_SECONDS, CAMPAIGN_MAX_DEEP_ANALYSES,
    CAMPAIGN_PROMOTE_MIN_CONNECTION, PIVOT_MIN_SEED_CONFIDENCE,
)
from app.discovery import technique_learning as tl
from app.discovery.pivot_engine import (
    generate_leads_for_site, execute_lead, build_path, PivotBudget,
)

logger = logging.getLogger("scamhunter.campaigns")

STAGES = ("seed", "pivot", "candidate", "validate", "expand")

SEED_KINDS = ("domain", "wallet", "template", "infrastructure", "keyword")


# ---------------------------------------------------------------------------
# Seed resolution: turn any supported starting point into concrete sites
# ---------------------------------------------------------------------------

def resolve_seed(seed_kind: str, seed_value: str) -> dict:
    """
    Returns {"site_ids": [...], "note": str}. Never invents sites — if a seed
    matches nothing already known, it says so rather than guessing.
    """
    value = (seed_value or "").strip()
    if not value:
        return {"site_ids": [], "note": "Empty seed value."}

    if seed_kind == "domain":
        domain = db.domain_of(value if "://" in value else f"http://{value}")
        with db.get_conn() as conn:
            row = conn.execute("SELECT id FROM sites WHERE domain=? LIMIT 1", (domain,)).fetchone()
        if row:
            return {"site_ids": [row["id"]],
                    "note": f"Seed domain {domain} is already known; using it directly."}
        site_id = db.add_site(value if "://" in value else f"http://{value}",
                               "campaign_seed",
                               discovery_confidence=0.5,
                               discovery_reason=f"Added as the starting point of a discovery campaign.")
        return {"site_ids": [site_id] if site_id else [],
                "note": f"Seed domain {domain} was not known; added as a new candidate."}

    if seed_kind == "wallet":
        indicator_id = db.upsert_indicator("wallet", value)
        sites = db.sites_sharing_indicator(indicator_id) if indicator_id else []
        return {"site_ids": [s["id"] for s in sites],
                "note": (f"Wallet {value[:24]} is recorded on {len(sites)} known site(s), "
                         "which become the campaign's starting points." if sites else
                         f"Wallet {value[:24]} is not recorded on any known site, so there is "
                         "nothing to pivot from yet.")}

    if seed_kind in ("template", "infrastructure"):
        itype = "template_hash" if seed_kind == "template" else "ip"
        indicator_id = db.upsert_indicator(itype, value)
        sites = db.sites_sharing_indicator(indicator_id) if indicator_id else []
        return {"site_ids": [s["id"] for s in sites],
                "note": (f"{seed_kind} indicator {value[:32]} is recorded on {len(sites)} "
                         "known site(s)." if sites else
                         f"No known site records that {seed_kind} indicator.")}

    if seed_kind == "keyword":
        hits = db.global_search(value, limit=25)
        site_ids = [s["id"] for s in hits.get("sites", [])]
        return {"site_ids": site_ids,
                "note": (f"Keyword {value!r} matched {len(site_ids)} known site(s) in stored "
                         "intelligence, which become the starting points." if site_ids else
                         f"Keyword {value!r} matched no stored intelligence.")}

    return {"site_ids": [], "note": f"Unsupported seed kind {seed_kind!r}."}


# ---------------------------------------------------------------------------
# Campaign lifecycle
# ---------------------------------------------------------------------------

def create_campaign(name: str, seed_kind: str, seed_value: str,
                     max_waves: int = CAMPAIGN_MAX_WAVES,
                     max_candidates: int = CAMPAIGN_MAX_CANDIDATES,
                     max_leads: int = CAMPAIGN_MAX_LEADS,
                     max_api_calls: int = CAMPAIGN_MAX_API_CALLS,
                     max_seconds: int = CAMPAIGN_MAX_SECONDS,
                     max_deep_analyses: int = CAMPAIGN_MAX_DEEP_ANALYSES,
                     promote_min_connection: float = CAMPAIGN_PROMOTE_MIN_CONNECTION) -> dict:
    if seed_kind not in SEED_KINDS:
        raise ValueError(f"Unsupported seed kind {seed_kind!r}; expected one of {SEED_KINDS}")

    key = f"camp-{uuid.uuid4().hex[:10]}"
    config = {
        "max_waves": max_waves, "max_candidates": max_candidates, "max_leads": max_leads,
        "max_api_calls": max_api_calls, "max_seconds": max_seconds,
        "max_deep_analyses": max_deep_analyses,
        "promote_min_connection": promote_min_connection,
    }
    campaign_id = db.create_campaign(key, name or f"{seed_kind}:{seed_value[:32]}",
                                      seed_kind, seed_value, config)

    for resource, limit in (("candidates", max_candidates), ("leads", max_leads),
                             ("api_calls", max_api_calls), ("deep_analyses", max_deep_analyses)):
        db.set_campaign_budget(campaign_id, resource, limit)

    return {"campaign_id": campaign_id, "campaign_key": key, "config": config}


def run_campaign(campaign_id: int, progress_cb=None, should_stop=None) -> dict:
    """
    Runs (or resumes) a campaign to completion or until a budget stops it.
    Safe to call repeatedly: completed stages are skipped, not repeated.
    """
    progress = progress_cb or (lambda e, d: None)
    stop = should_stop or (lambda: False)

    campaign = db.get_campaign(campaign_id)
    if not campaign:
        return {"error": f"No campaign with id {campaign_id}"}
    if campaign["status"] == "completed":
        return {"campaign_id": campaign_id, "status": "completed",
                "note": "Campaign already completed; nothing to resume."}

    started_at = campaign.get("started_at") or time.time()
    db.update_campaign(campaign_id, status="running", started_at=started_at)
    config = campaign["config"]
    max_waves = int(config.get("max_waves", CAMPAIGN_MAX_WAVES))
    max_seconds = float(config.get("max_seconds", CAMPAIGN_MAX_SECONDS))
    promote_min = float(config.get("promote_min_connection", CAMPAIGN_PROMOTE_MIN_CONNECTION))

    resumed = campaign["current_wave"] > 0 or campaign["status"] == "paused"
    progress("campaign_started", {
        "campaign_id": campaign_id, "name": campaign["name"],
        "resumed": resumed, "from_wave": campaign["current_wave"]})

    run_started = time.time()

    # v0.6: split the lead budget by what each technique has actually produced
    # downstream, bounded so a winner cannot starve exploration and a loser
    # cannot be zeroed out of ever recovering.
    technique_budget = {}
    try:
        from app.discovery.budget_allocator import allocate
        from app.discovery.pivot_engine import PIVOTABLE
        allocation = allocate(int(config.get("max_leads", CAMPAIGN_MAX_LEADS)),
                              sorted({p for p, _q in PIVOTABLE.values()}))
        technique_budget = dict(allocation["allocation"])
        db.set_campaign_allocation(campaign_id, technique_budget,
                                    allocation["explanation"])
        progress("campaign_budget_allocated", {
            "campaign_id": campaign_id, "allocation": technique_budget,
            "reserved_for_exploration": allocation["reserved_for_exploration"],
            "explanation": allocation["explanation"]})
    except Exception as exc:                    # noqa: BLE001
        # No allocation means a flat budget, which is the v0.4 behaviour — a
        # worse plan, not a broken one. Discovery must not stop because the
        # allocator could not decide.
        logger.warning("Budget allocation failed, using flat budget: %s", exc)

    totals = dict(campaign.get("stats") or {})
    totals.setdefault("leads_executed", 0)
    totals.setdefault("candidates_found", 0)
    totals.setdefault("new_sites", 0)
    totals.setdefault("validated", 0)
    totals.setdefault("promoted", 0)
    totals.setdefault("rejected_noise", 0)
    totals.setdefault("stages_skipped_on_resume", 0)
    # Which sites each wave started from, recorded as the wave begins so a
    # resumed run picks up the same seeds instead of re-deriving them.
    totals.setdefault("wave_seeds", {})

    stop_reason = None
    current_seeds = []

    for wave in range(campaign["current_wave"], max_waves):
        if stop():
            stop_reason = "stopped"; break
        # v0.7: a campaign can be asked to finish the wave it is on and then
        # stop, which is different from stopping mid-wave and leaving a stage
        # half-done.
        control = db.get_campaign_control(campaign_id)
        if control.get("stop_after_current") and wave > campaign["current_wave"]:
            stop_reason = "stopped"
            progress("campaign_stopped_after_wave", {
                "campaign_id": campaign_id, "wave": wave,
                "detail": "Stopping as requested, after completing the wave in progress."})
            break
        if control.get("paused"):
            stop_reason = "paused"
            db.update_campaign(campaign_id, status="paused", current_wave=wave)
            progress("campaign_paused", {"campaign_id": campaign_id, "wave": wave})
            break
        # Budget changes made while running take effect at the wave boundary.
        if control.get("budget_changes"):
            for resource, limit in control["budget_changes"].items():
                db.set_campaign_budget(campaign_id, resource, limit)
            db.clear_campaign_budget_changes(campaign_id)
            progress("campaign_budget_changed", {
                "campaign_id": campaign_id, "changes": control["budget_changes"]})
        if (time.time() - run_started) > max_seconds:
            stop_reason = "time_limit"; break
        exhausted, resource = db.budget_exhausted(campaign_id)
        if exhausted:
            stop_reason = f"budget:{resource}"; break

        db.update_campaign(campaign_id, current_wave=wave)

        # ---- STAGE 1: SEED ----
        if db.campaign_stage_complete(campaign_id, wave, "seed"):
            totals["stages_skipped_on_resume"] += 1
            current_seeds = _recover_wave_seeds(campaign_id, wave, totals, campaign)
        else:
            db.start_campaign_stage(campaign_id, wave, "seed")
            db.update_campaign(campaign_id, current_stage="seed")
            if wave == 0:
                resolved = resolve_seed(campaign["seed_kind"], campaign["seed_value"])
                current_seeds = resolved["site_ids"]
                note = resolved["note"]
            else:
                note = f"Carrying {len(current_seeds)} validated site(s) forward from wave {wave-1}."
            totals["wave_seeds"][str(wave)] = list(current_seeds)
            db.update_campaign(campaign_id, stats=totals)
            db.finish_campaign_stage(campaign_id, wave, "seed", "complete",
                                      output_count=len(current_seeds), detail=note)
            progress("campaign_stage", {"campaign_id": campaign_id, "wave": wave,
                                         "stage": "seed", "count": len(current_seeds),
                                         "detail": note})

        if not current_seeds:
            stop_reason = stop_reason or "no_seeds"
            break

        # ---- STAGE 2: PIVOT ----
        if db.campaign_stage_complete(campaign_id, wave, "pivot"):
            totals["stages_skipped_on_resume"] += 1
        else:
            db.start_campaign_stage(campaign_id, wave, "pivot", input_count=len(current_seeds))
            db.update_campaign(campaign_id, current_stage="pivot")
            generated = 0
            for site_id in current_seeds:
                site = db.get_site(site_id)
                if not site:
                    continue
                result = generate_leads_for_site(_pivot_run_id(campaign_id), site, depth=wave)
                generated += result["created"]
            db.finish_campaign_stage(campaign_id, wave, "pivot", "complete",
                                      output_count=generated,
                                      detail=f"{generated} lead(s) generated from "
                                             f"{len(current_seeds)} seed site(s).")
            progress("campaign_stage", {"campaign_id": campaign_id, "wave": wave,
                                         "stage": "pivot", "count": generated})

        # ---- STAGE 3: CANDIDATE ----
        wave_candidates = []
        if db.campaign_stage_complete(campaign_id, wave, "candidate"):
            totals["stages_skipped_on_resume"] += 1
            wave_candidates = _recover_wave_candidates(campaign_id, wave)
        else:
            db.start_campaign_stage(campaign_id, wave, "candidate")
            db.update_campaign(campaign_id, current_stage="candidate")
            wave_candidates, counters, interrupted = _execute_candidate_stage(
                campaign_id, wave, promote_min, progress, stop,
                technique_budget=technique_budget)
            totals["leads_executed"] += counters["leads"]
            totals["candidates_found"] += counters["candidates"]
            totals["new_sites"] += counters["new_sites"]
            totals["rejected_noise"] += counters["skipped_noise"]
            db.finish_campaign_stage(
                campaign_id, wave, "candidate",
                "interrupted" if interrupted else "complete",
                output_count=len(wave_candidates),
                detail=(f"{counters['leads']} lead(s) run, {counters['candidates']} candidate(s), "
                        f"{counters['new_sites']} new site(s), "
                        f"{counters['skipped_noise']} lead(s) skipped as low-yield."
                        + (" Stage was interrupted and will be resumed from here."
                           if interrupted else "")))
            if interrupted:
                # Individual leads are already recorded as completed work, so
                # resuming re-enters this stage and continues from the rest.
                stop_reason = "stopped"
                db.update_campaign(campaign_id, stats=totals)
                break

        # ---- STAGE 4: VALIDATE ----
        validated = []
        if db.campaign_stage_complete(campaign_id, wave, "validate"):
            totals["stages_skipped_on_resume"] += 1
            validated = _recover_wave_seeds(campaign_id, wave + 1, totals, campaign)
        else:
            db.start_campaign_stage(campaign_id, wave, "validate",
                                     input_count=len(wave_candidates))
            db.update_campaign(campaign_id, current_stage="validate")
            validated, promoted, rejected, interrupted = _validate_candidates(
                campaign_id, wave_candidates, promote_min, progress, stop)
            totals["validated"] += len(validated)
            totals["promoted"] += promoted
            totals["rejected_noise"] += rejected
            db.finish_campaign_stage(
                campaign_id, wave, "validate",
                "interrupted" if interrupted else "complete", output_count=len(validated),
                detail=(f"{len(validated)} candidate(s) worth carrying forward, "
                        f"{promoted} promoted to deep analysis, {rejected} set aside as "
                        "too weakly connected or unreachable."
                        + (" Stage was interrupted and will be resumed from here."
                           if interrupted else "")))
            if interrupted:
                stop_reason = "stopped"
                db.update_campaign(campaign_id, stats=totals)
                break

        # ---- STAGE 5: EXPAND ----
        if not db.campaign_stage_complete(campaign_id, wave, "expand"):
            db.start_campaign_stage(campaign_id, wave, "expand", input_count=len(validated))
            db.update_campaign(campaign_id, current_stage="expand")
            db.finish_campaign_stage(
                campaign_id, wave, "expand", "complete", output_count=len(validated),
                detail=(f"{len(validated)} validated site(s) become seeds for wave {wave+1}."
                        if validated else "No validated sites; expansion stops here."))
        progress("campaign_stage", {"campaign_id": campaign_id, "wave": wave,
                                     "stage": "expand", "count": len(validated)})

        # v0.7: has this campaign stopped finding anything? Budget exhaustion is
        # the worst reason to stop — it means the money ran out, not that the
        # search finished — so saturation is measured explicitly and recorded.
        try:
            from app.discovery.saturation import assess, record_stop
            verdict = assess(campaign_id)
            if verdict.get("state") == "saturated":
                record_stop(campaign_id, verdict["stop_reason"], verdict["explanation"],
                            metrics={k: verdict.get(k) for k in
                                     ("duplicate_rate", "novelty_rate", "survival_rate",
                                      "dead_rate", "samples", "new_sites")})
                progress("campaign_saturated", {
                    "campaign_id": campaign_id, "wave": wave,
                    "stop_reason": verdict["stop_reason"],
                    "explanation": verdict["explanation"]})
                stop_reason = verdict["stop_reason"]
                db.update_campaign(campaign_id, stats=totals, current_wave=wave + 1)
                break
            if verdict.get("state") == "slowing":
                progress("campaign_slowing", {
                    "campaign_id": campaign_id, "wave": wave,
                    "explanation": verdict["explanation"]})
        except Exception as exc:                # noqa: BLE001
            logger.warning("Saturation check failed: %s", exc)

        current_seeds = validated
        db.update_campaign(campaign_id, stats=totals, current_wave=wave + 1)

        if not current_seeds:
            stop_reason = stop_reason or "exhausted_leads"
            break

    # Learning pass: fold this campaign's results into every ledger, so the
    # next campaign starts from what this one learned.
    tl.update_all_scores()
    try:
        from app.discovery.feedback import refresh_scores
        from app.discovery.indicator_noise import evaluate_and_retire
        refresh_scores()
        retired = evaluate_and_retire(progress_cb=progress)
        if retired["retired"]:
            progress("log", {"level": "info", "logger": "scamhunter.campaigns",
                              "message": retired["note"]})
        db.snapshot_discovery_day()
    except Exception as exc:                    # noqa: BLE001
        logger.warning("Post-campaign learning pass failed: %s", exc)

    final_status = "completed" if stop_reason in (None, "exhausted_leads", "no_seeds") else "stopped"
    db.update_campaign(campaign_id, status=final_status, current_stage="done",
                        stats=totals, stopped_reason=stop_reason or "completed",
                        finished_at=time.time())

    # v0.7 (fixes a v0.6 defect): campaign progress and module health are
    # queued for the platform as module_activity records. v0.6 built both
    # builders and never called either, so the platform never heard about a
    # campaign at all.
    try:
        from app.integration.v4.emitter import queue_campaign_update, queue_health_update
        queue_campaign_update(campaign_id)
        queue_health_update()
    except Exception as exc:                    # noqa: BLE001
        logger.warning("Could not queue campaign/health activity: %s", exc)
    progress("campaign_finished", {"campaign_id": campaign_id, "status": final_status,
                                    "stopped_reason": stop_reason or "completed", **totals})

    return {"campaign_id": campaign_id, "status": final_status,
            "stopped_reason": stop_reason or "completed", **totals}


def _pivot_run_id(campaign_id: int) -> int:
    """
    Campaigns reuse the v0.3 pivot lead tables, scoped by a synthetic run whose
    key is derived from the campaign, so lead dedup works per campaign.
    """
    key = f"campaign-{campaign_id}"
    return db.create_pivot_run(key, CAMPAIGN_MAX_WAVES, {"campaign_id": campaign_id})


def _execute_candidate_stage(campaign_id: int, wave: int, promote_min: float,
                              progress, stop, technique_budget: dict = None) -> tuple:
    """Runs the best queued leads, ordered by what the technique ledger has learned."""
    campaign = db.get_campaign(campaign_id) or {}
    run_id = _pivot_run_id(campaign_id)
    counters = {"leads": 0, "candidates": 0, "new_sites": 0, "skipped_noise": 0}
    spent_per_technique = {}
    interrupted = False

    # Re-entry after an interruption: the leads that already ran are recorded as
    # completed work and will be skipped, so their results have to be carried in
    # here or the validate stage would never see them.
    found = _recover_wave_candidates(campaign_id, wave)

    budget = PivotBudget(max_depth=wave + 1, max_new_sites=10_000,
                         max_leads=10_000, max_seconds=10_000)

    while True:
        if stop():
            interrupted = True
            break
        exhausted, _ = db.budget_exhausted(campaign_id)
        if exhausted:
            break

        batch = db.next_queued_leads(run_id, limit=15, max_depth=wave)
        if not batch:
            break
        batch = tl.rank_leads(batch)
        if not batch:
            break

        for lead in batch:
            if stop():
                interrupted = True
                break
            if not db.spend_budget(campaign_id, "leads"):
                break

            # v0.7 (fixes a v0.6 defect): the allocation is now ENFORCED, not
            # merely announced. A technique that has spent its share stops
            # running in this campaign; others carry on with theirs.
            if technique_budget:
                cap = technique_budget.get(lead["pivot_type"])
                if cap is not None and spent_per_technique.get(lead["pivot_type"], 0) >= cap:
                    db.update_pivot_lead(
                        lead["id"], "skipped",
                        skip_reason=(f"{lead['pivot_type']} has used its allocated "
                                     f"{cap} lead(s) for this campaign; the remaining "
                                     "budget belongs to other techniques."))
                    counters["budget_capped"] = counters.get("budget_capped", 0) + 1
                    continue

            skip, reason = tl.should_skip_technique(lead["pivot_type"])
            if skip:
                db.update_pivot_lead(lead["id"], "skipped", skip_reason=reason)
                counters["skipped_noise"] += 1
                progress("campaign_lead_skipped", {
                    "campaign_id": campaign_id, "pivot_type": lead["pivot_type"],
                    "reason": reason})
                continue

            work_key = f"{lead['pivot_type']}|{lead['indicator_value']}"
            if db.work_already_done(campaign_id, "lead", work_key):
                db.update_pivot_lead(lead["id"], "skipped",
                                      skip_reason="already completed earlier in this campaign")
                continue

            origin = db.get_site(lead["origin_site_id"])
            if not origin:
                db.update_pivot_lead(lead["id"], "skipped", skip_reason="origin site missing")
                continue

            progress("campaign_lead_executing", {
                "campaign_id": campaign_id, "wave": wave,
                "pivot_type": lead["pivot_type"], "origin": origin["domain"],
                "indicator": f"{lead['indicator_type']}={str(lead['indicator_value'])[:36]}"})

            spent_per_technique[lead["pivot_type"]] = \
                spent_per_technique.get(lead["pivot_type"], 0) + 1
            t0 = time.time()
            # External-lookup techniques consume the API budget; database-only
            # correlation pivots do not, since they make no outbound request.
            if lead["pivot_type"] in ("cert_san", "domain_pattern"):
                if not db.spend_budget(campaign_id, "api_calls"):
                    db.update_pivot_lead(lead["id"], "skipped",
                                          skip_reason="API call budget exhausted")
                    break
            results = execute_lead(lead, budget)
            elapsed = time.time() - t0
            counters["leads"] += 1

            unique_new = 0
            duplicates = 0
            for candidate in results[:25]:
                domain = candidate["domain"]
                existing_id = candidate.get("site_id")
                already = bool(existing_id) or db.domain_known(domain)
                counters["candidates"] += 1

                # v0.6: one candidate across all campaigns. Rediscovery is not
                # waste — a domain several independent campaigns reach is
                # better corroborated — so the sighting is kept either way.
                from app.discovery.dedup import register as register_candidate
                sighting = register_candidate(
                    candidate["url"], site_id=existing_id,
                    campaign_key=campaign.get("campaign_key", ""),
                    source=f"campaign:{lead['pivot_type']}",
                    pivot_type=lead["pivot_type"])
                if sighting.get("corroborated"):
                    counters["corroborated"] = counters.get("corroborated", 0) + 1

                site_id = existing_id
                if already and not site_id:
                    with db.get_conn() as conn:
                        row = conn.execute(
                            "SELECT id FROM sites WHERE domain=? LIMIT 1", (domain,)).fetchone()
                        site_id = row["id"] if row else None
                    duplicates += 1
                elif not already:
                    if not db.spend_budget(campaign_id, "candidates"):
                        break
                    site_id = db.add_site(
                        candidate["url"], f"campaign:{lead['pivot_type']}",
                        discovery_confidence=min(0.75, candidate["link_strength"]),
                        discovery_reason=candidate["why"])
                    if site_id:
                        unique_new += 1
                        counters["new_sites"] += 1
                        from app.integration.v4.emitter import queue_candidate
                        queue_candidate(site_id)
                        progress("site_discovered", {
                            "site_id": site_id, "url": candidate["url"],
                            "source": f"campaign:{lead['pivot_type']}",
                            "confidence": candidate["link_strength"],
                            "reason": candidate["why"]})

                if not site_id:
                    continue

                path, path_text = build_path(origin, lead, candidate, lead["depth"] + 1)
                db.record_discovery_path(
                    run_id, site_id, domain, lead["id"], origin["id"], lead["depth"] + 1,
                    lead["pivot_type"], lead["indicator_type"], lead["indicator_value"],
                    path, path_text, candidate["link_strength"])
                db.add_timeline_event(
                    site_id, "discovered", "derived",
                    f"Found by campaign pivot from {origin['domain']}",
                    f"{candidate['why']} Discovery path: {path_text}", url=candidate["url"])
                found.append(site_id)

            db.record_technique_result(lead["pivot_type"], candidates=len(results),
                                        unique_new=unique_new, duplicates=duplicates,
                                        seconds=elapsed)
            # v0.5: the same result recorded against the specific indicator, so
            # a productive technique running on one worthless value can be
            # spotted and retired without disabling the technique itself.
            db.record_indicator_yield(
                lead["indicator_type"], lead["indicator_value"],
                leads=1, candidates=len(results), unique_new=unique_new)
            db.update_pivot_lead(lead["id"], "executed",
                                  candidates_found=len(results), new_sites=unique_new)
            db.mark_work_complete(campaign_id, "lead", work_key,
                                   f"{len(results)} candidate(s), {unique_new} new")

    db.recompute_convergence()
    # v0.6: score each route, not just count them. Prioritisation reads the
    # best route's quality rather than the raw number of paths.
    try:
        from app.discovery.path_quality import rescore_all
        rescore_all()
    except Exception as exc:                    # noqa: BLE001
        logger.warning("Path quality scoring failed: %s", exc)
    return list(dict.fromkeys(found)), counters, interrupted


def _validate_candidates(campaign_id: int, candidate_site_ids: list, promote_min: float,
                          progress, stop) -> tuple:
    """
    Cheap validation gate. Candidates that are too weakly connected, or that
    fail triage, are set aside; the strongest are promoted to deep analysis
    within the campaign's deep-analysis budget.
    """
    from app.analysis.triage import triage_site
    from app.discovery import candidate_priority as cp

    validated, promoted, rejected = [], 0, 0
    survivors = []          # (site_id, connection) for everything that cleared triage
    interrupted = False

    for site_id in candidate_site_ids:
        if stop():
            interrupted = True
            break
        work_key = f"validate|{site_id}"
        if db.work_already_done(campaign_id, "validation", work_key):
            convergence = db.get_convergence(site_id)
            if convergence and convergence["connection_score"] >= promote_min:
                validated.append(site_id)
            continue

        site = db.get_site(site_id)
        if not site:
            continue

        # v0.7: do not re-judge a candidate we have already decided about
        # unless its evidence has actually moved. Rediscovering and
        # re-triaging the same weak domain is how a discovery engine wastes
        # the budget its quality gates exist to protect.
        try:
            from app.discovery.candidate_memory import should_process
            memory = should_process(site_id)
            if not memory.get("process"):
                db.mark_work_complete(campaign_id, "validation", work_key,
                                       f"skipped: {memory['reason']}")
                progress("campaign_candidate_remembered", {
                    "campaign_id": campaign_id, "domain": site["domain"],
                    "previous_decision": memory.get("previous_decision"),
                    "reason": memory["reason"]})
                continue
            if memory.get("reconsidering"):
                progress("campaign_candidate_reconsidered", {
                    "campaign_id": campaign_id, "domain": site["domain"],
                    "previous_decision": memory.get("previous_decision"),
                    "reason": memory["reason"]})
        except Exception as exc:                # noqa: BLE001
            logger.debug("Candidate memory check failed for %s: %s", site_id, exc)

        convergence = db.get_convergence(site_id)
        connection = convergence["connection_score"] if convergence else 0.0

        if connection < promote_min:
            rejected += 1
            try:
                from app.discovery.candidate_memory import record as remember
                remember(site_id, "dismissed",
                         reason=(f"Connection {connection:.2f} below the promotion "
                                 f"threshold {promote_min:.2f} in this campaign."))
            except Exception:                   # noqa: BLE001
                pass
            db.mark_work_complete(campaign_id, "validation", work_key,
                                   f"set aside: connection {connection:.2f} below {promote_min:.2f}")
            progress("campaign_candidate_rejected", {
                "campaign_id": campaign_id, "domain": site["domain"],
                "reason": (f"Connection score {connection:.2f} is below the promotion "
                           f"threshold {promote_min:.2f} — kept on record but not "
                           "investigated further in this campaign.")})
            continue

        existing = db.get_triage(site_id)
        if not existing:
            result = triage_site(site)
            db.record_triage(site_id, passed=result["passed"],
                              triage_score=result["triage_score"],
                              indicator_count=result["indicator_count"],
                              indicators=result["indicators"],
                              reject_reason=result["reject_reason"],
                              http_status=result["http_status"])
            passed = result["passed"]
        else:
            passed = bool(existing["passed"])

        source = (site.get("source") or "")
        technique = source.split(":", 1)[1] if ":" in source else None

        # v0.5: credit or debit the specific indicators that led here, not just
        # the technique. A technique is only as good as the values it runs on.
        for path in db.paths_for_site(site_id):
            if path.get("indicator_type") and path.get("indicator_value"):
                db.record_indicator_yield(path["indicator_type"], path["indicator_value"],
                                           passed_triage=1 if passed else 0)

        if not passed:
            rejected += 1
            if technique:
                db.record_technique_outcome(technique, dead=1)
            db.mark_work_complete(campaign_id, "validation", work_key, "did not clear triage")
            continue

        if technique:
            db.record_technique_outcome(technique, passed_triage=1)
        validated.append(site_id)
        db.mark_work_complete(campaign_id, "validation", work_key,
                               f"cleared triage, connection {connection:.2f}")
        survivors.append((site_id, connection))

    # Deep analysis is the expensive stage and the budget rarely covers every
    # survivor, so the order matters: rank on stored evidence and spend the
    # budget from the top rather than on whichever site happened to come first.
    ranked = cp.rank_candidates([s for s, _ in survivors],
                                 connection_scores=dict(survivors))
    for entry in ranked:
        if not db.spend_budget(campaign_id, "deep_analyses"):
            break
        promoted += 1
        # Raise it in the shared deep-analysis queue, with the reason recorded
        # alongside so the ordering is never an unexplained number.
        db.update_site_score(entry["site_id"], round(entry["priority"] * 10, 2),
                              entry["explanation"])
        db.add_timeline_event(
            entry["site_id"], "promoted", "derived",
            "Promoted to deep analysis by a discovery campaign", entry["explanation"])

        # v0.5: the handoff. Deep website investigation belongs to Site
        # Investigator, reached through the Main Platform, so a promoted
        # candidate becomes an outbound event rather than local browser work.
        # handoff_for_site() falls back to local analysis when the platform is
        # unreachable, which is what keeps Site Finder usable on its own.
        handoff = _handoff(entry["site_id"])
        try:
            from app.discovery.candidate_memory import record as remember
            remember(entry["site_id"], "promoted", reason=entry["explanation"])
        except Exception:                       # noqa: BLE001
            pass

        progress("campaign_candidate_promoted", {
            "campaign_id": campaign_id, "site_id": entry["site_id"],
            "domain": entry["domain"], "connection": dict(survivors)[entry["site_id"]],
            "priority": entry["priority"], "handoff": handoff.get("mode"),
            "reason": (f"Cleared triage and connects back to the campaign's evidence at "
                       f"{dict(survivors)[entry['site_id']]:.2f}. {entry['explanation']} "
                       f"{handoff.get('summary', '')}")})

    return validated, promoted, rejected, interrupted


def _handoff(site_id: int) -> dict:
    """
    Routes a promoted candidate to whoever should investigate it. Isolated so a
    failure in the integration layer can never take down a campaign — the
    discovery work is already done and recorded by this point.
    """
    try:
        from app.integration.handoff import handoff_for_site
        return handoff_for_site(site_id)
    except Exception as exc:
        logger.warning("Handoff failed for site %s: %s", site_id, exc)
        return {"mode": "local", "summary": f"Handoff unavailable ({exc}); kept local."}


def _recover_wave_seeds(campaign_id: int, wave: int, totals: dict, campaign: dict) -> list:
    """
    On resume, recover which sites a wave started from. The seed set is written
    to the campaign's stats as each wave begins, so this is a lookup rather
    than a reconstruction — reconstructing it from discovery paths would give a
    different answer once convergence scores had moved on.
    """
    recorded = (totals.get("wave_seeds") or {}).get(str(wave))
    if recorded:
        return [s for s in recorded if db.get_site(s)]

    # Campaigns created before seed sets were recorded, or a stats write lost to
    # an abrupt stop: wave 0 can always be re-derived from the seed itself.
    if wave == 0:
        return resolve_seed(campaign["seed_kind"], campaign["seed_value"])["site_ids"]

    promote_min = float((campaign.get("config") or {}).get(
        "promote_min_connection", CAMPAIGN_PROMOTE_MIN_CONNECTION))
    run_id = _pivot_run_id(campaign_id)
    site_ids = []
    for path in db.paths_for_run(run_id, limit=500):
        if path["depth"] == wave and path["site_id"] not in site_ids:
            convergence = db.get_convergence(path["site_id"])
            if convergence and convergence["connection_score"] >= promote_min:
                site_ids.append(path["site_id"])
    return site_ids


def _recover_wave_candidates(campaign_id: int, wave: int) -> list:
    run_id = _pivot_run_id(campaign_id)
    return list(dict.fromkeys(
        p["site_id"] for p in db.paths_for_run(run_id, limit=1000)
        if p["depth"] == wave + 1 and p["site_id"]))


def campaign_report(campaign_id: int) -> dict:
    """Everything about a campaign, in a form a human or the platform can read."""
    campaign = db.get_campaign(campaign_id)
    if not campaign:
        return {"error": f"No campaign with id {campaign_id}"}

    run_id = _pivot_run_id(campaign_id)
    paths = db.paths_for_run(run_id, limit=500)

    by_site = {}
    for path in paths:
        by_site.setdefault(path["site_id"], []).append(path)

    candidates = []
    for site_id, site_paths in by_site.items():
        site = db.get_site(site_id)
        if not site:
            continue
        convergence = db.get_convergence(site_id)
        profile = db.get_deep_profile(site_id)
        triage = db.get_triage(site_id)
        candidates.append({
            "site_id": site_id, "domain": site["domain"], "url": site["url"],
            "connection_score": convergence["connection_score"] if convergence else 0.0,
            "path_count": len(site_paths),
            "distinct_pivot_types": len({p["pivot_type"] for p in site_paths}),
            "triage_passed": bool(triage["passed"]) if triage else None,
            "own_confidence": profile.get("confidence_score") if profile else None,
            "discovery_paths": [{"path_text": p["path_text"], "pivot_type": p["pivot_type"],
                                  "depth": p["depth"]} for p in site_paths],
            "evidence_class": "derived",
        })
    candidates.sort(key=lambda c: c["connection_score"], reverse=True)

    return {
        "campaign": campaign,
        "stages": db.stages_for_campaign(campaign_id),
        "budget": db.campaign_budget_state(campaign_id),
        "candidates": candidates,
        "completed_work": db.completed_work_count(campaign_id),
        "note": ("Candidates are ranked by how strongly they connect back to the campaign's "
                 "starting evidence. A connection score reflects shared public indicators "
                 "only — it is not a finding about ownership, control, or wrongdoing, and "
                 "each site still has to be assessed on its own evidence."),
    }
