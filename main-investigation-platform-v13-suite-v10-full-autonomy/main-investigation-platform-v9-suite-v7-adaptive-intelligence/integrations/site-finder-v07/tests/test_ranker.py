"""Tests for app/ranker.py heuristic scoring (no network calls — tests heuristic_score directly)."""
from app.ranker import heuristic_score


def test_scam_keywords_increase_score():
    html = "<p>Guaranteed profit! Daily ROI up to 5%. Double your money fast.</p>"
    score, reasons = heuristic_score("http://normal-tld.com", html)
    assert score > 0
    assert any("guaranteed profit" in r for r in reasons)


def test_clean_looking_page_scores_low():
    html = "<html><body><h1>Welcome to Our Blog</h1><p>" + "This is a normal article about gardening tips. " * 20 + "</p></body></html>"
    score, reasons = heuristic_score("http://normal-blog.com", html)
    assert score < 2.0


def test_suspicious_tld_adds_score():
    html = "<p>Some perfectly normal-sounding text with no scam keywords at all here.</p>"
    score_top, _ = heuristic_score("http://something.top", html)
    score_com, _ = heuristic_score("http://something.com", html)
    assert score_top > score_com


def test_wallet_address_on_homepage_boosts_score():
    html_with_wallet = "<p>Deposit to 0x71C7656EC7ab88b098defB751B7401B5f6d8976a</p>"
    html_without = "<p>No wallet address mentioned here at all in this text.</p>"
    score_with, reasons_with = heuristic_score("http://site.com", html_with_wallet)
    score_without, _ = heuristic_score("http://site.com", html_without)
    assert score_with > score_without
    assert any("wallet_address_present" in r for r in reasons_with)


def test_thin_content_flagged():
    score, reasons = heuristic_score("http://site.com", "hi")
    assert any("thin_content" in r for r in reasons)


def test_telegram_only_support_flagged():
    html = "<p>Contact us on telegram for customer service support.</p>"
    score, reasons = heuristic_score("http://site.com", html)
    assert any("telegram_only_support" in r for r in reasons)


def test_discovery_confidence_bonus_applied_for_high_confidence_finds():
    from app.ranker import _discovery_confidence_bonus
    high_confidence_site = {"discovery_confidence": 0.9, "discovery_category": "brand_impersonation"}
    bonus, reason = _discovery_confidence_bonus(high_confidence_site)
    assert bonus > 0
    assert "0.90" in reason
    assert "brand_impersonation" in reason


def test_discovery_confidence_bonus_zero_for_neutral_default():
    from app.ranker import _discovery_confidence_bonus
    neutral_site = {"discovery_confidence": 0.5, "discovery_category": ""}
    bonus, reason = _discovery_confidence_bonus(neutral_site)
    assert bonus == 0.0
    assert reason == ""


def test_discovery_confidence_bonus_zero_when_missing():
    from app.ranker import _discovery_confidence_bonus
    manual_site = {}  # e.g. a manually-added URL with no discovery metadata at all
    bonus, reason = _discovery_confidence_bonus(manual_site)
    assert bonus == 0.0
    assert reason == ""
