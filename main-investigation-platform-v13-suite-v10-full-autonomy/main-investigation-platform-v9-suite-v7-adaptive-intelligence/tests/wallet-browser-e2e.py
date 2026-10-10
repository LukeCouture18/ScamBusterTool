"""Browser half of tests/wallet-browser-e2e.mjs.

Plays the investigator: opens the site, logs in by typing into the login form, browses the deposit pages and
clicks the network tabs and the copy button like a person would. Wallet Logger (the real extension) only
watches. The script also closes and reopens the browser, and asks the orchestrator to stop/start Main and
kill/restart Wallet Investigator in the middle. At the end it opens Main's UI, checks the wallet pipeline
card and presses "Approve & Submit". Prints one JSON line with what it saw.
"""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

CFG = json.loads(os.environ["E2E"])
MAIN, SITE, DOMAIN, EXT = CFG["main"], CFG["site"], CFG["domain"], CFG["ext"]
W = CFG["wallets"]
human_actions: list[str] = []
log: list[str] = []


def say(msg: str) -> None:
    log.append(msg)
    print(msg, file=sys.stderr, flush=True)


def ctl(cmd: str) -> None:
    with urllib.request.urlopen(urllib.request.Request(f"{CFG['control']}/{cmd}", method="POST"), timeout=120) as r:
        assert r.status == 200, cmd
    say(f"control: {cmd}")


def api(path: str):
    try:
        with urllib.request.urlopen(f"{MAIN}{path}", timeout=10) as r:
            return json.loads(r.read())
    except Exception:  # noqa: BLE001 - Main may be restarting
        return None


DIAG = {}


def wait(pred, label: str, timeout: float) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return
        time.sleep(1)
    detail = ""
    try:
        w = DIAG.get("worker")
        if w:
            detail += " | logger: " + json.dumps(w.evaluate("async () => { const s = await chrome.storage.local.get(['mainPlatformSyncStatus','mainPlatformSyncQueue','mainPlatformSyncRejected']); return { status: s.mainPlatformSyncStatus, queued: (s.mainPlatformSyncQueue||[]).map(q => [q.type, q.payload && q.payload.address, q.attempts]), rejected: (s.mainPlatformSyncRejected||[]).map(q => [q.status, q.payload && q.payload.address]) }; }"))[:1500]
    except Exception as error:  # noqa: BLE001
        detail += f" | logger state unavailable: {error}"[:200]
    detail += " | main: " + json.dumps({a: [w["context"], w["validation"]["status"]] for a, w in candidates().items()})[:1500]
    raise AssertionError(f"timed out: {label}{detail}")


def launch(playwright, first: bool):
    ctx = playwright.chromium.launch_persistent_context(
        CFG["profile"], headless=True, channel="chromium",
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--host-resolver-rules=MAP *.test 127.0.0.1",
              f"--unsafely-treat-insecure-origin-as-secure={SITE}"])
    worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=20000)
    if first:  # the one-time setup a user does in the extension's settings: Main's address and the module key
        # The worker can be reported a moment before Chrome attaches the extension APIs to it; retry that one error.
        for _attempt in range(50):
            try:
                worker.evaluate("cfg => chrome.storage.local.set({ settings: { mainPlatform: cfg } })",
                {"enabled": True, "endpoint": f"{MAIN}/api/v1/compat/logger", "apiKey": CFG["key"]})
                break
            except Exception as _error:  # noqa: BLE001
                if "reading 'local'" not in str(_error) or _attempt == 49:
                    raise
                time.sleep(0.1)
    try:
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=SITE)
    except Exception:  # noqa: BLE001
        pass
    return ctx, worker


def queue(worker) -> int:
    return worker.evaluate("async () => ((await chrome.storage.local.get('mainPlatformSyncQueue')).mainPlatformSyncQueue || []).length")


def candidates() -> dict:
    view = api(f"/api/v1/suite/wallet-pipeline?domain={DOMAIN}")
    return {w["address"]: w for w in (view or {}).get("wallets", [])}


def shot(page, name: str) -> None:
    if CFG.get("shots"):
        os.makedirs(CFG["shots"], exist_ok=True)
        page.screenshot(path=os.path.join(CFG["shots"], f"{name}.png"), full_page=True)


with sync_playwright() as p:
    ctx, worker = launch(p, first=True)
    DIAG["worker"] = worker
    page = ctx.new_page()
    # 1. Open the site and log in yourself.
    page.goto(f"{SITE}/")
    page.click("text=Log in"); human_actions.append("open site + log in link")
    page.fill("#username", "investigator"); page.fill("#password", "my-own-test-account")
    page.click("#signin"); human_actions.append("log in")
    page.wait_for_url("**/account/deposit")
    page.wait_for_function(f"document.getElementById('addr').textContent.includes('{W['trc20']}')", timeout=10000)
    page.wait_for_timeout(1500)
    # 2. Look at the other network and copy the address, as a person checking the page would.
    page.click("#tab-bep20"); human_actions.append("choose BEP20 tab")
    page.wait_for_function(f"document.getElementById('addr').textContent.includes('{W['bep20']}')", timeout=10000)
    page.click("#copy"); human_actions.append("copy address")
    page.wait_for_timeout(1500)
    for path in ("/account/history", "/account/withdraw", "/help"):
        page.goto(f"{SITE}{path}"); page.wait_for_timeout(1200)
    human_actions.append("browse history/withdraw/help")
    wait(lambda: queue(worker) == 0 and W["trc20"] in candidates() and W["bep20"] in candidates(), "first wallets reached Main", 90)
    say(f"Main has {len(candidates())} candidates")

    # 3. Main and Wallet Investigator go down while you keep browsing.
    ctl("kill-wi")
    ctl("stop-main")
    page.goto(f"{SITE}/account/deposit/erc20"); human_actions.append("open ERC20 deposit page")
    page.wait_for_timeout(4000)
    queued = queue(worker)
    assert queued > 0, "with Main down the Logger keeps the observation queued"
    say(f"queued while Main is down: {queued}")
    # 4. Close the browser with that queue, bring Main back, reopen the browser.
    ctx.close()
    ctl("start-main")
    ctx, worker = launch(p, first=False)
    DIAG["worker"] = worker
    page = ctx.new_page()
    page.goto(f"{SITE}/account/deposit"); page.wait_for_timeout(1500)  # any new page view also nudges the queue
    wait(lambda: queue(worker) == 0, "Logger reconnected and drained its queue", 150)
    wait(lambda: W["erc20"] in candidates(), "ERC20 wallet seen while Main was down reached Main", 30)
    status = worker.evaluate("async () => (await chrome.storage.local.get('mainPlatformSyncStatus')).mainPlatformSyncStatus")
    say(f"Logger status after reconnect: {json.dumps(status)[:200]}")
    # 5. Wallet Investigator comes back and catches up.
    pending = sum(1 for w in candidates().values() if w["validation"]["status"] in ("pending", "queued"))
    say(f"waiting for Wallet Investigator: {pending} candidates")
    ctl("start-wi")

    # 6. Main builds the report by itself.
    state = {}

    def ready():
        view = api(f"/api/v1/suite/wallet-pipeline?domain={DOMAIN}") or {}
        state.update(view)
        rep = view.get("report") or {}
        return rep.get("state") == "ready_to_report" and len((rep.get("summary") or {}).get("wallets", [])) == 3
    wait(ready, "report ready with the three deposit wallets", 300)
    say(f"report ready: {state['report']['content_sha256'][:12]}")

    # 7. Review it in Main and press Approve & Submit (the only report action a person takes).
    ui = ctx.new_page()
    console: list[str] = []
    ui.on("console", lambda m: console.append(f"{m.type}: {m.text}"[:300]))
    ui.on("pageerror", lambda e: console.append(f"pageerror: {e}"[:500]))
    ui.goto(f"{MAIN}/finder?site={DOMAIN}")
    card = ui.locator("[data-wallet-pipeline]")
    try:
        card.wait_for(timeout=30000)
    except Exception:
        shot(ui, "no-pipeline-card")
        say("PAGE: " + ui.inner_text("body")[:2500].replace("\n", " | "))
        say("CONSOLE: " + " || ".join(console[-15:]))
        raise
    text = card.inner_text()
    for needle in ("Observations", "Validated", "Confirmed deposit contexts", "Ready to report", W["trc20"], W["bep20"], W["erc20"]):
        assert needle in text, f"pipeline card shows {needle!r}"
    for decoy in (CFG["decoys"]["contract"], CFG["decoys"]["withdraw"]):
        assert decoy not in (card.locator("[data-report]").inner_text()), "decoys are not in the report"
    # Drill-down: what wallet, where found, why deposit, validated, in report.
    ui.locator(f"tr[data-wallet='{W['bep20']}']").click()
    detail = ui.locator(f"[data-wallet-detail='{W['bep20']}']").inner_text()
    for needle in ("What wallet", "Where found", "Why deposit", "Validated?", "In report: yes", "bsc"):
        assert needle in detail, f"drill-down shows {needle!r}: {detail[:400]}"
    shot(ui, "ready-to-report")
    ui.get_by_role("button", name="Approve & Submit").click(); human_actions.append("Approve & Submit")
    ui.get_by_text("Approved. Form Submitter will file this exact report").wait_for(timeout=15000)

    def submitted():
        view = api(f"/api/v1/suite/wallet-pipeline?domain={DOMAIN}") or {}
        return (view.get("report") or {}).get("state") == "submitted"
    wait(submitted, "Form Submitter filed the report", 120)
    ui.reload()
    ui.get_by_text("Submitted · confirmation verified").wait_for(timeout=30000)
    shot(ui, "submitted")
    ctx.close()

print(json.dumps({"human_actions": human_actions, "report_actions": [a for a in human_actions if "Approve" in a], "log": log}))
