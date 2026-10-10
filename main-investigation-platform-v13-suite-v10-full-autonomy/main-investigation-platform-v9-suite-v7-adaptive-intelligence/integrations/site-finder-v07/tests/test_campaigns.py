"""
Tests for app/discovery/campaigns.py — v0.4 multi-stage resumable campaigns.

Three properties matter and each is tested on its own:

1. A campaign walks Seed → Pivot → Candidate → Validate → Expand and records
   each boundary, so the discovery path of every candidate is reconstructable.

2. An interrupted campaign resumes without redoing completed work. This is the
   whole reason stage boundaries are persisted, so it is tested by actually
   interrupting a run mid-flight and resuming it.

3. Budgets stop it. A discovery engine that can overrun its API-call or
   candidate allowance is unsafe to leave running, so every ledger is tested
   for the refusal path, not just the happy path.

The campaigns here run entirely off stored indicators. No test reaches the
network: triage results are pre-recorded so the validation gate is exercised
without fetching anything.
"""
from app.discovery import campaigns

WALLET = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"
TELEGRAM = "cryptovaultsupport"


def _confident(db, domain, confidence=0.88):
    site_id = db.add_site(f"http://{domain}", "test")
    db.save_deep_profile(site_id, {
        "status": "complete", "domain": domain, "full_url": f"http://{domain}",
        "confidence_score": confidence})
    return site_id


def _pass_triage(db, site_id):
    """Pre-record a triage pass so validation never has to fetch anything."""
    db.record_triage(site_id, passed=True, triage_score=0.8, indicator_count=4,
                     indicators=["wallet", "deposit", "guaranteed_returns", "new_domain"],
                     reject_reason="", http_status=200)


def _wallet_network(db):
    """seed --wallet--> sibling; sibling also shares a Telegram handle with cousin."""
    seed = _confident(db, "seed.test")
    db.record_observation(seed, "wallet", WALLET, "http://seed.test/deposit", "page_text", "x")

    sibling = db.add_site("http://sibling.test", "test")
    db.record_observation(sibling, "wallet", WALLET, "http://sibling.test/deposit", "page_text", "x")
    db.record_observation(sibling, "telegram", TELEGRAM, "http://sibling.test/", "page_text", "x")

    cousin = db.add_site("http://cousin.test", "test")
    db.record_observation(cousin, "telegram", TELEGRAM, "http://cousin.test/", "page_text", "x")

    for s in (sibling, cousin):
        _pass_triage(db, s)
    return seed, sibling, cousin


# ---------------------------------------------------------------------------
# Stage machinery
# ---------------------------------------------------------------------------

def test_campaign_walks_all_five_stages(temp_db):
    db = temp_db
    _wallet_network(db)

    created = campaigns.create_campaign("wallet family", "domain", "seed.test",
                                        max_waves=2, promote_min_connection=0.1)
    result = campaigns.run_campaign(created["campaign_id"])

    assert result["status"] in ("completed", "stopped")
    stages = {s["stage"] for s in db.stages_for_campaign(created["campaign_id"])}
    assert stages == set(campaigns.STAGES), f"missing stages: {set(campaigns.STAGES) - stages}"


def test_campaign_reaches_a_site_that_shares_an_indicator_with_the_seed(temp_db):
    db = temp_db
    _seed, sibling, _cousin = _wallet_network(db)

    created = campaigns.create_campaign("c", "domain", "seed.test", promote_min_connection=0.1)
    campaigns.run_campaign(created["campaign_id"])

    paths = db.paths_for_site(sibling)
    assert paths, "the site sharing a wallet with the seed should have been reached"
    assert paths[0]["pivot_type"] == "wallet_reuse"


def test_every_candidate_carries_an_explainable_discovery_path(temp_db):
    """v0.4 requires every score and relationship to be explainable from evidence."""
    db = temp_db
    _wallet_network(db)
    created = campaigns.create_campaign("c", "domain", "seed.test", promote_min_connection=0.1)
    campaigns.run_campaign(created["campaign_id"])

    report = campaigns.campaign_report(created["campaign_id"])
    assert report["candidates"], "campaign produced no candidates to explain"
    for candidate in report["candidates"]:
        assert candidate["discovery_paths"], f"{candidate['domain']} has no discovery path"
        for path in candidate["discovery_paths"]:
            assert path["path_text"].strip(), "a discovery path has no human-readable text"
            assert path["pivot_type"], "a discovery path does not say which technique found it"


def test_report_separates_derived_correlation_from_observed_fact(temp_db):
    db = temp_db
    _wallet_network(db)
    created = campaigns.create_campaign("c", "domain", "seed.test", promote_min_connection=0.1)
    campaigns.run_campaign(created["campaign_id"])

    report = campaigns.campaign_report(created["campaign_id"])
    for candidate in report["candidates"]:
        assert candidate["evidence_class"] == "derived", (
            "a connection score is software-derived and must be labelled as such")


# ---------------------------------------------------------------------------
# Seeds
# ---------------------------------------------------------------------------

def test_seed_kinds_all_resolve_without_inventing_sites(temp_db):
    db = temp_db
    seed, sibling, _ = _wallet_network(db)

    assert campaigns.resolve_seed("domain", "seed.test")["site_ids"] == [seed]

    wallet = campaigns.resolve_seed("wallet", WALLET)
    assert set(wallet["site_ids"]) == {seed, sibling}

    unknown = campaigns.resolve_seed("infrastructure", "203.0.113.99")
    assert unknown["site_ids"] == []
    assert "no known site" in unknown["note"].lower()


def test_unsupported_seed_kind_is_refused_at_creation(temp_db):
    try:
        campaigns.create_campaign("bad", "telepathy", "x")
    except ValueError as exc:
        assert "seed kind" in str(exc)
    else:
        raise AssertionError("an unsupported seed kind should not create a campaign")


# ---------------------------------------------------------------------------
# Resumption
# ---------------------------------------------------------------------------

def test_interrupted_campaign_resumes_without_repeating_completed_stages(temp_db):
    db = temp_db
    _wallet_network(db)
    created = campaigns.create_campaign("resumable", "domain", "seed.test",
                                        max_waves=2, promote_min_connection=0.1)
    cid = created["campaign_id"]

    # Interrupt as soon as the pivot stage finishes.
    state = {"stop": False}

    def progress(event, data):
        if event == "campaign_stage" and data.get("stage") == "pivot":
            state["stop"] = True

    first = campaigns.run_campaign(cid, progress_cb=progress, should_stop=lambda: state["stop"])
    assert first["status"] == "stopped"

    stages = {s["stage"]: s for s in db.stages_for_campaign(cid)}
    assert stages["seed"]["status"] == "complete"
    assert stages["pivot"]["status"] == "complete"
    assert stages["candidate"]["status"] == "interrupted", (
        "a stage cut short must not be recorded as complete, or the resume would skip it")

    second = campaigns.run_campaign(cid)
    assert second["stages_skipped_on_resume"] >= 2, (
        "the already-completed seed and pivot stages should have been skipped")
    assert second["leads_executed"] > 0, "the resumed run should have done the work that was left"


def test_completed_leads_are_not_run_twice_across_resumes(temp_db):
    db = temp_db
    _wallet_network(db)
    created = campaigns.create_campaign("once", "domain", "seed.test",
                                        max_waves=1, promote_min_connection=0.1)
    cid = created["campaign_id"]

    campaigns.run_campaign(cid)
    done_first = db.completed_work_count(cid)
    leads_first = db.get_campaign(cid)["stats"]["leads_executed"]

    # Reopen the campaign and run it again: the ledger of completed work should
    # stop it from re-executing anything it already finished.
    db.update_campaign(cid, status="paused", current_wave=0)
    campaigns.run_campaign(cid)

    assert db.completed_work_count(cid) == done_first, (
        "re-running a finished campaign should not add new completed work")
    assert leads_first > 0


def test_a_completed_campaign_reports_rather_than_restarting(temp_db):
    db = temp_db
    _wallet_network(db)
    created = campaigns.create_campaign("done", "domain", "seed.test", promote_min_connection=0.1)
    campaigns.run_campaign(created["campaign_id"])
    db.update_campaign(created["campaign_id"], status="completed")

    again = campaigns.run_campaign(created["campaign_id"])
    assert again["status"] == "completed"
    assert "nothing to resume" in again["note"].lower()


# ---------------------------------------------------------------------------
# Budgets — the runaway brakes
# ---------------------------------------------------------------------------

def test_lead_budget_caps_how_many_leads_a_campaign_runs(temp_db):
    db = temp_db
    _wallet_network(db)
    created = campaigns.create_campaign("tiny", "domain", "seed.test",
                                        max_waves=3, max_leads=1, promote_min_connection=0.1)
    result = campaigns.run_campaign(created["campaign_id"])

    assert result["leads_executed"] <= 1, "the lead ledger did not hold"
    budget = {b["resource"]: b for b in db.campaign_budget_state(created["campaign_id"])}
    assert budget["leads"]["used_value"] <= budget["leads"]["limit_value"]


def test_candidate_budget_caps_how_many_new_sites_are_added(temp_db):
    db = temp_db
    seed = _confident(db, "seed.test")
    db.record_observation(seed, "wallet", WALLET, "http://seed.test/d", "page_text", "x")
    for n in range(6):
        other = db.add_site(f"http://sib{n}.test", "test")
        db.record_observation(other, "wallet", WALLET, f"http://sib{n}.test/d", "page_text", "x")
        _pass_triage(db, other)

    created = campaigns.create_campaign("capped", "domain", "seed.test",
                                        max_candidates=2, promote_min_connection=0.1)
    campaigns.run_campaign(created["campaign_id"])

    budget = {b["resource"]: b for b in db.campaign_budget_state(created["campaign_id"])}
    assert budget["candidates"]["used_value"] <= budget["candidates"]["limit_value"]


def test_a_refused_spend_does_not_consume_budget(temp_db):
    db = temp_db
    created = campaigns.create_campaign("ledger", "domain", "nothing.test", max_api_calls=2)
    cid = created["campaign_id"]

    outcomes = [db.spend_budget(cid, "api_calls") for _ in range(4)]
    assert outcomes == [True, True, False, False]

    budget = {b["resource"]: b for b in db.campaign_budget_state(cid)}
    assert budget["api_calls"]["used_value"] == 2, (
        "a refused spend must not consume budget, or the ledger drifts")


def test_time_limit_stops_a_campaign(temp_db):
    db = temp_db
    _wallet_network(db)
    created = campaigns.create_campaign("timed", "domain", "seed.test",
                                        max_waves=5, max_seconds=0, promote_min_connection=0.1)
    result = campaigns.run_campaign(created["campaign_id"])
    assert result["stopped_reason"] == "time_limit"
    assert result["status"] == "stopped"


def test_deep_analysis_budget_caps_promotions(temp_db):
    db = temp_db
    seed = _confident(db, "seed.test")
    db.record_observation(seed, "wallet", WALLET, "http://seed.test/d", "page_text", "x")
    for n in range(5):
        other = db.add_site(f"http://sib{n}.test", "test")
        db.record_observation(other, "wallet", WALLET, f"http://sib{n}.test/d", "page_text", "x")
        _pass_triage(db, other)

    created = campaigns.create_campaign("promo", "domain", "seed.test",
                                        max_deep_analyses=1, promote_min_connection=0.1)
    result = campaigns.run_campaign(created["campaign_id"])
    assert result["promoted"] <= 1, "more sites were promoted to deep analysis than budgeted"


# ---------------------------------------------------------------------------
# The validation gate
# ---------------------------------------------------------------------------

def test_weakly_connected_candidates_are_set_aside_with_a_stated_reason(temp_db):
    db = temp_db
    _wallet_network(db)
    reasons = []

    def progress(event, data):
        if event == "campaign_candidate_rejected":
            reasons.append(data["reason"])

    # An impossible threshold: nothing can clear it, so everything is set aside.
    created = campaigns.create_campaign("strict", "domain", "seed.test",
                                        promote_min_connection=2.0)
    result = campaigns.run_campaign(created["campaign_id"], progress_cb=progress)

    assert result["promoted"] == 0
    assert reasons, "a rejected candidate must come with a reason"
    assert "below the promotion threshold" in reasons[0]


def test_a_scarce_deep_analysis_budget_goes_to_the_best_evidenced_candidate(temp_db):
    """
    With room for one deep analysis and two survivors, the one with a wallet
    and a deposit route on it must be the one that gets it.
    """
    db = temp_db
    seed = _confident(db, "seed.test")
    db.record_observation(seed, "wallet", WALLET, "http://seed.test/d", "page_text", "x")

    plain = db.add_site("http://plain.test", "test")
    db.record_observation(plain, "wallet", WALLET, "http://plain.test/d", "page_text", "x")
    _pass_triage(db, plain)

    rich = db.add_site("http://rich.test", "test")
    db.record_observation(rich, "wallet", WALLET, "http://rich.test/d", "page_text", "x")
    db.record_observation(rich, "telegram", TELEGRAM, "http://rich.test/", "page_text", "x")
    db.record_deposit_option(rich, "http://rich.test/pay", "crypto_transfer", network="TRC20")
    _pass_triage(db, rich)

    promoted = []

    def progress(event, data):
        if event == "campaign_candidate_promoted":
            promoted.append(data["domain"])

    created = campaigns.create_campaign("scarce", "domain", "seed.test", max_waves=1,
                                        max_deep_analyses=1, promote_min_connection=0.1)
    campaigns.run_campaign(created["campaign_id"], progress_cb=progress)

    assert promoted == ["rich.test"], f"budget went to the wrong candidate: {promoted}"


def test_a_promotion_records_why_it_was_prioritised(temp_db):
    db = temp_db
    _wallet_network(db)
    reasons = []

    def progress(event, data):
        if event == "campaign_candidate_promoted":
            reasons.append(data["reason"])

    created = campaigns.create_campaign("explain", "domain", "seed.test",
                                        promote_min_connection=0.1)
    campaigns.run_campaign(created["campaign_id"], progress_cb=progress)

    assert reasons
    assert "Priority" in reasons[0]
    assert "observed directly" in reasons[0]


def test_campaign_language_never_claims_shared_ownership(temp_db):
    """
    The user's standing constraint: shared infrastructure or a reused wallet is
    an observation, never proof of common ownership or wrongdoing. This fails
    the build if that language ever creeps back into campaign output.
    """
    import pathlib
    banned = ["same party", "owned by the same", "single operation", "same operator",
              "proves", "confirms they are", "run by the same"]

    source = pathlib.Path(campaigns.__file__).read_text(encoding="utf-8").lower()
    for phrase in banned:
        assert phrase not in source, f"campaigns.py overclaims: {phrase!r}"

    db = temp_db
    _wallet_network(db)
    created = campaigns.create_campaign("c", "domain", "seed.test", promote_min_connection=0.1)
    campaigns.run_campaign(created["campaign_id"])
    report = campaigns.campaign_report(created["campaign_id"])

    blob = (report["note"] + " ".join(
        p["path_text"] for c in report["candidates"] for p in c["discovery_paths"])).lower()
    for phrase in banned:
        assert phrase not in blob, f"campaign output overclaims: {phrase!r}"
    assert "not a finding about ownership" in report["note"].lower()
