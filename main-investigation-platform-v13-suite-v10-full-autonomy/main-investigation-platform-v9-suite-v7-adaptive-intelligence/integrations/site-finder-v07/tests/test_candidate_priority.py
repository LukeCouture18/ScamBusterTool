"""
Tests for app/discovery/candidate_priority.py.

This module decides where the expensive analysis budget goes, so the property
that matters most is that it is driven by evidence and nothing else. The
tempting bug is to treat missing information as mildly positive — an unknown
registration date scored as "probably new" — which quietly sends the budget to
candidates nothing is actually known about.
"""
from app.discovery import candidate_priority as cp

WALLET = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"


def _site(db, domain):
    return db.add_site(f"http://{domain}", "test")


def _passed_triage(db, site_id, status=200):
    db.record_triage(site_id, passed=True, triage_score=0.8, indicator_count=4,
                     indicators=["wallet"], reject_reason="", http_status=status)


# ---------------------------------------------------------------------------
# Factors fire only on evidence
# ---------------------------------------------------------------------------

def test_a_candidate_with_nothing_observed_scores_zero(temp_db):
    db = temp_db
    site = _site(db, "blank.test")
    result = cp.score_candidate(site)
    assert result["priority"] == 0.0
    assert result["factors"] == []
    assert "not ruled out" in result["explanation"]


def test_an_observed_wallet_raises_a_candidate(temp_db):
    db = temp_db
    bare = _site(db, "bare.test")
    with_wallet = _site(db, "paying.test")
    db.record_observation(with_wallet, "wallet", WALLET,
                          "http://paying.test/deposit", "page_text", "x")

    assert cp.score_candidate(with_wallet)["priority"] > cp.score_candidate(bare)["priority"]


def test_a_found_deposit_route_raises_a_candidate(temp_db):
    db = temp_db
    site = _site(db, "deposit.test")
    db.record_deposit_option(site, "http://deposit.test/pay", "crypto_transfer",
                             network="TRC20", label="USDT deposit")
    result = cp.score_candidate(site)
    assert any(f["factor"] == "deposit_observed" for f in result["factors"])


def test_an_unknown_registration_date_scores_nothing(temp_db):
    """Absence of evidence must never become evidence."""
    db = temp_db
    site = _site(db, "unknown-age.test")
    db.save_deep_profile(site, {"status": "complete", "domain": "unknown-age.test",
                                "full_url": "http://unknown-age.test",
                                "confidence_score": 0.5})
    result = cp.score_candidate(site)
    assert not any(f["factor"] == "newly_registered" for f in result["factors"])


def test_a_known_new_domain_scores_and_an_old_one_does_not(temp_db):
    db = temp_db
    new = _site(db, "new.test")
    old = _site(db, "old.test")
    db.save_deep_profile(new, {"status": "complete", "domain": "new.test",
                               "full_url": "http://new.test", "domain_age_days": 9})
    db.save_deep_profile(old, {"status": "complete", "domain": "old.test",
                               "full_url": "http://old.test", "domain_age_days": 4000})

    assert any(f["factor"] == "newly_registered" for f in cp.score_candidate(new)["factors"])
    assert not any(f["factor"] == "newly_registered" for f in cp.score_candidate(old)["factors"])


def test_an_unreachable_site_gets_no_activity_credit(temp_db):
    db = temp_db
    live = _site(db, "live.test")
    dead = _site(db, "dead.test")
    _passed_triage(db, live, status=200)
    db.record_triage(dead, passed=True, triage_score=0.8, indicator_count=4,
                     indicators=["wallet"], reject_reason="", http_status=None)

    assert any(f["factor"] == "responsive" for f in cp.score_candidate(live)["factors"])
    assert not any(f["factor"] == "responsive" for f in cp.score_candidate(dead)["factors"])


# ---------------------------------------------------------------------------
# Explainability
# ---------------------------------------------------------------------------

def test_every_factor_carries_its_own_evidence_and_class(temp_db):
    db = temp_db
    site = _site(db, "rich.test")
    db.record_observation(site, "wallet", WALLET, "http://rich.test/d", "page_text", "x")
    db.record_deposit_option(site, "http://rich.test/pay", "crypto_transfer", network="TRC20")
    _passed_triage(db, site)

    result = cp.score_candidate(site, connection_score=0.8)
    assert len(result["factors"]) >= 4
    for factor in result["factors"]:
        assert factor["evidence"].strip(), f"{factor['factor']} has no evidence"
        assert factor["evidence_class"] in ("observed", "derived")


def test_the_explanation_separates_observed_from_derived(temp_db):
    db = temp_db
    site = _site(db, "rich.test")
    db.record_observation(site, "wallet", WALLET, "http://rich.test/d", "page_text", "x")
    _passed_triage(db, site)
    result = cp.score_candidate(site, connection_score=0.8)
    assert "observed directly" in result["explanation"]


def test_priority_is_not_presented_as_a_judgement_about_the_site(temp_db):
    db = temp_db
    site = _site(db, "rich.test")
    db.record_observation(site, "wallet", WALLET, "http://rich.test/d", "page_text", "x")
    result = cp.score_candidate(site, connection_score=0.9)
    assert "not a judgement about the site" in result["explanation"]
    for phrase in ("proves", "same operator", "owned by the same", "single operation"):
        assert phrase not in result["explanation"].lower()


def test_priority_never_exceeds_one(temp_db):
    db = temp_db
    site = _site(db, "everything.test")
    db.record_observation(site, "wallet", WALLET, "http://everything.test/d", "page_text", "x")
    db.record_deposit_option(site, "http://everything.test/pay", "crypto_transfer")
    db.save_deep_profile(site, {"status": "complete", "domain": "everything.test",
                                "full_url": "http://everything.test", "domain_age_days": 1})
    _passed_triage(db, site)
    assert cp.score_candidate(site, connection_score=5.0)["priority"] <= 1.0


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------

def test_ranking_puts_the_best_evidenced_candidate_first(temp_db):
    db = temp_db
    bare = _site(db, "bare.test")
    strong = _site(db, "strong.test")
    db.record_observation(strong, "wallet", WALLET, "http://strong.test/d", "page_text", "x")
    db.record_deposit_option(strong, "http://strong.test/pay", "crypto_transfer")
    _passed_triage(db, strong)

    ranked = cp.rank_candidates([bare, strong], connection_scores={strong: 0.8, bare: 0.1})
    assert ranked[0]["site_id"] == strong
    assert ranked[-1]["site_id"] == bare


def test_ranking_an_unknown_site_does_not_crash(temp_db):
    ranked = cp.rank_candidates([9999])
    assert ranked[0]["priority"] == 0.0
