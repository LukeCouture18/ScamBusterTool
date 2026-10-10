"""
Tests for app/discovery/technique_learning.py — the v0.4 yield ledger.

The risk this module carries is not that it learns too little but that it
learns too fast: a technique condemned on one unlucky run is gone for good,
and a discovery engine that has quietly disabled its best technique looks
exactly like one that is working. So the tests below care most about the
guard rails — small samples are not judged, suspension is reversible, and
every score can be explained from stored counters.
"""
from app.config import (
    TECHNIQUE_MIN_LEADS_FOR_CONFIDENCE, TECHNIQUE_SUSPENDED_THRESHOLD,
    TECHNIQUE_REDUCED_THRESHOLD,
)
from app.discovery import technique_learning as tl


def _stats(leads, candidates, unique_new, passed, high_conf):
    return {"leads_executed": leads, "candidates_returned": candidates,
            "unique_new_sites": unique_new, "sites_passing_triage": passed,
            "sites_high_confidence": high_conf}


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def test_a_technique_that_finds_nothing_useful_scores_badly():
    noise = tl.compute_yield(_stats(leads=40, candidates=800, unique_new=20,
                                    passed=0, high_conf=0))
    assert noise["yield_score"] < TECHNIQUE_SUSPENDED_THRESHOLD
    assert noise["confident"]


def test_a_technique_that_finds_real_sites_scores_well():
    good = tl.compute_yield(_stats(leads=30, candidates=60, unique_new=45,
                                   passed=30, high_conf=12))
    assert good["yield_score"] > TECHNIQUE_REDUCED_THRESHOLD


def test_every_score_states_the_arithmetic_behind_it():
    """v0.4: every score must be explainable from stored evidence."""
    result = tl.compute_yield(_stats(leads=10, candidates=50, unique_new=25,
                                     passed=10, high_conf=3))
    note = result["evidence_note"]
    assert "25/50" in note, "the uniqueness ratio is not shown"
    assert "10/25" in note, "the survival ratio is not shown"
    assert "3/25" in note, "the payoff ratio is not shown"
    assert str(result["yield_score"]) in note


def test_scores_stay_inside_zero_to_one():
    for stats in (_stats(0, 0, 0, 0, 0), _stats(1, 1, 1, 1, 1),
                  _stats(500, 500, 500, 500, 500)):
        score = tl.compute_yield(stats)["yield_score"]
        assert 0.0 <= score <= 1.0


def test_an_unrun_technique_is_neutral_not_condemned():
    fresh = tl.compute_yield(_stats(0, 0, 0, 0, 0))
    assert fresh["yield_score"] == tl.NEUTRAL_SCORE
    assert not fresh["confident"]


# ---------------------------------------------------------------------------
# Throttling — the part that can do damage
# ---------------------------------------------------------------------------

def test_a_small_sample_is_never_throttled():
    """One bad early run must not disable a technique permanently."""
    unlucky = tl.compute_yield(_stats(leads=TECHNIQUE_MIN_LEADS_FOR_CONFIDENCE - 1,
                                      candidates=30, unique_new=1, passed=0, high_conf=0))
    state, reason = tl.decide_throttle(unlucky, "normal")
    assert state == "normal"
    assert "too little evidence" in reason.lower()


def test_sustained_noise_is_suspended_with_a_reason():
    noisy = tl.compute_yield(_stats(leads=50, candidates=2000, unique_new=10,
                                    passed=0, high_conf=0))
    state, reason = tl.decide_throttle(noisy, "normal")
    assert state == "suspended"
    assert str(TECHNIQUE_SUSPENDED_THRESHOLD) in reason or "suspend threshold" in reason


def test_suspension_is_explicitly_reversible():
    """'Suspended' has to mean 'paused', never 'banned' — the web changes."""
    noisy = tl.compute_yield(_stats(leads=50, candidates=2000, unique_new=10,
                                    passed=0, high_conf=0))
    _state, reason = tl.decide_throttle(noisy, "normal")
    assert "re-tried" in reason.lower()
    for permanent in ("permanently", "never be run", "disabled for good", "banned"):
        assert permanent not in reason.lower()


def test_mediocre_yield_is_reduced_rather_than_suspended():
    # Finds plenty of genuinely new sites, half of which survive triage, but
    # none of them ever reach high confidence: worth running, worth demoting.
    middling = tl.compute_yield(_stats(leads=30, candidates=50, unique_new=40,
                                       passed=20, high_conf=0))
    assert TECHNIQUE_SUSPENDED_THRESHOLD <= middling["yield_score"] < TECHNIQUE_REDUCED_THRESHOLD
    state, _ = tl.decide_throttle(middling, "normal")
    assert state == "reduced"


# ---------------------------------------------------------------------------
# How learning changes behaviour
# ---------------------------------------------------------------------------

def test_priority_prefers_proven_techniques(temp_db):
    db = temp_db
    db.record_technique_result("wallet_reuse", candidates=60, unique_new=45)
    db.record_technique_outcome("wallet_reuse", passed_triage=30, high_confidence=12)
    for _ in range(30):
        db.record_technique_result("wallet_reuse")

    db.record_technique_result("domain_pattern", candidates=900, unique_new=15)
    for _ in range(40):
        db.record_technique_result("domain_pattern")

    tl.update_all_scores()
    assert tl.technique_priority("wallet_reuse") > tl.technique_priority("domain_pattern")


def test_an_unknown_technique_is_neither_preferred_nor_avoided(temp_db):
    assert tl.technique_priority("never_run_before") == 1.0


def test_suspended_techniques_drop_out_of_the_queue(temp_db):
    db = temp_db
    db.record_technique_result("domain_pattern", candidates=2000, unique_new=10)
    for _ in range(50):
        db.record_technique_result("domain_pattern")
    tl.update_all_scores()

    leads = [
        {"id": 1, "pivot_type": "domain_pattern", "depth": 0, "strength": 0.9},
        {"id": 2, "pivot_type": "wallet_reuse", "depth": 0, "strength": 0.5},
    ]
    ranked = tl.rank_leads(leads)
    assert [l["id"] for l in ranked] == [2], "a suspended technique should not be queued"


def test_shallower_leads_still_win_regardless_of_learning(temp_db):
    """Closer to the seed means better-evidenced; learning only breaks ties."""
    leads = [
        {"id": 1, "pivot_type": "a", "depth": 2, "strength": 0.99},
        {"id": 2, "pivot_type": "b", "depth": 0, "strength": 0.10},
    ]
    assert [l["id"] for l in tl.rank_leads(leads)] == [2, 1]


def test_skip_gate_lets_a_suspended_technique_back_in_periodically(temp_db):
    db = temp_db
    db.record_technique_result("domain_pattern", candidates=2000, unique_new=5)
    for _ in range(50):
        db.record_technique_result("domain_pattern")
    tl.update_all_scores()

    skip, reason = tl.should_skip_technique("domain_pattern")
    assert skip and reason

    # Once enough leads have run elsewhere, it is offered another chance.
    from app.config import TECHNIQUE_RETRY_AFTER_LEADS
    for _ in range(TECHNIQUE_RETRY_AFTER_LEADS):
        db.record_technique_result("wallet_reuse")
    skip_again, reason_again = tl.should_skip_technique("domain_pattern")
    assert not skip_again
    assert "re-try" in reason_again


def test_learning_report_labels_its_conclusions_as_derived(temp_db):
    db = temp_db
    db.record_technique_result("wallet_reuse", candidates=10, unique_new=8)
    tl.update_all_scores()
    report = tl.learning_report()
    assert report
    for row in report:
        assert row["evidence_class"] == "derived"
        assert row["evidence_note"]
