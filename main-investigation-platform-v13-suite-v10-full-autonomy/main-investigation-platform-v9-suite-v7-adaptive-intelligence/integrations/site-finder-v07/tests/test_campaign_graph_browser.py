"""Real browser -> campaign API -> SQLite -> refreshed graph UI."""
import threading

from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

from app.v2 import intelligence, store


def test_campaign_graph_review_and_edge_evidence_survive_reload(temp_db):
    from app.review.server import app

    wallet = "0x" + "c" * 40
    for domain in ("browser-a.test", "browser-b.test"):
        store.insert_new(domain, f"https://{domain}/", "feeds", .8)
        store.add_keys(domain, [("wallet", wallet)])
        store.update(domain, status="ready", p=.89, headline="Deposit evidence",
                     signals=[{"name": "deposit_address", "group": "wallet", "strength": .9,
                               "detail": wallet, "phrase": "deposit address shown (ETH)"}],
                     details={"ip": "192.0.2.4", "score": {"p_gate": .89, "core": ["wallet"]}})
        intelligence.ingest(store.get(domain))

    server = make_server("127.0.0.1", 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    cid = intelligence.campaign_for("browser-a.test")
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page()
            try:
                page.goto(f"http://127.0.0.1:{server.server_port}")
                page.get_by_role("link", name="Campaigns").click()
                page.get_by_role("heading", name="Campaigns and investigation paths").wait_for()
                page.locator("#campaign-list button").first.click()
                page.locator("#campaign-graph .graph-edge").first.wait_for()
                page.locator("#campaign-graph .graph-edge").first.click()
                page.get_by_text("Relationship evidence", exact=True).click()
                assert page.locator("#reject-edge").get_attribute("hidden") is None, page.locator("#graph-evidence").inner_text()
                page.get_by_text("Mark relationship incorrect").wait_for()
                assert wallet in page.locator("#graph-evidence").inner_text()
                page.get_by_role("button", name="Watch", exact=True).click()
                page.get_by_text("Campaign marked watch.").wait_for()
                with store.conn() as conn:
                    row = conn.execute("SELECT decision FROM ig_reviews WHERE campaign_id=?", (cid,)).fetchone()
                assert row["decision"] == "watch"
                page.reload()
                page.get_by_role("link", name="Campaigns").click()
                page.locator("#campaign-list button").first.click()
                page.get_by_text("2 related domains", exact=False).wait_for()
                assert "2 related domains" in page.locator("#campaign-summary").inner_text()
                assert intelligence.campaign_for("browser-b.test") == cid
                page.locator("#campaign-graph .graph-edge").first.click()
                page.get_by_text("Relationship evidence", exact=True).click()
                page.once("dialog", lambda dialog: dialog.accept("Shared value was a false match"))
                page.get_by_role("button", name="Mark relationship incorrect").click()
                page.get_by_text("No evidence-backed campaigns yet.").wait_for()
                assert intelligence.campaign_for("browser-b.test") is None
            finally:
                browser.close()
    finally:
        server.shutdown()
        thread.join(timeout=5)
