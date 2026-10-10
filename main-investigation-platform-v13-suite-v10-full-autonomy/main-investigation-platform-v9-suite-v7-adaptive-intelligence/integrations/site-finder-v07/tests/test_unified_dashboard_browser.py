"""Release-gate test: the real dashboard, browser, API and SQLite state."""
import threading
import time

from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

from app.v2 import store


def test_unified_dashboard_controls_reach_persisted_state(temp_db):
    from app.review.server import app, controller
    from benchmark.world import World
    from benchmark.simnet import SimNet, installed

    server = make_server("127.0.0.1", 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    for domain, score in (("first-review.example", 0.9), ("second-review.example", 0.8)):
        store.insert_new(domain, f"{base}/api/v2/stats", "ct_terms", 0.6)
        store.update(domain, status="ready", p=score, headline="Public deposit signal worth checking",
                     signals=[{"group": "deposit", "phrase": "deposit page", "strength": 0.8}])
    try:
        with installed(SimNet(World(seed=11, split="dev"))), sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page()
            try:
                page.goto(base, wait_until="domcontentloaded")
                page.get_by_role("heading", name="Find worthwhile new sites").wait_for()
                page.get_by_role("button", name="first-review.example NEW").click()
                page.get_by_text("Public deposit signal worth checking").first.wait_for()
                page.get_by_text("Why? · View Evidence").click()
                page.locator("#evidence").get_by_text("deposit page", exact=False).wait_for()
                page.get_by_text("Details", exact=True).click()
                page.get_by_text('"domain": "first-review.example"').wait_for()

                with page.expect_popup() as popup:
                    page.get_by_role("button", name="Open Site").click()
                popup.value.wait_for_load_state()
                assert popup.value.url.startswith(base + "/api/v2/stats")
                popup.value.close()
                assert store.get("first-review.example")["opened_at"]

                page.get_by_role("button", name="Next", exact=True).click()
                page.get_by_role("heading", name="second-review.example").wait_for()
                assert store.get("first-review.example")["status"] == "presented"
                page.get_by_role("button", name="Skip", exact=True).click()
                page.get_by_label("Reason for skipping").select_option("not_useful")
                page.get_by_role("button", name="Confirm Skip").click()
                page.get_by_text("second-review.example marked skip").wait_for()
                assert store.get("second-review.example")["status"] == "skipped"
                page.get_by_role("button", name="Useful", exact=True).click()
                page.get_by_text("first-review.example marked useful").wait_for()
                assert store.get("first-review.example")["status"] == "useful"

                page.get_by_role("link", name="Advanced").click()
                page.get_by_role("heading", name="Discovery diagnostics").wait_for()
                page.get_by_role("link", name="Best new sites").click()
                assert page.url.endswith("#candidates")
                page.get_by_role("link", name="Review site").click()
                assert page.url.endswith("#review")
                page.locator('nav a[href="#discovery"]').click()
                assert page.url.endswith("#discovery")
                page.get_by_role("button", name="Start Discovery").click()
                page.get_by_text("Discovery", exact=True).first.wait_for()
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    # The cycle runs in a background thread that creates v5_cycles itself; until it
                    # has, there is simply no completed cycle yet.
                    with store.conn() as c:
                        exists = c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v5_cycles'").fetchone()
                        cycles = c.execute("SELECT COUNT(*) n FROM v5_cycles WHERE status='done'").fetchone()["n"] if exists else 0
                    if cycles:
                        break
                    time.sleep(0.25)
                else:
                    with store.conn() as c:
                        states = [dict(r) for r in c.execute("SELECT id,status,reason FROM v5_cycles")] if c.execute(
                            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='v5_cycles'").fetchone() else "no cycle table"
                    raise AssertionError(f"Start Discovery did not persist a completed cycle: {states}")
                page.reload()
                page.get_by_role("button", name="Start Discovery").wait_for()
                assert page.locator("#waiting").inner_text().isdigit()
                assert page.locator("#scan-state").inner_text() in ("Idle", "Running")
                page.get_by_role("searchbox", name="Filter candidates").fill("never-matches-this-domain")
                page.get_by_text("No matches in the top leads.").wait_for()
            finally:
                browser.close()
    finally:
        controller.stop()
        server.shutdown()
        thread.join(timeout=5)
