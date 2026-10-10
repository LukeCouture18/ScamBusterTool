"""
v0.5 discovery-intelligence upgrades: noise retirement, handoff, stats.

These three share a theme. Each one decides to do less of something — stop
pivoting on an indicator, stop crawling a site, stop trusting a number — and
the risk in all three is the same: deciding to do less on evidence that does
not support it. So most of what is tested here is the restraint, not the
action.
"""
from app.config import INDICATOR_NOISE_MIN_CANDIDATES
from app.discovery import indicator_noise, discovery_stats
from app.integration import handoff
from app.integration.v4.client import PlatformClient
from app.integration.v4.reference_platform import ReferencePlatform, patched_sdk

WALLET = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"


# ---------------------------------------------------------------------------
# Indicator noise: stop wasting budget, but only on evidence
# ---------------------------------------------------------------------------

def test_an_indicator_with_a_small_sample_is_never_retired(temp_db):
    """Retiring on a handful of unlucky lookups would remove good indicators."""
    db = temp_db
    db.record_indicator_yield("ip", "198.51.100.1",
                              leads=2, candidates=INDICATOR_NOISE_MIN_CANDIDATES - 1,
                              unique_new=3, passed_triage=0)
    result = indicator_noise.evaluate_and_retire()

    assert result["retired"] == 0
    assert result["too_little_evidence"] == 1
    allowed, _ = indicator_noise.should_pivot_on("ip", "198.51.100.1", site_count=2)
    assert allowed


def test_volume_without_results_is_retired_with_its_numbers(temp_db):
    db = temp_db
    db.record_indicator_yield("nameserver", "ns1.bulkhost.test",
                              leads=20, candidates=400, unique_new=200, passed_triage=0)
    result = indicator_noise.evaluate_and_retire()

    assert result["retired"] == 1
    reason = result["details"][0]["reason"]
    assert "400 candidate(s)" in reason
    assert "0 cleared triage" in reason
    assert "The observation itself is kept" in reason

    allowed, refusal = indicator_noise.should_pivot_on("nameserver", "ns1.bulkhost.test")
    assert not allowed and refusal


def test_an_indicator_that_produced_something_useful_is_kept(temp_db):
    """One real discovery outweighs a poor survival rate."""
    db = temp_db
    db.record_indicator_yield("ip", "198.51.100.2",
                              leads=20, candidates=500, unique_new=300,
                              passed_triage=0, sent=1)
    result = indicator_noise.evaluate_and_retire()
    assert result["retired"] == 0
    assert result["kept"] == 1


def test_a_widely_shared_indicator_is_refused_before_any_budget_is_spent(temp_db):
    allowed, refusal = indicator_noise.should_pivot_on("ip", "104.20.0.1", site_count=900)
    assert not allowed
    assert "sites" in refusal


def test_retirement_can_be_reversed(temp_db):
    db = temp_db
    db.retire_indicator("ip", "198.51.100.3", "retired for the test")
    assert not indicator_noise.should_pivot_on("ip", "198.51.100.3")[0]

    assert indicator_noise.reinstate("ip", "198.51.100.3")
    assert indicator_noise.should_pivot_on("ip", "198.51.100.3")[0]


def test_retirement_never_claims_anything_about_the_sites(temp_db):
    db = temp_db
    db.record_indicator_yield("nameserver", "ns2.bulkhost.test",
                              leads=10, candidates=300, unique_new=150, passed_triage=0)
    indicator_noise.evaluate_and_retire()
    report = indicator_noise.noise_report()

    blob = (report["note"] + " ".join(r.get("retired_reason") or ""
                                       for r in report["retired"])).lower()
    for phrase in ("malicious", "same operator", "owned by", "proves", "is a scam"):
        assert phrase not in blob, f"retirement language overclaims: {phrase!r}"
    assert "does not delete the observation" in report["note"]


# ---------------------------------------------------------------------------
# Handoff: Site Finder must stay usable alone
# ---------------------------------------------------------------------------

def _online_client(platform):
    sdk, _ = patched_sdk(platform)
    client = PlatformClient(base_url="http://platform.test", api_key="test-key", sdk=sdk)
    client.register()
    client.heartbeat()
    return client


def test_deep_work_is_handed_over_when_the_platform_is_reachable(temp_db):
    platform = ReferencePlatform()
    client = _online_client(platform)
    decision = handoff.decide_mode(client)
    assert decision["mode"] == "handoff"
    assert "Site Investigator" in decision["reason"]


def test_deep_work_falls_back_to_local_when_the_platform_is_unreachable(temp_db):
    """A network problem must not leave candidates uninvestigated."""
    platform = ReferencePlatform()
    sdk, _ = patched_sdk(platform, fail_with=ConnectionError("down"))
    client = PlatformClient(base_url="http://platform.test", api_key="test-key", sdk=sdk)
    client.heartbeat()
    decision = handoff.decide_mode(client)

    assert decision["mode"] == "local"
    assert "queued" in decision["reason"]


def test_with_no_platform_configured_everything_stays_local(temp_db):
    client = PlatformClient(base_url="", api_key="")
    decision = handoff.decide_mode(client)
    assert decision["mode"] == "local"
    assert "nobody to hand off to" in decision["reason"]


def test_a_handoff_is_recorded_on_the_sites_timeline(temp_db):
    db = temp_db
    platform = ReferencePlatform()
    client = _online_client(platform)

    site_id = db.add_site("http://handme.test", "campaign:wallet_reuse")
    db.record_observation(site_id, "wallet", WALLET, "http://handme.test/d", "page_text", "s")
    db.record_observation(site_id, "telegram", "deskhandle", "http://handme.test/", "page_text", "s")
    db.record_deposit_option(site_id, "http://handme.test/pay", "crypto_transfer", network="TRC20")
    db.record_triage(site_id, passed=True, triage_score=0.8, indicator_count=4,
                     indicators=["wallet"], reject_reason="", http_status=200)

    result = handoff.handoff_for_site(site_id, client=client)
    assert result["mode"] == "handoff"

    events = [e["event_type"] for e in db.timeline_for_site(site_id)]
    assert "handoff" in events


def test_a_candidate_that_fails_the_gate_is_not_handed_over(temp_db):
    db = temp_db
    platform = ReferencePlatform()
    client = _online_client(platform)

    weak = db.add_site("http://nothingmuch.test", "keyword_search")
    db.record_triage(weak, passed=True, triage_score=0.2, indicator_count=1,
                     indicators=["language"], reject_reason="", http_status=200)

    result = handoff.handoff_for_site(weak, client=client)
    assert result["mode"] == "none"
    assert result["blocked_by"]
    assert platform.investigation_for_domain("nothingmuch.test") is None


# ---------------------------------------------------------------------------
# Statistics: which sources and pivots actually produce
# ---------------------------------------------------------------------------

def test_sources_are_ranked_by_what_they_delivered_not_by_volume(temp_db):
    db = temp_db
    # A firehose that produces nothing useful.
    db.record_source_yield("keyword_search", candidates=500, passed_triage=4, sent=0)
    # A narrow source that produces real work.
    db.record_source_yield("campaign:wallet_reuse", candidates=40, passed_triage=25, sent=12)

    ranked = discovery_stats.source_performance()["sources"]
    assert ranked[0]["source"] == "campaign:wallet_reuse", (
        "a high-volume, low-yield source outranked a productive one")


def test_an_unmeasured_source_is_flagged_and_not_promoted(temp_db):
    db = temp_db
    db.record_source_yield("proven", candidates=200, passed_triage=80, sent=40)
    db.record_source_yield("brand_new", candidates=2, passed_triage=2, sent=2)

    ranked = discovery_stats.source_performance()["sources"]
    by_name = {s["source"]: s for s in ranked}

    assert by_name["brand_new"]["measured"] is False
    assert "provisional" in by_name["brand_new"]["note"]
    assert ranked[0]["source"] == "proven", (
        "a perfect rate on two candidates must not outrank a measured source")


def test_pivot_performance_shows_the_whole_funnel(temp_db):
    db = temp_db
    db.record_technique_result("wallet_reuse", candidates=50, unique_new=40)
    db.record_technique_outcome("wallet_reuse", passed_triage=20, sent_to_platform=8)
    for _ in range(10):
        db.record_technique_result("wallet_reuse")

    row = discovery_stats.pivot_performance()["pivots"][0]
    for key in ("candidates", "unique_new", "passed_triage", "sent_to_platform",
                "uniqueness_rate", "triage_rate", "send_rate"):
        assert key in row, f"the funnel is missing {key}"
    assert row["send_rate"] == round(8 / 40, 3)


def test_campaign_performance_reports_cost_per_useful_result(temp_db):
    db = temp_db
    from app.discovery import campaigns
    created = campaigns.create_campaign("measured", "domain", "seed.test")
    db.update_campaign(created["campaign_id"],
                       stats={"leads_executed": 40, "candidates_found": 120,
                              "new_sites": 30, "validated": 10, "promoted": 4})

    row = discovery_stats.campaign_performance(created["campaign_id"])["campaigns"][0]
    assert row["cost_per_promoted"] == 10.0
    assert row["promotion_rate"] == 0.4


def test_overview_reports_the_funnel_and_names_its_best_and_worst(temp_db):
    db = temp_db
    db.record_source_yield("good", candidates=100, passed_triage=60, sent=30)
    db.record_source_yield("bad", candidates=100, passed_triage=2, sent=0)

    overview = discovery_stats.overview()
    assert overview["funnel"]["discovered"] is not None
    assert overview["best_source"]["source"] == "good"
    assert overview["worst_source"]["source"] == "bad"
    assert "unmeasured source is not a good one" in overview["note"]


def test_stats_never_rank_on_a_rate_built_from_nothing(temp_db):
    """A 100%-conversion source with one candidate is unmeasured, not best."""
    db = temp_db
    db.record_source_yield("lucky", candidates=1, passed_triage=1, sent=1)
    overview = discovery_stats.overview()
    assert overview["best_source"] is None, (
        "a single lucky candidate was promoted to best source")
