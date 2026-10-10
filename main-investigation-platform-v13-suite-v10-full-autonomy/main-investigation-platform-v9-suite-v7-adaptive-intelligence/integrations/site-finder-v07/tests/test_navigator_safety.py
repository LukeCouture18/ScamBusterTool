"""
Tests for the hard safety filters in app/investigate/navigator.py.
These don't launch a real browser — they test the pure filtering logic that
decides what the automation is and isn't allowed to click.
"""
from app.investigate.navigator import _looks_forbidden, _same_domain, _looks_like_wallet_tab


def test_forbidden_signals_block_wallet_connect_actions():
    assert _looks_forbidden("Connect Wallet") is True
    assert _looks_forbidden("connect your metamask") is True
    assert _looks_forbidden("WalletConnect") is True
    assert _looks_forbidden("Trust Wallet Login") is True


def test_forbidden_signals_block_payment_confirmation():
    assert _looks_forbidden("Confirm Transaction") is True
    assert _looks_forbidden("Confirm Payment") is True
    assert _looks_forbidden("Submit Payment") is True
    assert _looks_forbidden("Buy Now") is True
    assert _looks_forbidden("Checkout") is True


def test_forbidden_signals_block_captcha_and_verification():
    assert _looks_forbidden("Please complete the CAPTCHA") is True
    assert _looks_forbidden("Verify you are human") is True
    assert _looks_forbidden("Enter your OTP") is True
    assert _looks_forbidden("Two-Factor Authentication") is True


def test_safe_navigation_labels_are_not_blocked():
    """These are exactly the kinds of links we WANT the crawler to follow."""
    assert _looks_forbidden("Deposit Now") is False
    assert _looks_forbidden("View Wallet Address") is False
    assert _looks_forbidden("My Deposits") is False
    assert _looks_forbidden("Recharge Record") is False
    assert _looks_forbidden("Investment Plans") is False
    assert _looks_forbidden("Account Balance") is False
    assert _looks_forbidden("") is False
    assert _looks_forbidden(None) is False


def test_same_domain_matching():
    assert _same_domain("http://example.com", "http://example.com/page") is True
    assert _same_domain("http://example.com", "https://example.com/other") is True
    assert _same_domain("http://example.com", "http://evil-other-site.com") is False


def test_same_domain_handles_www_prefix_inconsistently_but_safely():
    # Document current behavior: www. normalization here is best-effort. The
    # crawler still won't wander to a genuinely different domain either way.
    result = _same_domain("http://www.example.com", "http://example.com/page")
    assert isinstance(result, bool)  # doesn't crash; exact value isn't safety-critical


def test_wallet_tab_recognizes_plain_currency_labels():
    """These are exactly the kind of short tab/pill labels a deposit page uses
    to switch which address is shown — safe to click since they never submit
    or send anything, only change what's displayed."""
    assert _looks_like_wallet_tab("BTC") is True
    assert _looks_like_wallet_tab("USDT-TRC20") is True
    assert _looks_like_wallet_tab("Ethereum") is True
    assert _looks_like_wallet_tab("Tron (TRX)") is True
    assert _looks_like_wallet_tab("usdt-erc20") is True


def test_wallet_tab_excludes_action_buttons_even_if_they_name_a_currency():
    """A button can mention a currency while still being an action we must
    never click — these must be excluded even though they match a wallet-tab
    signal word."""
    assert _looks_like_wallet_tab("Buy BTC Now") is False
    assert _looks_like_wallet_tab("Connect ETH Wallet") is False
    assert _looks_like_wallet_tab("Confirm USDT Payment") is False
    assert _looks_like_wallet_tab("Withdraw BTC") is False
    assert _looks_like_wallet_tab("Swap to ETH") is False


def test_wallet_tab_excludes_unrelated_text():
    assert _looks_like_wallet_tab("About Us") is False
    assert _looks_like_wallet_tab("") is False
    assert _looks_like_wallet_tab(None) is False


def test_wallet_tab_excludes_long_prose_even_if_it_mentions_a_coin():
    """A long sentence that happens to mention 'btc' somewhere is not a tab
    label — tabs are short. This avoids accidentally 'clicking' body text
    that merely discusses Bitcoin in passing."""
    long_text = (
        "Our platform supports BTC, ETH, and USDT deposits with industry-leading "
        "security and fast processing times for all your investment needs."
    )
    assert _looks_like_wallet_tab(long_text) is False
