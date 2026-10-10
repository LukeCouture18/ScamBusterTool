"""Tests for app/investigate/page_understanding.py — the access-control and
login/signup detection that governs when the investigator must stop."""
from app.investigate.page_understanding import (
    detect_access_control, detect_login_or_signup, understand_page,
)


def test_detects_captcha():
    ctrl, sig = detect_access_control("Verify", "Please complete the CAPTCHA to continue", "")
    assert ctrl == "captcha"


def test_detects_kyc():
    ctrl, sig = detect_access_control(
        "Identity Check", "Please upload your ID and complete identity verification", "")
    assert ctrl == "kyc"


def test_detects_phone_verification():
    ctrl, sig = detect_access_control("Verify Phone", "Enter the SMS verification code we sent you", "")
    assert ctrl == "phone_verification"


def test_detects_payment_requirement():
    ctrl, sig = detect_access_control("Withdraw", "You must pay an activation fee to unlock withdrawal", "")
    assert ctrl == "payment_required"


def test_normal_page_has_no_access_control():
    ctrl, sig = detect_access_control("Home", "Welcome to our investment platform", "")
    assert ctrl is None
    assert sig == ""


def test_access_control_detected_from_html_when_text_is_empty():
    """CAPTCHA widgets (e.g. reCAPTCHA iframes) often show no visible text at all —
    detection must still catch them via the raw HTML."""
    ctrl, sig = detect_access_control("Verify", "", "<div class='g-recaptcha' data-sitekey='x'></div>")
    assert ctrl == "captcha"


def test_login_page_detected():
    is_login, is_signup = detect_login_or_signup("http://site.com/login", "Login", "Enter your credentials")
    assert is_login is True
    assert is_signup is False


def test_signup_page_detected():
    is_login, is_signup = detect_login_or_signup(
        "http://site.com/register", "Create an Account", "Sign up to get started")
    assert is_signup is True
    assert is_login is False


def test_normal_page_not_flagged_as_auth():
    is_login, is_signup = detect_login_or_signup("http://site.com/about", "About Us", "We are a company")
    assert is_login is False
    assert is_signup is False


def test_combined_login_signup_toggle_page():
    """Some sites show 'Log In / Sign Up' on the same page — both flags can be true."""
    is_login, is_signup = detect_login_or_signup(
        "http://site.com/auth", "Login or Sign Up", "Log in or create an account")
    assert is_login is True
    assert is_signup is True


def test_understand_page_stops_at_access_control_before_reporting_auth():
    """If a page is BOTH a login page AND shows a CAPTCHA, access_control must still
    be set — the navigator checks access_control first and stops regardless."""
    pu = understand_page(
        "http://site.com/login", "Login", "Please complete the CAPTCHA to log in", "<html></html>", [],
    )
    assert pu.access_control == "captcha"
    assert pu.is_login_page is True


def test_understand_page_normal_content():
    pu = understand_page(
        "http://site.com/deposit", "Deposit", "Send USDT to the address below", "<html></html>",
        [{"text": "Home", "href": "http://site.com"}],
    )
    assert pu.access_control is None
    assert pu.is_login_page is False
    assert pu.is_signup_page is False
    assert pu.links == [{"text": "Home", "href": "http://site.com"}]


def test_homepage_with_signup_nav_link_is_not_misclassified_as_signup_page():
    """
    Regression test for a real bug: a homepage whose navigation bar merely
    contains a 'Sign Up' link (true of nearly every real site, scam or not)
    must NOT be classified as a signup page itself just because that text
    appears somewhere in the page's visible text. Recognition should require
    a page-level signal (URL path, title) or actual form fields, not just any
    mention of "sign up" anywhere on the page.
    """
    homepage_text = (
        "Home | Deposit | Wallet | Investment Plans | Login | Sign Up | Withdraw\n"
        "Welcome to CryptoGrow. Guaranteed daily returns on your investment!"
    )
    is_login, is_signup = detect_login_or_signup("http://site.com/", "CryptoGrow Investments", homepage_text)
    assert is_login is False
    assert is_signup is False


def test_body_signal_alone_without_password_field_is_not_enough():
    """A page that merely mentions 'create an account' in passing prose, with no
    actual password field present, should not be flagged as a signup page."""
    is_login, is_signup = detect_login_or_signup(
        "http://site.com/faq", "FAQ",
        "Why can't I withdraw? You may need to create an account first.",
        has_password_field=False,
    )
    assert is_signup is False


def test_body_signal_with_password_field_is_recognized():
    """A page with ambiguous URL/title but a real password field AND signup
    language in the body IS treated as a signup page — this is the legitimate
    case the has_password_field fallback exists for (e.g. a signup form embedded
    at a non-obvious URL like /account/new-user)."""
    is_login, is_signup = detect_login_or_signup(
        "http://site.com/account/step2", "Almost there",
        "Create an account to continue. Choose a password below.",
        has_password_field=True,
    )
    assert is_signup is True


def test_url_path_signal_alone_is_sufficient():
    """A clean /login or /signup URL is treated as an auth page even with a
    generic title and body, since the path itself is a strong signal."""
    is_login, _ = detect_login_or_signup("http://site.com/login", "Untitled", "")
    assert is_login is True

    _, is_signup = detect_login_or_signup("http://site.com/signup", "Untitled", "")
    assert is_signup is True


def test_login_page_not_also_flagged_as_signup_due_to_nav_mentioning_signup():
    """
    Regression test for a real bug: a genuine /login page, whose shared nav
    bar happens to also link to '/signup' (true of virtually every real site),
    must be classified as ONLY a login page — not also flagged as a signup
    page just because "sign up" appears somewhere in the page's body text
    from that shared nav. URL/title signals for login must take priority and
    suppress the nav-polluted body-text signup match entirely.
    """
    body_with_nav_and_login_form = (
        "Home Deposit Wallet Investment Plans Login Sign Up External Site "
        "Login to Your Account Email Password Log In"
    )
    is_login, is_signup = detect_login_or_signup(
        "http://site.com/login", "Login", body_with_nav_and_login_form, has_password_field=True,
    )
    assert is_login is True
    assert is_signup is False
