"""
Tests for app/analysis/triage.py — the quality gate.

The single most important property here is that a site must trip MULTIPLE
INDEPENDENT indicator categories to pass. A site that repeats one keyword a
hundred times must not pass, because that's exactly the "hundreds of weak
results" failure mode the gate exists to prevent.
"""
from app.analysis.triage import evaluate_indicators, score_indicators, CATEGORY_WEIGHTS
from app.config import TRIAGE_MIN_INDICATOR_CATEGORIES, TRIAGE_MIN_SCORE


def _passes(url, domain, html):
    indicators = evaluate_indicators(url, domain, html)
    score, count = score_indicators(indicators)
    return count >= TRIAGE_MIN_INDICATOR_CATEGORIES and score >= TRIAGE_MIN_SCORE


STRONG_SITE = """<html><body>
<h1>CryptoGrow VIP</h1>
<p>Guaranteed 5% daily returns on your investment! Risk-free.</p>
<p>VIP Level 3 plan with referral bonus. Minimum deposit 100 USDT.</p>
<p>Deposit Address: TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9</p>
<p>Support only via Telegram: t.me/cryptogrow</p>
<p>Limited time offer - act now! 100% safe and fully insured.</p>
</body></html>"""


def test_keyword_spam_alone_does_not_pass():
    """The core quality guarantee: repeating one word many times proves nothing."""
    html = "<html><body>" + ("investment " * 200) + "</body></html>"
    assert _passes("http://x.com", "x.com", html) is False


def test_single_loud_category_does_not_pass():
    """One category firing loudly is still only one kind of evidence."""
    html = "<html><body>Guaranteed profit! Guaranteed returns! Daily profit guaranteed!</body></html>"
    indicators = evaluate_indicators("http://y.com", "y.com", html)
    categories = {i["category"] for i in indicators}
    assert len(categories) == 1
    assert _passes("http://y.com", "y.com", html) is False


def test_multi_indicator_site_passes():
    assert _passes("http://cryptogrow.top", "cryptogrow.top", STRONG_SITE) is True


def test_wallet_address_is_detected_as_its_own_category():
    indicators = evaluate_indicators("http://a.com", "a.com", STRONG_SITE)
    assert any(i["category"] == "wallet_address" for i in indicators)


def test_brand_impersonation_detected_on_lookalike_domain():
    html = "<html><body><h1>Binance Support</h1><p>Deposit to restore access.</p></body></html>"
    indicators = evaluate_indicators("http://binance-support.top", "binance-support.top", html)
    assert any(i["category"] == "brand_impersonation" for i in indicators)


def test_real_brand_domain_is_not_flagged_as_impersonation():
    """The genuine binance.com must never be flagged as impersonating itself."""
    html = "<html><body><h1>Binance</h1></body></html>"
    indicators = evaluate_indicators("https://binance.com", "binance.com", html)
    assert not any(i["category"] == "brand_impersonation" for i in indicators)


def test_score_counts_each_category_once():
    """Score is per-category, so keyword repetition cannot inflate it."""
    single = evaluate_indicators("http://a.com", "a.com",
                                  "<html><body>guaranteed profit</body></html>")
    repeated = evaluate_indicators("http://a.com", "a.com",
                                    "<html><body>" + ("guaranteed profit " * 50) + "</body></html>")
    assert score_indicators(single)[0] == score_indicators(repeated)[0]


def test_suspicious_tld_fires_only_for_listed_tlds():
    html = "<html><body>nothing special</body></html>"
    sus = evaluate_indicators("http://a.top", "a.top", html)
    normal = evaluate_indicators("http://a.com", "a.com", html)
    assert any(i["category"] == "suspicious_tld" for i in sus)
    assert not any(i["category"] == "suspicious_tld" for i in normal)


def test_every_category_has_a_weight():
    """Guards against a typo'd category name silently scoring as the default."""
    indicators = evaluate_indicators("http://cryptogrow.top", "cryptogrow.top", STRONG_SITE)
    for indicator in indicators:
        assert indicator["category"] in CATEGORY_WEIGHTS


def test_indicators_carry_human_readable_detail():
    """Every fired indicator must explain itself — this is what a reviewer reads."""
    indicators = evaluate_indicators("http://cryptogrow.top", "cryptogrow.top", STRONG_SITE)
    assert indicators
    for indicator in indicators:
        assert indicator["detail"] and len(indicator["detail"]) > 5
