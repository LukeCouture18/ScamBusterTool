"""
Integration tests: run the REAL navigator (real Playwright browser, real
Flask HTTP server) against a local fake scam site (tests/fixtures/fake_scam_site.py)
so we can verify actual end-to-end behavior — not just mocked pieces — for:

  - discovering wallet addresses across multiple pages
  - following relevant links (deposit/wallet/investment) via keyword fallback
  - NOT following an external-domain link
  - stopping the entire investigation at an access-control wall (payment_required)
  - avoiding infinite loops between two pages that link to each other
  - handling a dead link (404) without crashing
  - handling a redirect and continuing on the redirected page without double-counting
  - recognizing login and signup pages without entering credentials (signup disabled)
  - recording decision-log entries explaining the navigation

These are slower than the pure unit tests (real browser + real HTTP) so they're
kept in their own file; run_tests_standalone.py and pytest both pick them up
automatically alongside everything else.
"""
import multiprocessing
import time

PORT = 8765
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


def test_full_investigation_finds_wallets_and_follows_relevant_links(temp_db, fake_site_server):
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)

    result = investigate_site(site, headless=True)

    assert result["status"] == "completed"
    assert result["pages_visited"] >= 3  # home + at least deposit + wallet
    assert result["wallets_found"] >= 2  # ETH/USDT on /deposit, TRON on /wallet

    wallets = db.wallets_for_site(site_id)
    networks_found = {w["network"] for w in wallets}
    assert "USDT" in networks_found or "ETH" in networks_found
    assert "TRON" in networks_found


def test_does_not_follow_external_domain_links(temp_db, fake_site_server):
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    investigate_site(site, headless=True)

    pages = db.pages_for_site(site_id)
    for p in pages:
        assert "external-other-site.invalid" not in p["url"]


def test_stops_entire_investigation_at_payment_access_control_wall(temp_db, fake_site_server):
    """
    The fake site's /verify page demands a payment to unlock withdrawal — a
    payment_required access-control wall. The investigator must record this
    as the stop reason and must not keep crawling past it.
    """
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)

    # Force the crawl to hit /verify directly and confirm the STOP behavior in
    # isolation (rather than relying on keyword-link-selection to wander there,
    # which makes the test flaky). We do this by pointing the investigation's
    # base_url straight at /verify.
    site["url"] = fake_site_server + "/verify"
    result = investigate_site(site, headless=True)

    assert result["status"] == "blocked"
    assert "payment_required" in result["stop_reason"]

    investigations = db.list_recent_investigations(limit=5)
    inv = [i for i in investigations if i["site_id"] == site_id][0]
    assert inv["status"] == "blocked"
    assert "payment_required" in inv["stop_reason"]

    decisions = db.decisions_for_investigation(inv["id"])
    stop_decisions = [d for d in decisions if d["decision_type"] == "stop"]
    assert len(stop_decisions) == 1
    assert "payment required" in stop_decisions[0]["detail"].lower()


def test_avoids_infinite_loop_between_two_pages(temp_db, fake_site_server):
    """
    /loop-a and /loop-b link to each other forever. The investigator must
    terminate (not hang) and must not visit either page more than once.
    """
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/loop-a"

    start = time.time()
    result = investigate_site(site, headless=True)
    elapsed = time.time() - start

    assert elapsed < 60, "investigation should terminate quickly, not hang in the loop"

    pages = db.pages_for_site(site_id)
    loop_a_visits = [p for p in pages if p["url"].rstrip("/").endswith("loop-a")]
    loop_b_visits = [p for p in pages if p["url"].rstrip("/").endswith("loop-b")]
    assert len(loop_a_visits) <= 1, "loop-a should only be visited once"
    assert len(loop_b_visits) <= 1, "loop-b should only be visited once"


def test_handles_dead_link_without_crashing(temp_db, fake_site_server):
    """/has-dead-link links to /dead-link, which returns a 404. Investigating
    must not crash, and the 404 target itself should not be recorded as a
    successfully-visited content page."""
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/has-dead-link"
    result = investigate_site(site, headless=True)

    assert result["status"] == "completed"
    pages = db.pages_for_site(site_id)
    # The entry page itself (/has-dead-link) legitimately gets recorded; only the
    # 404 TARGET (/dead-link, an exact path match) must never appear as a visited page.
    dead_link_visits = [p for p in pages if p["url"].rstrip("/").endswith("/dead-link")]
    assert len(dead_link_visits) == 0, "the 404 page itself should not be recorded as a visited content page"


def test_handles_redirect_and_continues_on_final_url(temp_db, fake_site_server):
    """/old-deposit redirects (301) to /deposit. The investigator should end up
    recording the final, redirected URL rather than crashing or double-visiting."""
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/old-deposit"
    result = investigate_site(site, headless=True)

    assert result["status"] == "completed"
    pages = db.pages_for_site(site_id)
    urls = [p["url"] for p in pages]
    assert any(u.rstrip("/").endswith("/deposit") for u in urls)


def test_recognizes_login_page_without_entering_credentials(temp_db, fake_site_server):
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/login"
    result = investigate_site(site, headless=True, allow_signup=False)

    assert result["status"] == "completed"
    pages = db.pages_for_site(site_id)
    login_pages = [p for p in pages if p["page_type"] == "login"]
    assert len(login_pages) == 1

    investigations = db.list_recent_investigations(limit=5)
    inv = [i for i in investigations if i["site_id"] == site_id][0]
    decisions = db.decisions_for_investigation(inv["id"])
    login_decisions = [d for d in decisions if d["decision_type"] == "login_detected"]
    assert len(login_decisions) == 1
    assert "not entering any credentials" in login_decisions[0]["detail"].lower()


def test_recognizes_signup_page_and_skips_when_disabled(temp_db, fake_site_server):
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/signup"
    result = investigate_site(site, headless=True, allow_signup=False)

    assert result["status"] == "completed"
    pages = db.pages_for_site(site_id)
    signup_pages = [p for p in pages if p["page_type"] == "signup"]
    assert len(signup_pages) == 1

    investigations = db.list_recent_investigations(limit=5)
    inv = [i for i in investigations if i["site_id"] == site_id][0]
    decisions = db.decisions_for_investigation(inv["id"])
    signup_decisions = [d for d in decisions if d["decision_type"] == "signup_detected"]
    assert len(signup_decisions) == 1
    assert "not attempted" in signup_decisions[0]["detail"].lower() or \
           "not enabled" in signup_decisions[0]["detail"].lower()

    # Confirm no signup_attempts row was created since signup was disabled.
    with db.get_conn() as conn:
        rows = conn.execute("SELECT * FROM signup_attempts WHERE site_id=?", (site_id,)).fetchall()
    assert len(rows) == 0


def test_decision_log_records_navigation_reasoning(temp_db, fake_site_server):
    """Every investigation should leave a human-readable trail of why it went where it went."""
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    investigate_site(site, headless=True)

    investigations = db.list_recent_investigations(limit=5)
    inv = [i for i in investigations if i["site_id"] == site_id][0]
    decisions = db.decisions_for_investigation(inv["id"])

    assert len(decisions) > 0
    # At least one decision should be plain-language and reference this being the start.
    assert any("starting investigation" in d["detail"].lower() for d in decisions)


def test_wallet_evidence_captured_with_screenshot(temp_db, fake_site_server):
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    site["url"] = fake_site_server + "/deposit"
    investigate_site(site, headless=True)

    evidence = db.wallet_evidence_for_site(site_id)
    assert len(evidence) >= 1
    for e in evidence:
        assert e["screenshot_path"]  # non-empty path
        assert e["surrounding_text"]  # some context captured


def test_investigation_record_wallets_found_count_matches_actual_wallets(temp_db, fake_site_server):
    """
    Regression test for a real bug: the investigations table's wallets_found
    column was never actually written by the navigator (it tracked the count
    in memory and returned it from investigate_site(), but never persisted it
    to the DB record the UI reads), so the Investigations panel always showed
    0 wallets found even when wallets were clearly recorded. This must stay
    in sync.
    """
    from app import db
    from app.investigate.navigator import investigate_site

    site_id = db.add_site(fake_site_server, "test")
    site = db.get_site(site_id)
    result = investigate_site(site, headless=True)

    assert result["wallets_found"] >= 2  # deposit + wallet pages both have addresses

    investigations = db.list_recent_investigations(limit=5)
    inv = [i for i in investigations if i["site_id"] == site_id][0]
    assert inv["wallets_found"] == result["wallets_found"], (
        "the investigations table's wallets_found column must match the actual "
        "number of wallets found, not stay stuck at 0"
    )
