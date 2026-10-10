"""
v0.6 discovery quality: feedback learning, budget allocation, path quality,
cross-campaign dedup, rate limiting, history.

The through-line is that all six decide to do MORE or LESS of something based
on evidence, and the way each one fails is by acting on evidence that does not
support the decision. So most of what is tested is the restraint: small samples
move nothing, unknown values score nothing, bounds hold in both directions, and
nothing here ever becomes a claim about a site.
"""
from app.config import (
    FEEDBACK_MIN_SAMPLES, BUDGET_MIN_MULTIPLIER, BUDGET_MAX_MULTIPLIER,
    DEDUP_CORROBORATION_CAMPAIGNS,
)
from app.discovery import (
    feedback, budget_allocator, path_quality, dedup, rate_limiter,
)

WALLET = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"


# ---------------------------------------------------------------------------
# Downstream feedback
# ---------------------------------------------------------------------------

def test_outcome_words_are_about_the_lead_never_about_the_site(temp_db):
    useful = feedback.classify_outcome(deposit_pages=2, wallets=1, pages_examined=5)
    thin = feedback.classify_outcome(pages_examined=5)
    gone = feedback.classify_outcome(reachable=False)

    assert useful["outcome"] == "useful"
    assert thin["outcome"] == "thin"
    assert gone["outcome"] == "unreachable"

    blob = (useful["detail"] + thin["detail"] + gone["detail"]).lower()
    for phrase in ("malicious", "scam", "fraud", "guilty", "criminal"):
        assert phrase not in blob, f"outcome language overclaims: {phrase!r}"
    assert "about the lead, not" in thin["detail"]


def test_feedback_is_idempotent_so_redelivery_cannot_inflate_a_technique(temp_db):
    database = temp_db
    site_id = database.add_site("http://x.test", "campaign:wallet_reuse")

    first = feedback.record_outcome("fb-1", site_id=site_id, deposit_pages=2,
                                    wallets=1, pages_examined=4)
    second = feedback.record_outcome("fb-1", site_id=site_id, deposit_pages=2,
                                     wallets=1, pages_examined=4)

    assert first["recorded"] and not second["recorded"]
    assert "not doubled" in second["reason"]
    attribution = database.get_attribution("source", "campaign:wallet_reuse")
    assert attribution["candidates_examined"] == 1


def test_credit_goes_to_the_route_that_produced_the_candidate(temp_db):
    database = temp_db
    seed = database.add_site("http://seed.test", "test")
    site_id = database.add_site("http://found.test", "campaign:wallet_reuse")
    run_id = database.create_pivot_run("fb", 2, {})
    lead_id = database.add_pivot_lead(run_id, "k", "wallet_reuse", "wallet", WALLET,
                                      seed, 0, 0.9)
    database.record_discovery_path(run_id, site_id, "found.test", lead_id, seed, 1,
                                   "wallet_reuse", "wallet", WALLET, [{"s": 1}],
                                   "seed → wallet_reuse → found.test", 0.9)

    result = feedback.record_outcome("fb-2", site_id=site_id, deposit_pages=1,
                                     pages_examined=3, campaign_key="camp-1")

    assert "wallet_reuse" in result["attributed_to"]["pivots"]
    assert result["attributed_to"]["indicator_combo"] == "wallet"
    assert database.get_attribution("pivot", "wallet_reuse")["useful"] == 1
    assert database.get_attribution("campaign", "camp-1")["useful"] == 1


def test_an_unreachable_site_is_not_scored_against_the_technique(temp_db):
    """A site being down says nothing about the technique that found it."""
    stats = {"candidates_examined": 10, "useful": 0, "thin": 0, "unreachable": 10}
    result = feedback.compute_usefulness(stats)
    assert result["judgeable"] == 0
    assert result["usefulness_score"] == 0.5, "an outage was scored as failure"
    assert "excluded as uninformative" in result["evidence_note"]


def test_a_small_feedback_sample_stays_provisional(temp_db):
    stats = {"candidates_examined": FEEDBACK_MIN_SAMPLES - 1, "useful": 0,
             "thin": FEEDBACK_MIN_SAMPLES - 1, "unreachable": 0}
    result = feedback.compute_usefulness(stats)
    assert not result["confident"]
    assert "no budget is moved on it" in result["evidence_note"]


def test_usefulness_shows_its_arithmetic(temp_db):
    stats = {"candidates_examined": 20, "useful": 12, "thin": 8, "unreachable": 0,
             "deposit_pages": 15, "wallets": 10}
    result = feedback.compute_usefulness(stats)
    note = result["evidence_note"]
    assert "12/20" in note
    assert "signal density" in note
    assert str(result["usefulness_score"]) in note


# ---------------------------------------------------------------------------
# Budget allocation
# ---------------------------------------------------------------------------

def test_no_confident_feedback_moves_no_budget(temp_db):
    assert budget_allocator.multiplier_for({"confident": False,
                                            "usefulness_score": 0.05}) == 1.0
    assert budget_allocator.multiplier_for({"confident": False,
                                            "usefulness_score": 0.95}) == 1.0


def test_multipliers_stay_inside_their_bounds(temp_db):
    best = budget_allocator.multiplier_for({"confident": True, "usefulness_score": 1.0})
    worst = budget_allocator.multiplier_for({"confident": True, "usefulness_score": 0.0})
    assert best <= BUDGET_MAX_MULTIPLIER
    assert worst >= BUDGET_MIN_MULTIPLIER
    assert worst > 0, "a technique reduced to zero could never earn its way back"


def test_a_weak_technique_keeps_a_share_so_it_can_recover(temp_db):
    database = temp_db
    database.record_attribution("pivot", "weak", examined=20, thin=20)
    database.record_attribution("pivot", "strong", examined=20, useful=18,
                                deposit_pages=30, wallets=20)
    feedback.refresh_scores()

    allocation = budget_allocator.allocate(100, ["weak", "strong"])
    assert allocation["allocation"]["strong"] > allocation["allocation"]["weak"]
    assert allocation["allocation"]["weak"] > 0, "a weak technique was starved entirely"


def test_unproven_techniques_draw_from_a_reserved_share(temp_db):
    database = temp_db
    database.record_attribution("pivot", "proven", examined=30, useful=25,
                                deposit_pages=40, wallets=30)
    feedback.refresh_scores()

    allocation = budget_allocator.allocate(100, ["proven", "brand_new"])
    assert allocation["reserved_for_exploration"] > 0
    assert allocation["allocation"].get("brand_new", 0) > 0, (
        "a new technique got nothing, so it can never accumulate evidence")
    assert "earn its way back" in allocation["explanation"]


def test_allocation_explains_itself(temp_db):
    database = temp_db
    database.record_attribution("pivot", "wallet_reuse", examined=20, useful=15,
                                deposit_pages=20)
    feedback.refresh_scores()
    allocation = budget_allocator.allocate(50, ["wallet_reuse", "cert_san"])
    assert "usefulness" in allocation["explanation"]
    assert "unproven" in allocation["explanation"]


# ---------------------------------------------------------------------------
# Path quality
# ---------------------------------------------------------------------------

def _path(indicator_type="wallet", value=WALLET, depth=0, pivot="wallet_reuse"):
    return {"indicator_type": indicator_type, "indicator_value": value,
            "depth": depth, "pivot_type": pivot}


def test_an_operator_supplied_indicator_beats_inherited_hosting(temp_db):
    wallet = path_quality.score_path(_path("wallet", WALLET))
    nameserver = path_quality.score_path(_path("nameserver", "ns1.host.test",
                                               pivot="ns_neighbour"))
    assert wallet["quality_score"] > nameserver["quality_score"]
    assert wallet["operator_supplied"] and not nameserver["operator_supplied"]


def test_distance_from_the_seed_costs(temp_db):
    near = path_quality.score_path(_path(depth=0))
    far = path_quality.score_path(_path(depth=3))
    assert near["quality_score"] > far["quality_score"]
    assert far["depth_penalty"] > 0


def test_a_widely_shared_indicator_makes_a_weak_route(temp_db):
    database = temp_db
    # Same indicator type and value, but recorded on many sites.
    indicator_id = database.upsert_indicator("ip", "198.51.100.1")
    for n in range(60):
        site_id = database.add_site(f"http://bulk{n}.test", "test")
        database.record_observation(site_id, "ip", "198.51.100.1",
                                    f"http://bulk{n}.test", "dns", "x")

    broad = path_quality.score_path(_path("ip", "198.51.100.1", pivot="ip_neighbour"))
    narrow = path_quality.score_path(_path("ip", "203.0.113.9", pivot="ip_neighbour"))

    assert broad["breadth_penalty"] > 0
    assert broad["quality_score"] < narrow["quality_score"]
    assert indicator_id


def test_path_quality_explains_itself_and_claims_nothing(temp_db):
    result = path_quality.score_path(_path())
    explanation = result["explanation"]
    assert "Path quality" in explanation
    assert "operator-supplied" in explanation
    assert "not evidence that two sites share an operator" in explanation
    for phrase in ("proves", "same owner", "is malicious"):
        assert phrase not in explanation.lower()


def test_unscored_techniques_neither_help_nor_hurt(temp_db):
    result = path_quality.score_path(_path(pivot="never_run_before"))
    assert result["technique_quality"] == 0.0
    assert result["feedback_bonus"] == 0.0
    assert "no learned adjustment" in result["explanation"]


def test_rescoring_records_every_path(temp_db):
    database = temp_db
    seed = database.add_site("http://seed.test", "test")
    site_id = database.add_site("http://found.test", "test")
    run_id = database.create_pivot_run("pq", 2, {})
    lead_id = database.add_pivot_lead(run_id, "k", "wallet_reuse", "wallet", WALLET,
                                      seed, 0, 0.9)
    database.record_discovery_path(run_id, site_id, "found.test", lead_id, seed, 1,
                                   "wallet_reuse", "wallet", WALLET, [{"s": 1}],
                                   "seed → found", 0.9)

    result = path_quality.rescore_all()
    assert result["scored"] == 1
    summary = path_quality.site_path_summary(site_id)
    assert summary["best_quality"] is not None
    assert summary["paths"][0]["explanation"]


# ---------------------------------------------------------------------------
# Cross-campaign deduplication
# ---------------------------------------------------------------------------

def test_the_same_domain_is_one_candidate_however_it_is_written(temp_db):
    for value in ("http://Example.test/", "https://www.example.test",
                  "example.test:8080", "example.test."):
        assert dedup.canonical_domain(value) == "example.test", value


def test_subdomains_are_not_merged_into_their_parent(temp_db):
    """Merging them would silently move evidence between different sites."""
    assert dedup.canonical_domain("app.example.test") == "app.example.test"
    assert dedup.canonical_domain("example.test") == "example.test"


def test_rediscovery_by_another_campaign_is_corroboration_not_waste(temp_db):
    first = dedup.register("http://shared.test", campaign_key="camp-a", source="s1",
                           pivot_type="wallet_reuse")
    second = dedup.register("http://shared.test", campaign_key="camp-b", source="s2",
                            pivot_type="cert_san")

    assert first["first_time"] and not second["first_time"]
    assert second["distinct_campaigns"] >= DEDUP_CORROBORATION_CAMPAIGNS
    assert second["corroborated"]
    assert "corroborate each other" in second["explanation"]


def test_the_same_campaign_and_route_records_nothing_new(temp_db):
    dedup.register("http://shared.test", campaign_key="camp-a", source="s1",
                   pivot_type="wallet_reuse")
    repeat = dedup.register("http://shared.test", campaign_key="camp-a", source="s1",
                            pivot_type="wallet_reuse")
    assert not repeat["new_sighting"]
    assert "already been reached by this exact" in repeat["explanation"]


def test_corroboration_bonus_is_small_and_bounded(temp_db):
    for n in range(8):
        dedup.register("http://popular.test", campaign_key=f"camp-{n}",
                       source=f"source-{n}", pivot_type="wallet_reuse")
    bonus = dedup.corroboration_bonus("http://popular.test")
    assert 0 < bonus["bonus"] <= 0.12, "corroboration must not dominate real evidence"
    assert "says nothing about the domain" in bonus["explanation"]


def test_a_single_sighting_earns_no_bonus(temp_db):
    dedup.register("http://lonely.test", campaign_key="camp-a", source="s1")
    assert dedup.corroboration_bonus("http://lonely.test")["bonus"] == 0.0


def test_a_campaign_can_tell_what_it_already_handled(temp_db):
    dedup.register("http://seen.test", campaign_key="camp-a", source="s1")
    assert dedup.already_processed("http://seen.test", "camp-a")
    assert not dedup.already_processed("http://seen.test", "camp-b")


# ---------------------------------------------------------------------------
# API budgets and rate limits
# ---------------------------------------------------------------------------

def test_a_service_is_refused_once_its_window_is_used_up(temp_db):
    database = temp_db
    database.configure_api_budget("testsvc", calls_per_window=3, window_seconds=60)

    outcomes = [rate_limiter.acquire("testsvc")["allowed"] for _ in range(5)]
    assert outcomes == [True, True, True, False, False]
    assert "rate limit" in rate_limiter.check("testsvc")["reason"]


def test_a_daily_ceiling_holds_across_windows(temp_db):
    database = temp_db
    database.configure_api_budget("dailysvc", calls_per_window=100,
                                  window_seconds=1, daily_limit=2)
    assert rate_limiter.acquire("dailysvc")["allowed"]
    assert rate_limiter.acquire("dailysvc")["allowed"]
    refused = rate_limiter.acquire("dailysvc")
    assert not refused["allowed"]
    assert "daily limit" in refused["reason"]


def test_a_retry_after_is_obeyed_exactly(temp_db):
    database = temp_db
    database.configure_api_budget("politesvc", calls_per_window=100)
    result = rate_limiter.note_rate_limited("politesvc", retry_after=45)

    assert 44 <= result["wait_seconds"] <= 46
    assert "own Retry-After" in result["reason"]
    verdict = rate_limiter.check("politesvc")
    assert not verdict["allowed"]
    assert "obeyed as given" in verdict["reason"]


def test_backoff_grows_when_no_retry_after_is_given(temp_db):
    database = temp_db
    database.configure_api_budget("backoffsvc", calls_per_window=100)
    first = rate_limiter.note_rate_limited("backoffsvc")
    second = rate_limiter.note_rate_limited("backoffsvc")
    assert second["wait_seconds"] > first["wait_seconds"]


def test_a_successful_call_clears_accumulated_backoff(temp_db):
    database = temp_db
    database.configure_api_budget("clearsvc", calls_per_window=100)
    rate_limiter.note_rate_limited("clearsvc", retry_after=0)
    rate_limiter.note_success("clearsvc")
    assert database.get_api_budget("clearsvc")["consecutive_429"] == 0


def test_refusals_are_counted_but_never_raise(temp_db):
    database = temp_db
    database.configure_api_budget("countsvc", calls_per_window=1, window_seconds=60)
    rate_limiter.acquire("countsvc")
    rate_limiter.acquire("countsvc")
    assert database.get_api_budget("countsvc")["total_refused"] == 1


def test_limits_are_never_described_as_something_to_work_around(temp_db):
    database = temp_db
    database.configure_api_budget("notesvc", calls_per_window=1)
    report = rate_limiter.budget_report()
    assert "never worked around" in report["note"]
    for phrase in ("bypass", "rotate", "evade", "circumvent"):
        assert phrase not in report["note"].lower()


def test_budgets_survive_a_restart(temp_db):
    """In-memory counters would make crash-looping a way past every limit."""
    database = temp_db
    database.configure_api_budget("persistsvc", calls_per_window=5, window_seconds=600)
    rate_limiter.acquire("persistsvc")
    rate_limiter.acquire("persistsvc")

    # A "restart" is just reading the stored row again.
    assert database.get_api_budget("persistsvc")["calls_in_window"] == 2


# ---------------------------------------------------------------------------
# Historical tracking
# ---------------------------------------------------------------------------

def test_a_daily_snapshot_records_the_funnel(temp_db):
    database = temp_db
    database.add_site("http://a.test", "test")
    snapshot = database.snapshot_discovery_day("2026-01-01")

    assert snapshot["day"] == "2026-01-01"
    assert snapshot["discovered"] == 1
    history = database.discovery_history()
    assert history and history[-1]["day"] == "2026-01-01"


def test_recording_the_same_day_twice_replaces_rather_than_duplicates(temp_db):
    database = temp_db
    database.add_site("http://a.test", "test")
    database.snapshot_discovery_day("2026-01-02")
    database.add_site("http://b.test", "test")
    database.snapshot_discovery_day("2026-01-02")

    history = [row for row in database.discovery_history() if row["day"] == "2026-01-02"]
    assert len(history) == 1
    assert history[0]["discovered"] == 2
