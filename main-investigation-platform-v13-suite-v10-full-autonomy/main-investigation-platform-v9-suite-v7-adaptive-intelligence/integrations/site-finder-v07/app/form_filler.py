"""
Fills the ScamBusters-style Google Form with an approved finding's data.

CRITICAL SAFETY PROPERTY: this module NEVER clicks the final "Submit" button.
It fills every page it can, advances through "Next" buttons (which just paginate
the form locally and don't submit anything), and then stops on the last page.
The browser window is left open (when headless=False, which is the default for
this specific action) so the human can visually verify what's about to be sent
before clicking Submit themselves — OR, if running headless, it returns control
back with a screenshot of the final unsubmitted page for review.

Because Google Forms' later pages (the wallet-entry pages) only render after
the "Yes/No" branch on page 1 is answered — i.e. their structure isn't visible
from a plain page fetch — this module can't hardcode field IDs for those pages
with certainty. Instead it:
  1. Takes a screenshot after EVERY step (not just at the end), so if something
     doesn't match on a later page, you can see exactly which step succeeded
     last and pick up from there manually.
  2. Tracks which fields it actually confirmed filling vs. which it couldn't
     find, and reports that honestly rather than claiming success optimistically.
  3. Never assumes a "Next" click was safe to send without confirming a next-page
     marker actually changed — if the page didn't advance, it stops there rather
     than blindly trying to fill wallet fields into the wrong page.

There is a separate, clearly-named submitted-tracking flow in the review UI
(confirm_manual_submit) that only records what the user tells us, in the UI,
they personally did. This module does not and cannot submit on your behalf.
"""
import logging
import time

from playwright.sync_api import sync_playwright

from app.config import (
    GOOGLE_FORM_URL, FORM_USERNAME, FORM_TEAM_INVITE_CODE, FORM_NETWORK_LABELS,
    USER_AGENT, SCREENSHOT_DIR,
)

logger = logging.getLogger("scamhunter.form_filler")


def _click_next(page) -> bool:
    """Clicks Next and confirms the page actually changed before reporting success."""
    btn = page.get_by_role("button", name="Next")
    if btn.count() == 0:
        return False
    before_html_len = len(page.content())
    btn.first.click()
    time.sleep(1.2)
    after_html_len = len(page.content())
    # A real page transition changes the DOM meaningfully; a no-op click (e.g. the
    # button was disabled, or a validation error blocked it) usually won't.
    return abs(after_html_len - before_html_len) > 20


def _fill_text_question(page, question_substring: str, value: str) -> bool:
    """Finds a form question block by its visible text and fills the nearest text input."""
    blocks = page.locator("div[role='listitem']")
    count = blocks.count()
    for i in range(count):
        block = blocks.nth(i)
        text = block.inner_text()
        if question_substring.lower() in text.lower():
            input_el = block.locator("input[type='text'], textarea")
            if input_el.count() > 0:
                input_el.first.fill(value)
                return True
    return False


def _select_radio(page, question_substring: str, option_text: str) -> bool:
    blocks = page.locator("div[role='listitem']")
    count = blocks.count()
    for i in range(count):
        block = blocks.nth(i)
        text = block.inner_text()
        if question_substring.lower() in text.lower():
            option = block.locator(f"div[role='radio'][aria-label='{option_text}']")
            if option.count() == 0:
                option = block.get_by_text(option_text, exact=True)
            if option.count() > 0:
                option.first.click()
                return True
    return False


def _select_dropdown_or_radio_for_network(page, network_label: str) -> bool:
    """Wallet-type selector — could be a dropdown or radio group depending on form revision."""
    listbox = page.locator("div[role='listbox']")
    if listbox.count() > 0:
        listbox.first.click()
        time.sleep(0.3)
        option = page.get_by_role("option", name=network_label)
        if option.count() > 0:
            option.first.click()
            return True
    radio = page.get_by_text(network_label, exact=True)
    if radio.count() > 0:
        radio.first.click()
        return True
    return False


def _screenshot(page, finding_id, step_name: str) -> str:
    path = SCREENSHOT_DIR / f"form_finding{finding_id}_{step_name}_{int(time.time())}.png"
    try:
        page.screenshot(path=str(path), full_page=True)
        return str(path)
    except Exception as e:
        logger.warning("Screenshot failed at step %s: %s", step_name, e)
        return ""


def prepare_form_for_review(finding: dict, wallets: list[dict], headless: bool = False) -> dict:
    """
    Fills the form up to (but never including) final submission.

    Returns a dict with:
      - status: "ready_for_manual_submit" | "partial" | "not_configured" | "error"
      - steps: list of {"step": name, "ok": bool, "screenshot": path} for every
        attempted action, so you can see exactly what worked
      - screenshot: path to the final-state screenshot
      - note: human-readable summary

    Set headless=False (default) so a real browser window stays open for the user
    to review and personally click Submit.
    """
    if not FORM_USERNAME or not FORM_TEAM_INVITE_CODE:
        return {
            "status": "not_configured",
            "steps": [],
            "note": "Set SCAMBUSTERS_USERNAME and SCAMBUSTERS_TEAM_CODE env vars first "
                    "(get these from the project's Discord via /username and /team).",
        }

    supported_wallets = [w for w in wallets if w["network"] in FORM_NETWORK_LABELS]
    unsupported_wallets = [w for w in wallets if w["network"] not in FORM_NETWORK_LABELS]
    steps = []

    def record(step_name, ok):
        shot = _screenshot(page, finding["id"], step_name)
        steps.append({"step": step_name, "ok": ok, "screenshot": shot})
        if not ok:
            logger.warning("Form step did not complete as expected: %s", step_name)

    pw = sync_playwright().start()
    browser = pw.chromium.launch(headless=headless)
    context = browser.new_context(user_agent=USER_AGENT)
    page = context.new_page()

    try:
        page.goto(GOOGLE_FORM_URL, wait_until="domcontentloaded")
        time.sleep(1)
        record("page_loaded", True)

        record("fill_username", _fill_text_question(page, "Username", FORM_USERNAME))
        record("fill_team_code", _fill_text_question(page, "Team Invite Code", FORM_TEAM_INVITE_CODE))
        record("fill_site_url", _fill_text_question(
            page, "URL for the Crypto Investment Site", finding["site_url"]))
        record("select_has_wallets", _select_radio(
            page, "Do you have cryptocurrency deposit addresses",
            "Yes" if supported_wallets else "No",
        ))

        advanced = _click_next(page)
        record("advance_to_page_2", advanced)

        wallet_steps_ok = True
        if advanced and supported_wallets:
            for idx, w in enumerate(supported_wallets):
                label = FORM_NETWORK_LABELS[w["network"]]
                sel_ok = _select_dropdown_or_radio_for_network(page, label)
                fill_ok = (_fill_text_question(page, "wallet address", w["address"])
                           or _fill_text_question(page, "Wallet Address", w["address"]))
                record(f"wallet_{idx}_{w['network']}", sel_ok and fill_ok)
                wallet_steps_ok = wallet_steps_ok and sel_ok and fill_ok
        elif not advanced and supported_wallets:
            # We have wallets to submit but couldn't confirm the page advanced —
            # don't guess at filling fields on a page we're not sure loaded correctly.
            wallet_steps_ok = False

        final_screenshot = _screenshot(page, finding["id"], "final_state")

        failed_steps = [s["step"] for s in steps if not s["ok"]]
        if not failed_steps:
            status = "ready_for_manual_submit"
            note = (
                "Every field the automation attempted was filled and confirmed. "
                "Please still review the form yourself before submitting — "
                "automation can match the wrong field if the form has changed."
            )
        else:
            status = "partial"
            note = (
                f"Some steps could not be confirmed: {', '.join(failed_steps)}. "
                "Check the per-step screenshots to see exactly where automation "
                "stopped matching the form, and fill the remaining fields by hand."
            )

        if unsupported_wallets:
            note += (
                f" Note: {len(unsupported_wallets)} wallet(s) found "
                f"({', '.join(w['network'] for w in unsupported_wallets)}) don't have a "
                "matching option on this form and were not submitted — they're still "
                "recorded in ScamHunter's local evidence."
            )

        if not headless:
            note += " The browser window has been left open for you to finish and submit."
        else:
            browser.close()
            pw.stop()

        return {
            "status": status,
            "steps": steps,
            "screenshot": final_screenshot,
            "note": note,
        }

    except Exception as e:
        logger.error("Form fill error: %s", e)
        error_screenshot = _screenshot(page, finding["id"], "error_state")
        if headless:
            browser.close()
            pw.stop()
        return {
            "status": "error",
            "steps": steps,
            "detail": str(e),
            "screenshot": error_screenshot,
            "note": "Automated fill hit an unexpected error partway through. Check the "
                    "per-step screenshots to see how far it got, then fill the rest "
                    "manually using the finding details shown in the review screen.",
        }
