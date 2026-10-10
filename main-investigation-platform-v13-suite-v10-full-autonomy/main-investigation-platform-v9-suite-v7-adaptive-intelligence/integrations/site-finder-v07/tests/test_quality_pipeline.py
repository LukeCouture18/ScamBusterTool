"""
Tests for the quality-over-quantity pipeline: the funnel shape, the confidence
model, and the promotion rules between stages.
"""
from app.analysis.deep_analyzer import compute_confidence, EVIDENCE_WEIGHTS
from app.analysis.pipeline_v2 import funnel_stats
from app.config import HIGH_CONFIDENCE_THRESHOLD


def test_keyword_only_evidence_scores_zero_confidence():
    """No independent evidence types means no confidence, by construction."""
    confidence, contributing = compute_confidence({})
    assert confidence == 0.0
    assert contributing == []


def test_single_evidence_type_is_not_high_confidence():
    """Finding a wallet alone is interesting but not conclusive."""
    confidence, _ = compute_confidence({"validated_wallet": True})
    assert confidence < HIGH_CONFIDENCE_THRESHOLD


def test_multiple_independent_evidence_types_reach_high_confidence():
    confidence, contributing = compute_confidence({
        "validated_wallet": True,
        "wallet_has_activity": True,
        "deposit_page": True,
        "multiple_triage_categories": True,
        "new_domain": True,
        "offplatform_contact": True,
    })
    assert confidence >= HIGH_CONFIDENCE_THRESHOLD
    assert len(contributing) == 6


def test_confidence_is_capped_at_one():
    confidence, _ = compute_confidence({key: True for key in EVIDENCE_WEIGHTS})
    assert confidence == 1.0


def test_confidence_increases_monotonically_with_evidence():
    """Adding an evidence type must never lower confidence."""
    base = {"validated_wallet": True}
    more = {"validated_wallet": True, "deposit_page": True}
    most = {"validated_wallet": True, "deposit_page": True, "threat_intel_hit": True}
    assert compute_confidence(base)[0] < compute_confidence(more)[0] < compute_confidence(most)[0]


def test_on_chain_activity_meaningfully_raises_confidence():
    """A wallet that has actually moved money is stronger evidence than one that hasn't."""
    without = compute_confidence({"validated_wallet": True, "deposit_page": True})[0]
    with_activity = compute_confidence({
        "validated_wallet": True, "deposit_page": True, "wallet_has_activity": True})[0]
    assert with_activity > without


def test_funnel_stats_on_empty_database(temp_db):
    stats = funnel_stats()
    assert stats["discovered"] == 0
    assert stats["high_confidence_results"] == 0


def test_funnel_narrows_at_each_stage(temp_db):
    """
    The defining property of the pipeline: each stage must be a subset of the
    previous one. More results at a later stage than an earlier one would mean
    the funnel is leaking.
    """
    db = temp_db
    for i in range(10):
        db.add_site(f"http://site{i}.test", "test")
    # Only 3 clear triage.
    for i, site in enumerate(db.list_sites(limit=10)):
        passed = i < 3
        db.record_triage(site["id"], passed=passed, triage_score=8.0 if passed else 1.0,
                          indicator_count=4 if passed else 1, indicators=[],
                          reject_reason="" if passed else "too weak")
    # Only 1 of those becomes a high-confidence profile.
    strong = db.list_sites(limit=10)[0]
    db.save_deep_profile(strong["id"], {
        "status": "complete", "domain": strong["domain"], "full_url": strong["url"],
        "confidence_score": 0.9, "risk_score": 9.0,
    })

    stats = funnel_stats()
    assert stats["discovered"] == 10
    assert stats["passed_triage"] == 3
    assert stats["deep_analyzed"] == 1
    assert stats["high_confidence_results"] == 1
    assert stats["discovered"] >= stats["passed_triage"] >= stats["deep_analyzed"]


def test_only_triage_survivors_are_queued_for_deep_analysis(temp_db):
    db = temp_db
    weak = db.add_site("http://weak.test", "test")
    strong = db.add_site("http://strong.test", "test")
    db.record_triage(weak, passed=False, triage_score=1.0, indicator_count=1,
                      indicators=[], reject_reason="too weak")
    db.record_triage(strong, passed=True, triage_score=9.0, indicator_count=5, indicators=[])

    queued = db.sites_passing_triage_awaiting_deep()
    queued_ids = [s["id"] for s in queued]
    assert strong in queued_ids
    assert weak not in queued_ids


def test_deep_queue_orders_by_indicator_strength(temp_db):
    """Strongest candidates get the expensive treatment first."""
    db = temp_db
    weaker = db.add_site("http://weaker.test", "test")
    stronger = db.add_site("http://stronger.test", "test")
    db.record_triage(weaker, passed=True, triage_score=7.0, indicator_count=3, indicators=[])
    db.record_triage(stronger, passed=True, triage_score=15.0, indicator_count=7, indicators=[])

    queued = db.sites_passing_triage_awaiting_deep()
    assert queued[0]["id"] == stronger


def test_results_view_excludes_low_confidence_profiles(temp_db):
    """The results list is the deliverable — weak profiles must not appear in it."""
    db = temp_db
    low = db.add_site("http://low.test", "test")
    high = db.add_site("http://high.test", "test")
    db.save_deep_profile(low, {"status": "complete", "domain": "low.test",
                                "full_url": "http://low.test", "confidence_score": 0.3})
    db.save_deep_profile(high, {"status": "complete", "domain": "high.test",
                                 "full_url": "http://high.test", "confidence_score": 0.9})

    results = db.list_deep_profiles(min_confidence=HIGH_CONFIDENCE_THRESHOLD)
    domains = [r["domain"] for r in results]
    assert "high.test" in domains
    assert "low.test" not in domains
