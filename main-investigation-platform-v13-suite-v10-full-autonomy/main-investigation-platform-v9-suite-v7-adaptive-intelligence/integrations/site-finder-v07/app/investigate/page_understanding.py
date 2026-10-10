"""
Turns a loaded Playwright page into a structured understanding the navigator
can make decisions from: what kind of page is this (login/signup/access-control/
normal content), and what are the plausible next navigation actions available.

Kept separate from navigator.py so the "what is this page" logic can be unit
tested without a real browser (see tests/test_page_understanding.py), and so
the access-control detection — the single most safety-critical piece of this
whole system — lives in one obviously-named place.
"""
from dataclasses import dataclass, field

from app.config import ACCESS_CONTROL_SIGNAL_GROUPS, LOGIN_PAGE_SIGNALS, SIGNUP_PAGE_SIGNALS


@dataclass
class PageUnderstanding:
    url: str
    title: str
    text_sample: str          # truncated visible text, for logging/Claude prompts
    is_login_page: bool = False
    is_signup_page: bool = False
    access_control: str | None = None   # None, or one of: captcha, kyc, phone_verification, payment_required
    access_control_detail: str = ""
    links: list = field(default_factory=list)   # [{"text": ..., "href": ...}]


def _haystack(title: str, text: str, extra: str = "") -> str:
    return f"{title} {text[:4000]} {extra}".lower()


def detect_access_control(title: str, text: str, html_lower: str = "") -> tuple:
    """
    Returns (control_type, matched_signal) or (None, "") if no access-control
    wall is detected. Checked against visible text AND raw HTML (lowercased)
    since some widgets — CAPTCHA iframes especially — inject little or no
    visible text but do leave fingerprints in the markup (e.g. a
    'g-recaptcha' class or a Cloudflare Turnstile script tag).
    """
    combined = _haystack(title, text, html_lower)
    for control_type, signals in ACCESS_CONTROL_SIGNAL_GROUPS.items():
        for sig in signals:
            if sig in combined:
                return control_type, sig
    return None, ""


def detect_login_or_signup(url: str, title: str, text: str, has_password_field: bool = False) -> tuple:
    """
    Heuristic login/signup PAGE recognition — distinct from a page merely
    *containing a link* to login/signup (e.g. a "Sign Up" nav item present on
    every page of the site, which must NOT make every page count as a signup
    page, and must not make an actual /login page ALSO count as signup just
    because its shared nav happens to mention "Sign Up").

    Priority order:
      1. A strong signal in the URL path or page title (e.g. /login, /signup,
         "Sign In", "Create an Account" as the title) decides the category
         outright — this is specific to the page itself and is trusted over
         anything found in the body text, since body text commonly includes
         a shared nav/header that mentions both login AND signup regardless
         of which one this particular page actually is.
      2. Only when NEITHER category has a URL/title signal do we fall back to
         body text — and even then, only combined with an actual password
         input field being present, which is a much stronger page-specific
         indicator than the mere word "sign up" appearing somewhere in a nav.
    """
    from urllib.parse import urlparse
    path = urlparse(url).path.lower()
    title_lower = (title or "").lower()
    body_lower = text[:1500].lower()

    def strong_signal(signals):
        return any(sig in path or sig.replace(" ", "") in path or sig in title_lower for sig in signals)

    def body_signal(signals):
        return any(sig in body_lower for sig in signals)

    login_strong = strong_signal(LOGIN_PAGE_SIGNALS)
    signup_strong = strong_signal(SIGNUP_PAGE_SIGNALS)

    if login_strong or signup_strong:
        # At least one category has a page-specific signal: trust URL/title only,
        # and do NOT let body-text (nav-polluted) push the other flag to True too.
        return login_strong, signup_strong

    # No page-specific signal at all — fall back to body text, but only trust it
    # when there's also a password field, since a bare word match on a plain
    # content page (no form at all) is too weak to justify treating it as auth.
    if not has_password_field:
        return False, False
    return body_signal(LOGIN_PAGE_SIGNALS), body_signal(SIGNUP_PAGE_SIGNALS)
    return is_login, is_signup


def understand_page(url: str, title: str, visible_text: str, html: str, links: list,
                     has_password_field: bool = False) -> PageUnderstanding:
    """
    Pure function (no browser access) so it's fully unit-testable: given what
    the navigator already extracted from the page, decide what kind of page
    this is and whether it's safe to keep going.
    """
    control_type, matched_signal = detect_access_control(title, visible_text, html.lower())
    is_login, is_signup = detect_login_or_signup(url, title, visible_text, has_password_field)

    return PageUnderstanding(
        url=url,
        title=title,
        text_sample=visible_text[:2000],
        is_login_page=is_login,
        is_signup_page=is_signup,
        access_control=control_type,
        access_control_detail=matched_signal,
        links=links,
    )
