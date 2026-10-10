"""
Integration tests for the "find every wallet it can" feature set:

  - deep_wallet_hunt mode raising page/link budgets
  - clicking through currency/network tabs on a deposit page to reveal
    additional wallet addresses hidden behind a tab switch
  - continuing into the account area after a signup that succeeds CLEANLY
    (no CAPTCHA/verification wall), looking specifically for wallet pages
  - confirming signup is NEVER attempted when allow_signup is False, even
    in deep_wallet_hunt mode
  - confirming a signup that DOES hit a verification wall does not trigger
    the post-signup wallet hunt (only a clean "success" does)

These run the REAL navigator against a REAL local Flask fixture (real
Playwright browser, real HTTP), not mocks — same pattern as
test_navigator_integration.py, on a separate port so both files can run
concurrently without clashing.
"""
import multiprocessing
import time

PORT = 8790
BASE_URL = f"http://127.0.0.1:{PORT}"

try:
    import pytest
    _HAVE_PYTEST = True
except ImportError:
    _HAVE_PYTEST = False


def _run_fake_site(port):
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))
    from fake_scam_site import app
    app.run(port=port)


def _start_fake_site():
    proc = multiprocessing.Process(target=_run_fake_site, args=(PORT,), daemon=True)
    proc.start()
    import urllib.request
    for _ in range(30):
        try:
            urllib.request.urlopen(BASE_URL, timeout=1)
            break
        except Exception:
            time.sleep(0.3)
    else:
        proc.terminate()
        raise RuntimeError("fake_scam_site did not start in time")
    return proc


if _HAVE_PYTEST:
    @pytest.fixture(scope="module")
    def fake_site_server():
        proc = _start_fake_site()
        yield BASE_URL
        proc.terminate()
        proc.join(timeout=5)


def test_deep_wallet_hunt_clicks_through_currency_tabs(temp_db, fake_site_server):
    """
    /deposit-tabs shows only the BTC address by default; ETH and USDT-TRC20
    addresses are hidden behind tab clicks. The wallet-tab hunt must click
    through all three tabs and find all three addresses.
    """
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/deposit-tabs"

    result = investigate_site(site, headless=True)

    assert result["status"] == "completed"
    assert result["wallets_found"] >= 3, f"expected all 3 tabbed wallets, got {result['wallets_found']}"

    wallets = db.wallets_for_site(site_id)
    addresses = {w["address"] for w in wallets}
    assert "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2" in addresses  # default-visible BTC tab
    assert "0x8f317a1cE888D398DccAB715e42D161C05fF770a" in addresses  # behind ETH tab click
    assert "TXYZq9K8mZaCVzWvBEwXaK5b7fRZ8g5xAB" in addresses  # behind USDT-TRC20 tab click


def test_wallet_tab_clicks_are_logged_as_decisions(temp_db, fake_site_server):
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/deposit-tabs"
    investigate_site(site, headless=True)

    investigations = db.list_recent_investigations(limit=5)
    inv = [i for i in investigations if i["site_id"] == site_id][0]
    decisions = db.decisions_for_investigation(inv["id"])

    tab_found_decisions = [d for d in decisions if "currency/network tab" in d["detail"]]
    assert len(tab_found_decisions) == 1

    revealed_decisions = [d for d in decisions if "revealed" in d["detail"] and "additional wallet" in d["detail"]]
    assert len(revealed_decisions) >= 2, "expected a logged reveal for each non-default tab clicked"


def test_wallet_count_is_not_inflated_by_re_scanning_after_tab_clicks(temp_db, fake_site_server):
    """
    Regression test for a real bug: clicking through N currency tabs re-scans
    the WHOLE page after each click, including wallets that were already
    visible before that click. Each re-scan correctly avoided creating
    duplicate DB rows, but the reported wallets_found count kept incrementing
    anyway (it counted every extraction hit, not just genuinely new ones) —
    a page with 3 real addresses was reported as having 13 "wallets found."
    The reported count must exactly match the number of distinct wallet rows
    actually stored for the site.
    """
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/deposit-tabs"

    result = investigate_site(site, headless=True, deep_wallet_hunt=True)

    actual_wallets = db.wallets_for_site(site_id)
    assert result["wallets_found"] == len(actual_wallets), (
        f"reported wallets_found ({result['wallets_found']}) must match the actual "
        f"number of distinct wallet rows stored ({len(actual_wallets)})"
    )


def test_deep_wallet_hunt_mode_allows_more_pages_than_default(temp_db, fake_site_server):
    """
    Confirms deep_wallet_hunt=True actually changes the investigator's page
    budget rather than being a no-op flag.
    """
    from app.investigate.navigator import SiteInvestigation
    from app.config import MAX_PAGES_PER_INVESTIGATION, DEEP_WALLET_HUNT_MAX_PAGES

    site = {"id": 1, "url": "http://example.test"}
    normal_inv = SiteInvestigation(site, deep_wallet_hunt=False)
    deep_inv = SiteInvestigation(site, deep_wallet_hunt=True)

    assert normal_inv.visited.max_pages == MAX_PAGES_PER_INVESTIGATION
    assert deep_inv.visited.max_pages == DEEP_WALLET_HUNT_MAX_PAGES
    assert deep_inv.visited.max_pages > normal_inv.visited.max_pages


def test_signup_never_attempted_when_allow_signup_false_even_in_deep_hunt_mode(temp_db, fake_site_server):
    """
    deep_wallet_hunt must never imply allow_signup — signup is a completely
    separate, explicit opt-in regardless of how aggressively the wallet hunt
    is configured.
    """
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/signup-clean"

    investigate_site(site, headless=True, allow_signup=False, deep_wallet_hunt=True)

    with db.get_conn() as conn:
        rows = conn.execute("SELECT * FROM signup_attempts WHERE site_id=?", (site_id,)).fetchall()
    assert len(rows) == 0, "signup must never be attempted when allow_signup=False"


def test_post_signup_wallet_hunt_finds_member_only_deposit_page(temp_db, fake_site_server, monkeypatch):
    """
    /signup-clean submits with no CAPTCHA/verification, landing on
    /account-dashboard, which links to /member-deposit — a page ONLY
    reachable after signing up. The post-signup wallet hunt must follow that
    link and find the wallet address there.
    """
    import app.config as config
    monkeypatch.setattr(config, "SIGNUP_RESEARCH_EMAIL_DOMAIN", "research-test.invalid")
    import app.investigate.signup as signup_mod
    monkeypatch.setattr(signup_mod, "SIGNUP_RESEARCH_EMAIL_DOMAIN", "research-test.invalid")

    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/signup-clean"

    result = investigate_site(site, headless=True, allow_signup=True)

    assert result["status"] == "completed"
    assert result["post_signup_pages_visited"] >= 1, "expected the post-signup hunt to visit at least one page"

    wallets = db.wallets_for_site(site_id)
    addresses = {w["address"] for w in wallets}
    assert "TAbcdEFGhJK345LMNopQRSTuvwxYZabc9X" in addresses, \
        "expected the member-only deposit page's wallet to be found post-signup"

    pages = db.pages_for_site(site_id)
    urls = {p["url"] for p in pages}
    assert any("/account-dashboard" in u for u in urls)
    assert any(u.rstrip("/").endswith("/member-deposit") for u in urls)


def test_post_signup_hunt_does_not_run_when_signup_hits_verification_wall(temp_db, fake_site_server, monkeypatch):
    """
    Forces attempt_signup_on_page to report a blocked result regardless of
    what the page actually does, so we can assert on the gating behavior in
    navigator.py directly: the post-signup hunt must only run after a clean
    'success', never after any blocked_* result.
    """
    import app.config as config
    monkeypatch.setattr(config, "SIGNUP_RESEARCH_EMAIL_DOMAIN", "research-test.invalid")
    import app.investigate.signup as signup_mod
    monkeypatch.setattr(signup_mod, "SIGNUP_RESEARCH_EMAIL_DOMAIN", "research-test.invalid")

    def fake_attempt_signup_on_page(page, site, investigation_id=None):
        return {"status": "blocked_verification", "detail": "simulated verification wall"}

    monkeypatch.setattr(
        "app.investigate.signup.attempt_signup_on_page", fake_attempt_signup_on_page,
    )

    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/signup"

    result = investigate_site(site, headless=True, allow_signup=True)

    assert result["post_signup_pages_visited"] == 0, \
        "post-signup hunt must not run when signup was blocked, not a clean success"
