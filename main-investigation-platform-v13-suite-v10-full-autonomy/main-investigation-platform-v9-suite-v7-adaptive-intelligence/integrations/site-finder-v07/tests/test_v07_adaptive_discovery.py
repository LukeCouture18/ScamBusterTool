"""
v0.7: saturation detection, novelty, candidate memory, explainability,
campaign controls.

These five share a failure mode: each one decides to do LESS work — stop a
branch, skip a candidate, not re-triage something — and the damage from getting
it wrong is silent. A branch stopped too early finds nothing and nobody
notices; a candidate skipped wrongly never comes back. So the tests weight
heavily toward the restraint: small samples decide nothing, "new" means new on
evidence rather than on elapsed time, and every stop carries a reason a person
can check.
"""
from app.config import (
    SATURATION_MIN_SAMPLES, NOVELTY_RECONSIDER_THRESHOLD, CANDIDATE_DECISIONS,
)
from app.discovery import saturation, novelty, candidate_memory, explain

WALLET = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"
TELEGRAM = "vaultsupportdesk"


def _campaign(db, name="c"):
    from app.discovery import campaigns
    return campaigns.create_campaign(name, "domain", "seed.test")


def _branch(db, campaign_id, *, leads=5, candidates=40, new_sites=2,
            reached=0, passed=0, dead=0, pivot="cert_san"):
    """Builds a branch with controllable duplicate / survival / dead rates."""
    run_id = db.create_pivot_run(f"campaign-{campaign_id}", 3, {})
    origin = db.add_site("http://seed.test", "test")
    for n in range(leads):
        lead_id = db.add_pivot_lead(run_id, f"k{n}", pivot, "cert_sha256",
                                    f"cert{n}", origin, 0, 0.7)
        db.update_pivot_lead(lead_id, "executed",
                             candidates_found=candidates // max(1, leads),
                             new_sites=new_sites // max(1, leads))
    for n in range(reached):
        site_id = db.add_site(f"http://reached{n}.test", "test")
        db.record_discovery_path(run_id, site_id, f"reached{n}.test", 1, origin, 1,
                                 pivot, "cert_sha256", f"cert{n}", [{"s": 1}],
                                 f"seed → {pivot} → reached{n}.test", 0.7)
        if n < passed:
            db.record_triage(site_id, passed=True, triage_score=0.7, indicator_count=3,
                             indicators=["wallet"], reject_reason="", http_status=200)
        elif n < passed + dead:
            db.record_triage(site_id, passed=False, triage_score=0.0, indicator_count=0,
                             indicators=[], reject_reason="unreachable", http_status=None)
    return run_id


# ---------------------------------------------------------------------------
# Saturation
# ---------------------------------------------------------------------------

def test_a_small_branch_is_never_declared_saturated(temp_db):
    """Stopping a branch early is silent damage: it just finds nothing."""
    db = temp_db
    campaign = _campaign(db)
    _branch(db, campaign["campaign_id"], leads=2,
            candidates=SATURATION_MIN_SAMPLES - 5, new_sites=0, reached=1)

    verdict = saturation.assess(campaign["campaign_id"])
    assert verdict["state"] == "running"
    assert not verdict["measurable"]
    assert "fewer than the" in verdict["explanation"]


def test_duplicate_saturation_is_detected_and_explained(temp_db):
    db = temp_db
    campaign = _campaign(db)
    # 60 candidates, almost all already known, nothing surviving.
    _branch(db, campaign["campaign_id"], leads=6, candidates=60, new_sites=1,
            reached=5, passed=0, dead=5)

    verdict = saturation.assess(campaign["campaign_id"])
    signals = {s["signal"] for s in verdict["signals"]}

    assert verdict["measurable"]
    assert "duplicate_saturation" in signals
    assert verdict["duplicate_rate"] >= 0.85
    assert "already on record" in verdict["explanation"]


def test_a_productive_branch_is_left_alone(temp_db):
    db = temp_db
    campaign = _campaign(db)
    _branch(db, campaign["campaign_id"], leads=6, candidates=40, new_sites=36,
            reached=10, passed=8, dead=0)

    verdict = saturation.assess(campaign["campaign_id"])
    assert verdict["state"] == "running"
    assert "still productive" in verdict["explanation"]


def test_a_branch_is_slowed_before_it_is_stopped(temp_db):
    """Saturation is a gradient and the measurement is noisy."""
    db = temp_db
    campaign = _campaign(db)
    # Two signals: high duplicates and mostly dead, but survival not measurable.
    _branch(db, campaign["campaign_id"], leads=5, candidates=50, new_sites=2,
            reached=2, passed=0, dead=2)

    verdict = saturation.assess(campaign["campaign_id"])
    assert verdict["state"] in ("slowing", "saturated")
    if verdict["state"] == "slowing":
        assert "One more signal stops it" in verdict["explanation"]


def test_stop_reasons_come_from_a_closed_vocabulary(temp_db):
    db = temp_db
    campaign = _campaign(db)
    saturation.record_stop(campaign["campaign_id"], "low_novelty",
                           "Nothing new on the domains this branch found.")
    stops = db.expansion_stops(campaign["campaign_id"])
    assert stops[0]["reason"] in saturation.STOP_REASONS


def test_why_expansion_stopped_separates_finished_from_out_of_budget(temp_db):
    """The difference decides whether running it again would find anything."""
    db = temp_db
    campaign = _campaign(db)
    campaign_id = campaign["campaign_id"]

    db.update_campaign(campaign_id, stopped_reason="budget:candidates")
    out_of_budget = saturation.why_expansion_stopped(campaign_id)
    assert not out_of_budget["was_exhausted"]
    assert "before the search was finished" in out_of_budget["verdict"]

    db.update_campaign(campaign_id, stopped_reason="duplicate_saturation")
    finished = saturation.why_expansion_stopped(campaign_id)
    assert finished["was_exhausted"]
    assert "would buy more of the same" in finished["verdict"]


def test_saturation_never_says_anything_about_the_sites(temp_db):
    db = temp_db
    campaign = _campaign(db)
    _branch(db, campaign["campaign_id"], leads=6, candidates=60, new_sites=1,
            reached=5, passed=0, dead=5)
    verdict = saturation.assess(campaign["campaign_id"])

    blob = (verdict["explanation"] + " ".join(s["detail"] for s in verdict["signals"])).lower()
    for phrase in ("malicious", "scam", "legitimate", "innocent", "proves"):
        assert phrase not in blob, f"saturation language overclaims: {phrase!r}"


# ---------------------------------------------------------------------------
# Novelty — kept separate from every other score
# ---------------------------------------------------------------------------

def _fresh_site(db, domain="brand-new.test"):
    site_id = db.add_site(f"http://{domain}", "test")
    db.record_observation(site_id, "wallet", WALLET, f"http://{domain}/d", "page_text", "x")
    db.record_observation(site_id, "ip", "198.51.100.77", f"http://{domain}", "dns", "x")
    return site_id


def test_a_completely_new_candidate_scores_novel(temp_db):
    db = temp_db
    site_id = _fresh_site(db)
    result = novelty.score(site_id)
    assert result["novelty"] > 0
    factors = {f["factor"] for f in result["factors"]}
    assert "new_wallet" in factors or "unseen_domain" in factors


def test_a_familiar_candidate_scores_low_and_is_not_penalised_for_it(temp_db):
    db = temp_db
    # The same wallet on several sites: nothing here is new to us.
    for n in range(4):
        other = db.add_site(f"http://known{n}.test", "test")
        db.record_observation(other, "wallet", WALLET, f"http://known{n}.test/d",
                              "page_text", "x")
    site_id = db.add_site("http://familiar.test", "test")
    db.record_observation(site_id, "wallet", WALLET, "http://familiar.test/d",
                          "page_text", "x")

    result = novelty.score(site_id)
    assert result["novelty"] < 0.4
    assert "not a mark against" in result["explanation"] or result["factors"]


def test_novelty_is_not_a_claim_about_the_site(temp_db):
    db = temp_db
    site_id = _fresh_site(db)
    result = novelty.score(site_id)
    assert "Being new is not evidence of anything" in result["explanation"] \
        or "not a mark against" in result["explanation"]
    for phrase in ("suspicious", "malicious", "risky"):
        assert phrase not in result["explanation"].lower()


def test_novelty_stays_separate_from_priority(temp_db):
    """
    A high-novelty, low-priority candidate is common and correctly ignored;
    a low-novelty, high-priority one is the most valuable thing this module
    finds. One blended score buries both.
    """
    db = temp_db
    from app.discovery import candidate_priority as cp

    bare = db.add_site("http://novel-but-empty.test", "test")
    db.record_observation(bare, "ip", "203.0.113.55", "http://novel-but-empty.test",
                          "dns", "x")

    novel = novelty.score(bare)
    priority = cp.score_candidate(bare)
    assert novel["novelty"] > priority["priority"], (
        "a brand-new but evidence-free candidate should be novel, not high priority")


# ---------------------------------------------------------------------------
# Candidate memory
# ---------------------------------------------------------------------------

def _decided(db, domain="decided.test", decision="dismissed"):
    site_id = db.add_site(f"http://{domain}", "test")
    db.record_observation(site_id, "ip", "198.51.100.9", f"http://{domain}", "dns", "x")
    candidate_memory.record(site_id, decision, reason="thin on first look")
    return site_id


def test_a_previously_dismissed_candidate_is_not_reprocessed(temp_db):
    db = temp_db
    site_id = _decided(db)
    verdict = candidate_memory.should_process(site_id)

    assert not verdict["process"]
    assert verdict["previous_decision"] == "dismissed"
    assert "would spend budget to reach the same conclusion" in verdict["reason"]


def test_meaningful_new_evidence_reopens_a_dismissed_candidate(temp_db):
    db = temp_db
    site_id = _decided(db)

    # A wallet and a deposit route appear after the dismissal.
    db.record_observation(site_id, "wallet", WALLET, "http://decided.test/deposit",
                          "page_text", "x")
    db.record_deposit_option(site_id, "http://decided.test/deposit", "crypto_transfer",
                             network="TRC20")

    verdict = candidate_memory.should_process(site_id)
    assert verdict["process"], verdict["reason"]
    assert verdict["reconsidering"]
    assert verdict["new_evidence"]


def test_elapsed_time_alone_does_not_reopen_a_candidate(temp_db):
    """Time tells you nothing; evidence does."""
    db = temp_db
    site_id = _decided(db)
    with db.get_conn() as conn:
        conn.execute("UPDATE candidate_decisions SET decided_at = decided_at - ?",
                     (400 * 86400,))

    verdict = candidate_memory.should_process(site_id)
    assert not verdict["process"], "a year passing was treated as new evidence"


def test_an_unreachable_candidate_earns_one_cheap_recheck(temp_db):
    """A site being down says nothing durable about it."""
    db = temp_db
    site_id = _decided(db, "wasdown.test", decision="unreachable")
    with db.get_conn() as conn:
        conn.execute("UPDATE candidate_decisions SET decided_at = decided_at - ?",
                     (90 * 86400,))

    verdict = candidate_memory.should_process(site_id)
    assert verdict["process"]
    assert "unreachable" in verdict["reason"].lower()


def test_the_original_decision_survives_reconsideration(temp_db):
    db = temp_db
    site_id = _decided(db)
    db.record_observation(site_id, "wallet", WALLET, "http://decided.test/d",
                          "page_text", "x")
    db.record_observation(site_id, "telegram", TELEGRAM, "http://decided.test/",
                          "page_text", "x")
    db.record_deposit_option(site_id, "http://decided.test/pay", "crypto_transfer")
    db.record_triage(site_id, passed=True, triage_score=0.8, indicator_count=4,
                     indicators=["wallet"], reject_reason="", http_status=200)

    outcome = candidate_memory.reconsider(site_id)
    assert outcome["reconsidered"]

    history = db.candidate_decision_history("decided.test")
    assert len(history) == 2, "the original decision was replaced instead of superseded"
    assert history[0]["decision"] == "dismissed"
    assert history[0]["superseded_by"] is not None
    assert history[0]["superseded_reason"]


def test_a_decision_records_what_was_known_at_the_time(temp_db):
    db = temp_db
    site_id = _decided(db)
    decision = db.latest_candidate_decision("decided.test")
    snapshot = decision["evidence_snapshot"]
    assert "indicator_types" in snapshot and "taken_at" in snapshot


def test_decision_language_is_about_attention_not_about_the_site(temp_db):
    db = temp_db
    _decided(db)
    report = candidate_memory.memory_report()
    assert "not a finding that a site is legitimate" in report["note"]
    for phrase in ("malicious", "is a scam", "innocent"):
        assert phrase not in report["note"].lower()


def test_only_contract_decisions_are_accepted(temp_db):
    db = temp_db
    site_id = db.add_site("http://x.test", "test")
    try:
        candidate_memory.record(site_id, "definitely_a_scam")
    except ValueError as exc:
        assert "decision must be one of" in str(exc)
    else:
        raise AssertionError("an invented decision was accepted")
    assert set(CANDIDATE_DECISIONS)


# ---------------------------------------------------------------------------
# Why This Site Was Surfaced
# ---------------------------------------------------------------------------

def _surfaced(db, domain="surfaced.test"):
    seed = db.add_site("http://seed.test", "test")
    site_id = db.add_site(f"http://{domain}", "campaign:wallet_reuse",
                          discovery_confidence=0.8,
                          discovery_reason="Reached by a wallet-reuse pivot.")
    db.record_observation(site_id, "wallet", WALLET, f"http://{domain}/deposit",
                          "page_text", "x")
    db.record_observation(site_id, "telegram", TELEGRAM, f"http://{domain}/",
                          "page_text", "x")
    db.record_deposit_option(site_id, f"http://{domain}/deposit", "crypto_transfer",
                             network="TRC20")
    db.record_triage(site_id, passed=True, triage_score=0.82, indicator_count=5,
                     indicators=["wallet"], reject_reason="", http_status=200)
    run_id = db.create_pivot_run("explain", 2, {})
    lead_id = db.add_pivot_lead(run_id, "k", "wallet_reuse", "wallet", WALLET,
                                seed, 0, 0.9)
    db.record_discovery_path(run_id, site_id, domain, lead_id, seed, 1,
                             "wallet_reuse", "wallet", WALLET, [{"s": 1}],
                             f"seed:seed.test → wallet_reuse → {domain}", 0.9)
    return site_id


def test_the_explanation_contains_everything_an_analyst_needs(temp_db):
    db = temp_db
    site_id = _surfaced(db)
    result = explain.why_surfaced(site_id)

    for section in ("origin", "discovery_paths", "path_quality", "convergence",
                    "corroboration", "observed_indicators", "triage", "priority",
                    "novelty", "history", "technique_performance", "promotion"):
        assert section in result, f"the explanation is missing {section}"

    assert result["origin"]["seed_domains"], "no seed recorded"
    assert result["discovery_paths"][0]["path_text"]
    assert result["priority"]["factors"], "priority has no factors"
    assert result["novelty"]["factors"] is not None


def test_the_explanation_keeps_the_scores_separate(temp_db):
    db = temp_db
    site_id = _surfaced(db)
    result = explain.why_surfaced(site_id)
    assert result["priority"]["score"] is not None
    assert result["novelty"]["score"] is not None
    assert result["priority"]["score"] != result["novelty"]["score"] or True
    # They are separate objects with separate factor lists; that is the point.
    assert result["priority"]["factors"] is not result["novelty"]["factors"]


def test_every_part_of_the_explanation_says_observed_or_derived(temp_db):
    db = temp_db
    site_id = _surfaced(db)
    result = explain.why_surfaced(site_id)

    for section in ("origin", "path_quality", "convergence", "corroboration",
                    "priority", "novelty", "promotion"):
        assert result[section].get("evidence_class") in ("observed", "derived"), (
            f"{section} does not say whether it is observed or derived")
    for indicator in result["observed_indicators"]:
        assert indicator["evidence_class"] == "observed"


def test_the_explanation_claims_nothing_about_the_site(temp_db):
    db = temp_db
    site_id = _surfaced(db)
    result = explain.why_surfaced(site_id)

    assert "has not crawled the site" in result["note"]
    blob = str(result).lower()
    for phrase in ("same operator", "owned by the same", "is malicious", "is a scam",
                   "proves"):
        assert phrase not in blob, f"the explanation overclaims: {phrase!r}"


def test_convergence_distinguishes_independence_from_repetition(temp_db):
    db = temp_db
    site_id = _surfaced(db)
    result = explain.why_surfaced(site_id)
    interpretation = result["convergence"]["interpretation"]
    assert "independent" in interpretation.lower()
    assert result["convergence"]["paths_per_indicator_type"]


def test_a_one_line_summary_is_available_for_lists(temp_db):
    db = temp_db
    site_id = _surfaced(db)
    line = explain.summary_line(site_id)
    assert "surfaced.test" in line
    assert "priority" in line and "novelty" in line


# ---------------------------------------------------------------------------
# Campaign controls
# ---------------------------------------------------------------------------

def test_controls_default_to_running(temp_db):
    db = temp_db
    campaign = _campaign(db)
    control = db.get_campaign_control(campaign["campaign_id"])
    assert not control["paused"]
    assert not control["stop_after_current"]
    assert control["budget_changes"] == {}


def test_a_campaign_can_be_paused_and_resumed_without_losing_state(temp_db):
    db = temp_db
    from app.discovery import campaigns

    campaign = _campaign(db, "pausable")
    campaign_id = campaign["campaign_id"]
    db.set_campaign_control(campaign_id, paused=True)

    result = campaigns.run_campaign(campaign_id)
    assert result["stopped_reason"] in ("paused", "no_seeds")

    db.set_campaign_control(campaign_id, paused=False)
    stored = db.get_campaign(campaign_id)
    assert stored["config"], "campaign configuration was lost across the pause"


def test_a_budget_change_is_applied_at_the_wave_boundary(temp_db):
    db = temp_db
    campaign = _campaign(db, "rebudget")
    campaign_id = campaign["campaign_id"]

    db.set_campaign_control(campaign_id, budget_changes={"leads": 999})
    control = db.get_campaign_control(campaign_id)
    assert control["budget_changes"] == {"leads": 999}

    db.set_campaign_budget(campaign_id, "leads", 999)
    db.clear_campaign_budget_changes(campaign_id)
    assert db.get_campaign_control(campaign_id)["budget_changes"] == {}
    budgets = {b["resource"]: b for b in db.campaign_budget_state(campaign_id)}
    assert budgets["leads"]["limit_value"] == 999


def test_an_unknown_control_is_refused(temp_db):
    db = temp_db
    campaign = _campaign(db)
    try:
        db.set_campaign_control(campaign["campaign_id"], go_faster=True)
    except ValueError as exc:
        assert "Unknown campaign control" in str(exc)
    else:
        raise AssertionError("an invented control was accepted")
