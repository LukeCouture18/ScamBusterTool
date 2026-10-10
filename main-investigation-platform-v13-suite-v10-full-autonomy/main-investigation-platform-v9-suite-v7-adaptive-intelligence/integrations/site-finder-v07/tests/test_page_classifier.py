"""Tests for app/investigate/page_classifier.py."""
from app.investigate.page_classifier import (
    classify_page_keyword, filter_interesting_links, filter_wallet_priority_links,
)


def test_classifies_deposit_page():
    assert classify_page_keyword("http://site.test/deposit", "Deposit Funds", "") == "deposit"
    assert classify_page_keyword("http://site.test/recharge", "Recharge", "") == "deposit"


def test_classifies_wallet_page():
    assert classify_page_keyword("http://site.test/wallet", "My Wallet", "") == "wallet"


def test_classifies_investment_page():
    assert classify_page_keyword("http://site.test/plans", "Investment Plans", "") == "investment"


def test_classifies_login_page():
    assert classify_page_keyword("http://site.test/login", "Sign In", "") == "login"


def test_unrecognized_page_is_other():
    assert classify_page_keyword("http://site.test/about", "About Us", "just a company") == "other"


def test_nav_bar_text_does_not_leak_into_classification():
    """
    Regression test for a real bug: a homepage (or any page) whose shared nav
    bar happens to mention "Deposit"/"Wallet"/etc. must NOT be classified as
    that page type just because the word appears in the page's body text.
    Classification must come from URL/title, which are specific to this page.
    """
    homepage_body_with_nav = (
        "Home Deposit Wallet Investment Plans Login Sign Up Withdraw "
        "Welcome to our platform. Guaranteed daily returns!"
    )
    result = classify_page_keyword("http://site.test/", "Welcome", homepage_body_with_nav)
    assert result == "other"


def test_classifies_trading_page():
    assert classify_page_keyword("http://site.test/trading", "Live Trading", "") == "trading"


def test_filter_interesting_links_ranks_by_keyword_hits():
    links = [
        {"text": "About Us", "href": "http://site.test/about"},
        {"text": "Deposit Now", "href": "http://site.test/deposit"},
        {"text": "Wallet Balance Fund Investment", "href": "http://site.test/multi"},
        {"text": "Contact", "href": "http://site.test/contact"},
    ]
    filtered = filter_interesting_links(links)
    # The multi-keyword link should rank first; irrelevant links should be excluded
    assert filtered[0]["href"] == "http://site.test/multi"
    hrefs = [l["href"] for l in filtered]
    assert "http://site.test/about" not in hrefs
    assert "http://site.test/contact" not in hrefs


def test_filter_interesting_links_respects_max_links():
    links = [{"text": "deposit", "href": f"http://site.test/{i}"} for i in range(30)]
    filtered = filter_interesting_links(links, max_links=5)
    assert len(filtered) == 5


def test_filter_wallet_priority_links_prefers_deposit_specific_terms():
    links = [
        {"text": "Investment Plans", "href": "http://site.test/plans"},
        {"text": "Deposit USDT (TRC20)", "href": "http://site.test/deposit"},
        {"text": "About Us", "href": "http://site.test/about"},
    ]
    filtered = filter_wallet_priority_links(links)
    hrefs = [l["href"] for l in filtered]
    # "Deposit USDT (TRC20)" hits multiple wallet-priority words (deposit, usdt, trc20)
    # and should rank above a merely finance-adjacent "Investment Plans" link.
    assert hrefs[0] == "http://site.test/deposit"
    assert "http://site.test/about" not in hrefs


def test_filter_wallet_priority_links_respects_max_links():
    links = [{"text": "recharge", "href": f"http://site.test/{i}"} for i in range(30)]
    filtered = filter_wallet_priority_links(links, max_links=4)
    assert len(filtered) == 4


def test_filter_wallet_priority_links_empty_when_nothing_matches():
    links = [{"text": "About Us", "href": "http://site.test/about"},
             {"text": "Contact", "href": "http://site.test/contact"}]
    assert filter_wallet_priority_links(links) == []
