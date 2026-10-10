"""Manual investigation uses real browser -> API -> SQLite -> refreshed UI."""
import threading

from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

from app.v2 import active, intelligence, store


def test_manual_frontier_request_survives_browser_reload(temp_db):
    from app.review.server import app

    domain = "browser-frontier.test"
    store.insert_new(domain, f"https://{domain}/", "feeds", .91)
    store.update(domain, status="ready", p=.91, headline="Observed deposit page",
                 details={"ip": "192.0.2.10", "score": {"p_gate": .91, "core": ["wallet"]}})
    intelligence.ingest(store.get(domain))
    server = make_server("127.0.0.1", 0, app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page()
            try:
                page.goto(f"http://127.0.0.1:{server.server_port}/")
                page.get_by_role("link", name="Investigations").click()
                page.locator("#list .candidate.selected").wait_for()
                page.get_by_role("button", name="Investigate selected site").click()
                page.locator("#frontier-items .candidate").first.wait_for()
                assert active.list_frontier()[0]["seed"] == domain
                page.reload()
                page.get_by_role("link", name="Investigations").click()
                page.locator("#frontier-items .candidate").first.wait_for()
                page.get_by_role("button", name="Open path").first.click()
                page.get_by_text("Path history and source diagnostics").click()
                page.get_by_text('"seed": "browser-frontier.test"', exact=False).wait_for()
                path = active.list_frontier()[0]["path_id"]
                page.get_by_role("button", name="Pause", exact=True).first.click()
                page.wait_for_function("async id => (await (await fetch('/api/v2/investigation/paths/'+id)).json()).path.state === 'PAUSED'", arg=path)
                assert active.path_detail(path)["path"]["state"] == "PAUSED"
            finally:
                browser.close()
    finally:
        server.shutdown()
        thread.join(timeout=5)
