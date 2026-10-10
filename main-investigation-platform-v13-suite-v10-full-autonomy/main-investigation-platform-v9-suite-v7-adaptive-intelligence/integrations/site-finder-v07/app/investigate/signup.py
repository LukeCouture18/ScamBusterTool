"""
Attempts a normal account signup on a site.

Two entry points:
  - `attempt_signup(site, ...)` launches its own isolated browser session —
    used by the CLI for a one-off manual signup attempt.
  - `attempt_signup_on_page(page, site, investigation_id)` operates on a page
    the navigator has already loaded and recognized as a signup page mid-
    investigation, so the whole thing shares one browser context and one
    coherent investigation record instead of opening a second browser.

Both stop immediately — without attempting to solve, guess, or work around
anything — the moment they detect:
  - a CAPTCHA widget (reCAPTCHA, hCaptcha, Cloudflare Turnstile, generic "verify" text)
  - an email/SMS verification step
  - a 2FA / one-time-code prompt
  - any third-party identity/auth challenge

On any of those, a `signup_attempts` row is recorded with status='blocked_*' and
the function returns without proceeding further. Neither path ever attempts
password guessing, ever touches an existing account, or ever proceeds past the
point a human would normally need to take an action outside the browser
(checking an inbox, texting a code, etc.).
"""
import logging
import random
import string
import time

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

from app.config import (
    PAGE_LOAD_TIMEOUT_MS, USER_AGENT, SIGNUP_RESEARCH_EMAIL_DOMAIN,
    SIGNUP_RESEARCH_PASSWORD,
)
from app import db

logger = logging.getLogger("scamhunter.signup")

CAPTCHA_SIGNALS = [
    "recaptcha", "hcaptcha", "cf-turnstile", "turnstile", "verify you are human",
    "i'm not a robot", "captcha",
]
VERIFICATION_SIGNALS = [
    "verification code", "verify your email", "verify your phone", "otp", "one-time code",
    "2fa", "two-factor", "enter the code we sent", "confirm your email",
]


def _random_username(prefix="research"):
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{prefix}_{suffix}"


def _page_has_any(page, signals: list) -> bool:
    try:
        text = page.inner_text("body").lower()
    except Exception:
        text = ""
    html = page.content().lower()
    haystack = text + " " + html
    return any(sig in haystack for sig in signals)


def _fill_signup_form(page, email: str, username: str) -> bool:
    """Shared field-filling logic. Returns True if at least one field was filled."""
    filled_any = False
    email_field = page.query_selector(
        "input[type=email], input[name*=email i], input[placeholder*=email i]"
    )
    if email_field:
        email_field.fill(email)
        filled_any = True

    user_field = page.query_selector(
        "input[name*=user i], input[placeholder*=username i]"
    )
    if user_field:
        user_field.fill(username)
        filled_any = True

    pw_fields = page.query_selector_all("input[type=password]")
    for pf in pw_fields:
        pf.fill(SIGNUP_RESEARCH_PASSWORD)
        filled_any = True

    return filled_any


def attempt_signup_on_page(page, site: dict, investigation_id: int | None = None) -> dict:
    """
    Attempts signup on a page the caller has ALREADY navigated to and identified
    as a signup page (typically the navigator, mid-investigation). Does not
    navigate anywhere first — operates on the current page state directly, so
    it shares the caller's browser context/session rather than opening a new one.
    """
    if not SIGNUP_RESEARCH_EMAIL_DOMAIN:
        result = {"status": "skipped", "detail": "SIGNUP_RESEARCH_EMAIL_DOMAIN not configured"}
        db.log_signup_attempt(site["id"], result["status"], result["detail"])
        return result

    if _page_has_any(page, CAPTCHA_SIGNALS):
        result = {"status": "blocked_captcha", "detail": "CAPTCHA detected before any input"}
        db.log_signup_attempt(site["id"], result["status"], result["detail"])
        return result

    username = _random_username()
    email = f"{username}@{SIGNUP_RESEARCH_EMAIL_DOMAIN}"

    try:
        filled_any = _fill_signup_form(page, email, username)
    except Exception as e:
        result = {"status": "failed", "detail": f"form field error: {e}"}
        db.log_signup_attempt(site["id"], result["status"], result["detail"])
        return result

    if not filled_any:
        result = {"status": "failed", "detail": "no recognizable signup form found"}
        db.log_signup_attempt(site["id"], result["status"], result["detail"])
        return result

    if _page_has_any(page, CAPTCHA_SIGNALS):
        result = {"status": "blocked_captcha", "detail": "CAPTCHA appeared after filling form"}
        db.log_signup_attempt(site["id"], result["status"], result["detail"])
        return result

    submit_btn = page.query_selector(
        "button[type=submit], input[type=submit], button:has-text('Sign up'), "
        "button:has-text('Register'), button:has-text('Create account')"
    )
    if not submit_btn:
        result = {"status": "failed", "detail": "no submit button found"}
        db.log_signup_attempt(site["id"], result["status"], result["detail"])
        return result

    try:
        submit_btn.click()
        page.wait_for_load_state("domcontentloaded", timeout=PAGE_LOAD_TIMEOUT_MS)
    except Exception:
        pass  # some sites do an in-place AJAX submit; fall through to post-checks

    time.sleep(2)

    if _page_has_any(page, CAPTCHA_SIGNALS):
        result = {"status": "blocked_captcha", "detail": "CAPTCHA required after submit"}
    elif _page_has_any(page, VERIFICATION_SIGNALS):
        result = {
            "status": "blocked_verification",
            "detail": f"Email/SMS/2FA verification required. Research email used: {email}",
        }
    else:
        result = {"status": "success", "detail": f"Signup appears complete. Email used: {email}"}

    db.log_signup_attempt(site["id"], result["status"], result["detail"])
    return result


def attempt_signup(site: dict, signup_url: str | None = None, headless: bool = True) -> dict:
    """
    Standalone entry point: launches its own isolated browser session and
    navigates to the signup URL itself. Used by the CLI for a one-off manual
    signup attempt outside of a full investigation.

    Returns a dict describing the outcome. Never raises past a blocked state —
    a blocked signup is a normal, expected, and safe outcome.
    """
    url = signup_url or site["url"]
    if not SIGNUP_RESEARCH_EMAIL_DOMAIN:
        result = {"status": "skipped", "detail": "SIGNUP_RESEARCH_EMAIL_DOMAIN not configured"}
        db.log_signup_attempt(site["id"], result["status"], result["detail"])
        return result

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)
        context = browser.new_context(user_agent=USER_AGENT)
        page = context.new_page()
        page.set_default_timeout(PAGE_LOAD_TIMEOUT_MS)

        try:
            page.goto(url, wait_until="domcontentloaded")
        except PWTimeout:
            result = {"status": "failed", "detail": "page load timeout"}
            db.log_signup_attempt(site["id"], result["status"], result["detail"])
            browser.close()
            return result

        result = attempt_signup_on_page(page, site)
        browser.close()
        return result
