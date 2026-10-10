"""
Google Form submission: three modes, one hard rule.

Modes
-----
manual                : the tool does nothing automatic. You open and fill the
                        form yourself. Useful when you want full control.
review_before_submit  : the tool validates, opens the form, prefills every
                        field it can, and hands you a browser window plus a
                        per-field report so you can check the work and submit.
automatic             : the tool validates, prefills, and presents a ready
                        one-click confirmation — the fastest path, with the
                        validation results shown so approving is quick.

The hard rule
-------------
Every mode ends with a human clicking Submit. Filing a report is a real-world
action against a real third party, and an automated system that files reports
unattended can file wrong ones at scale — so the tool does all the work up to
that click and never takes the click itself. "Automatic" means the preparation
and validation are automatic, not the submission.

The validation gate
-------------------
Before any submission is prepared, these checks must pass:
  - the site exists and has a completed deep profile
  - confidence meets the minimum bar
  - at least one wallet passes checksum validation (configurable)
  - the wallet's network maps to an option the form actually accepts
  - required form fields (username, team code, URL) are all present
  - the site has not already been submitted (duplicate guard)
  - the wallet has not already been submitted (duplicate guard)
"""
import logging

from app import db
from app.config import (
    SUBMISSION_MODES, DEFAULT_SUBMISSION_MODE, SUBMISSION_MIN_CONFIDENCE,
    SUBMISSION_REQUIRE_VALID_WALLET, FORM_NETWORK_LABELS,
)

logger = logging.getLogger("scamhunter.submission")

SETTING_USERNAME = "scambusters_username"
SETTING_TEAM_CODE = "scambusters_team_code"
SETTING_MODE = "submission_mode"


# ---------------- Stored credentials ----------------

def save_submission_settings(username: str = None, team_code: str = None, mode: str = None) -> dict:
    """
    Persists the operator's form credentials once so every future submission
    reuses them without re-prompting. Stored locally in the app's own SQLite
    settings table alongside the tool's other configuration.
    """
    if username is not None:
        db.set_setting(SETTING_USERNAME, username.strip())
    if team_code is not None:
        db.set_setting(SETTING_TEAM_CODE, team_code.strip())
    if mode is not None:
        if mode not in SUBMISSION_MODES:
            raise ValueError(f"Unknown submission mode {mode!r}; expected one of {SUBMISSION_MODES}")
        db.set_setting(SETTING_MODE, mode)
    return get_submission_settings()


def get_submission_settings() -> dict:
    return {
        "username": db.get_setting(SETTING_USERNAME, "") or "",
        "team_code": db.get_setting(SETTING_TEAM_CODE, "") or "",
        "mode": db.get_setting(SETTING_MODE, DEFAULT_SUBMISSION_MODE) or DEFAULT_SUBMISSION_MODE,
        "configured": bool(db.get_setting(SETTING_USERNAME) and db.get_setting(SETTING_TEAM_CODE)),
    }


# ---------------- Validation gate ----------------

def _check(name, passed, detail):
    return {"check": name, "passed": bool(passed), "detail": detail}


def validate_for_submission(site_id: int) -> dict:
    """
    Runs every pre-submission check. Returns:
      {"passed": bool, "checks": [...], "wallet": {...} or None, "profile": {...} or None}
    Safe to call at any time — it's read-only and never submits anything.
    """
    checks = []
    settings = get_submission_settings()

    site = db.get_site(site_id)
    checks.append(_check("site_exists", bool(site),
                          "Site found in database" if site else f"No site with id {site_id}"))
    if not site:
        return {"passed": False, "checks": checks, "wallet": None, "profile": None}

    # --- credentials ---
    checks.append(_check(
        "username_configured", bool(settings["username"]),
        "Username is set" if settings["username"]
        else "Username is not set — enter it once in Settings"))
    checks.append(_check(
        "team_code_configured", bool(settings["team_code"]),
        "Team invite code is set" if settings["team_code"]
        else "Team invite code is not set — enter it once in Settings"))

    # --- site URL ---
    has_url = bool(site.get("url"))
    checks.append(_check("site_url_present", has_url,
                          f"Site URL: {site.get('url')}" if has_url else "Site has no URL"))

    # --- deep profile + confidence ---
    profile = db.get_deep_profile(site_id)
    has_profile = bool(profile and profile.get("status") == "complete")
    checks.append(_check(
        "deep_profile_complete", has_profile,
        "Deep analysis profile is complete" if has_profile
        else "No completed deep-analysis profile — run deep analysis before submitting"))

    confidence = (profile or {}).get("confidence_score") or 0
    meets_confidence = confidence >= SUBMISSION_MIN_CONFIDENCE
    checks.append(_check(
        "confidence_threshold", meets_confidence,
        f"Confidence {confidence:.0%} meets the {SUBMISSION_MIN_CONFIDENCE:.0%} minimum"
        if meets_confidence else
        f"Confidence {confidence:.0%} is below the {SUBMISSION_MIN_CONFIDENCE:.0%} minimum"))

    # --- wallet: validated, and on a network the form accepts ---
    wallets = db.wallets_with_validation_for_site(site_id)
    valid_wallets = [w for w in wallets if w.get("format_valid")]
    submittable = [w for w in valid_wallets if w.get("network") in FORM_NETWORK_LABELS]

    if SUBMISSION_REQUIRE_VALID_WALLET:
        checks.append(_check(
            "wallet_validated", bool(valid_wallets),
            f"{len(valid_wallets)} checksum-validated wallet(s) available" if valid_wallets
            else "No checksum-validated wallet found — nothing verifiable to report"))
        checks.append(_check(
            "wallet_network_supported", bool(submittable),
            f"Wallet network is accepted by the form ({submittable[0]['network']})"
            if submittable else
            "No validated wallet is on a network this form accepts "
            f"(accepted: {', '.join(sorted(FORM_NETWORK_LABELS))})"))
    else:
        checks.append(_check("wallet_validated", True,
                              "Wallet validation not required by current settings"))

    chosen_wallet = None
    if submittable:
        # Prefer a wallet with demonstrated on-chain activity — it's the
        # strongest single piece of evidence we can hand over.
        submittable.sort(key=lambda w: (w.get("tx_count") or 0), reverse=True)
        chosen_wallet = submittable[0]

    # --- duplicate guards ---
    site_dupe = db.site_already_submitted(site_id)
    checks.append(_check("not_duplicate_site", not site_dupe,
                          "Site has not been submitted before" if not site_dupe
                          else "This site has already been submitted"))

    if chosen_wallet:
        wallet_dupe = db.wallet_already_submitted(chosen_wallet["address"], chosen_wallet["network"])
        checks.append(_check(
            "not_duplicate_wallet", not wallet_dupe,
            f"Wallet {chosen_wallet['address'][:16]}… has not been submitted before"
            if not wallet_dupe else
            f"Wallet {chosen_wallet['address'][:16]}… has already been submitted"))

    passed = all(c["passed"] for c in checks)
    return {"passed": passed, "checks": checks, "wallet": chosen_wallet, "profile": profile}


# ---------------- Submission preparation ----------------

def prepare_submission(site_id: int, mode: str = None, headless: bool = False) -> dict:
    """
    Validates, then (for non-manual modes) opens and prefills the form, leaving
    it one human click from submitted. Records a form_submissions row either way
    so there's an audit trail of what was attempted and why it did or didn't go.
    """
    settings = get_submission_settings()
    mode = mode or settings["mode"]
    if mode not in SUBMISSION_MODES:
        raise ValueError(f"Unknown submission mode {mode!r}")

    validation = validate_for_submission(site_id)
    wallet = validation["wallet"]
    wallet_address = wallet["address"] if wallet else ""
    wallet_network = wallet["network"] if wallet else ""

    if not validation["passed"]:
        failed = [c for c in validation["checks"] if not c["passed"]]
        submission_id = db.create_form_submission(
            site_id, None, mode, "rejected", False, validation["checks"],
            wallet_address, wallet_network)
        return {
            "submission_id": submission_id,
            "status": "rejected",
            "mode": mode,
            "validation": validation["checks"],
            "message": ("Submission blocked by validation: "
                        + "; ".join(c["detail"] for c in failed)),
        }

    if mode == "manual":
        submission_id = db.create_form_submission(
            site_id, None, mode, "validated", True, validation["checks"],
            wallet_address, wallet_network)
        return {
            "submission_id": submission_id,
            "status": "validated",
            "mode": mode,
            "validation": validation["checks"],
            "wallet": {"address": wallet_address, "network": wallet_network},
            "site_url": db.get_site(site_id)["url"],
            "message": ("Validation passed. Manual mode: open the form yourself and use "
                        "the values shown here."),
        }

    # review_before_submit / automatic: actually open and prefill the form.
    from app.form_filler import prepare_form_for_review

    site = db.get_site(site_id)
    finding = None
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM findings WHERE site_id=? LIMIT 1", (site_id,)).fetchone()
        if row:
            finding = dict(row)
            finding["site_url"] = site["url"]
            finding["domain"] = site["domain"]

    if not finding:
        finding = {"id": 0, "site_url": site["url"], "domain": site["domain"]}

    wallets_for_form = [{"address": wallet_address, "network": wallet_network}] if wallet else []
    fill_result = prepare_form_for_review(finding, wallets_for_form, headless=headless)

    status = "awaiting_confirm" if fill_result.get("status") in (
        "ready_for_manual_submit", "partial") else "failed"

    submission_id = db.create_form_submission(
        site_id, finding.get("id") or None, mode, status, True, validation["checks"],
        wallet_address, wallet_network, fill_result.get("screenshot", ""))

    return {
        "submission_id": submission_id,
        "status": status,
        "mode": mode,
        "validation": validation["checks"],
        "wallet": {"address": wallet_address, "network": wallet_network},
        "site_url": site["url"],
        "form_result": fill_result,
        "message": (
            "Form is open and prefilled. Review the values, then click Submit in the "
            "browser window — the tool never clicks Submit for you, because filing a "
            "report is a real-world action that should always have a human behind it."
        ),
    }


def confirm_submitted(submission_id: int) -> dict:
    """
    Records that the operator personally clicked Submit. This does not submit
    anything — it's how the tool learns a submission happened so its duplicate
    guards and stats stay accurate.
    """
    submission = db.get_form_submission(submission_id)
    if not submission:
        return {"ok": False, "message": f"No submission with id {submission_id}"}

    import time
    db.update_form_submission(submission_id, status="submitted",
                               confirmed_by_user_at=time.time())

    finding_id = submission.get("finding_id")
    if finding_id:
        db.mark_finding_submitted(finding_id)

    return {"ok": True, "submission_id": submission_id,
            "message": "Recorded as submitted. Duplicate guards will now skip this site and wallet."}
