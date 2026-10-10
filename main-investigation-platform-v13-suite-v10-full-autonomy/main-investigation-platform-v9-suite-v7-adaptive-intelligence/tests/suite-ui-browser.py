"""Browser half of tests/suite-workflow.mjs: walks the five tools of the unified suite.

Checks, in a real Chromium, against the Main instance and data the workflow test just built:
  - the sidebar has exactly the five tools (plus Needs you and Advanced);
  - every tool answers what happened / what was found / why it matters / what next in plain words,
    with scores and records behind "Why" / "Details";
  - the investigation context (site, wallet, operation) follows you between tools, survives a
    reload, and can be cleared;
  - evidence is labelled by what it is (seen on the site / analysis), and membership or shared
    infrastructure is never presented as proof;
  - the pages work at phone width without sideways scrolling, and the browser logs no errors.
Prints one JSON line. Without Playwright it prints {"skipped": ...}.
"""
import json
import os
import re
import sys
from urllib.parse import quote

try:
    from playwright.sync_api import sync_playwright, expect
except Exception as exc:  # pragma: no cover - depends on the machine
    print(json.dumps({"skipped": f"playwright is not installed ({exc})"}))
    sys.exit(0)

BASE = os.environ["SUITE_URL"]
SITE = os.environ["SUITE_SITE"]
WALLET = os.environ["SUITE_WALLET"]
ADDRESS = WALLET.split(":")[-1]
OP = os.environ["SUITE_OP"]
OTHER = os.environ.get("SUITE_OTHER", "")
SHOTS = os.environ.get("SUITE_SHOTS", "")
TOOLS = ["Site Finder", "Wallet Investigator", "Wallet Logger", "Form Submitter", "Operation Hunter"]
checks = []


def check(name, cond=True):
    if not cond:
        raise AssertionError(name)
    checks.append(name)


def shot(page, name):
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, f"{name}.png"), full_page=True)


def launch(pw):
    try:
        return pw.chromium.launch(headless=True)
    except Exception:
        return pw.chromium.launch(headless=True, executable_path="/opt/pw-browsers/chromium")


with sync_playwright() as pw:
    try:
        browser = launch(pw)
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"skipped": f"no Chromium available ({exc})"}))
        sys.exit(0)
    page = browser.new_page(viewport={"width": 1400, "height": 950})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    # Home: the five tools, what happened, and no context yet.
    page.goto(BASE + "/")
    expect(page.get_by_role("heading", name="Your investigations")).to_be_visible()
    expect(page.get_by_role("button", name="Start Investigation", exact=True)).to_be_visible()
    secondary=page.locator("summary").filter(has_text="Investigate This Site")
    check("v10 start action is primary and secondary URL entry is collapsed", not secondary.locator("..").evaluate("e=>e.open"))
    secondary.click()
    expect(page.get_by_role("button", name="Investigate Site", exact=True)).to_be_visible()
    secondary.click()
    page.locator("summary").filter(has_text="Tools / Advanced").click()
    expect(page.get_by_role("heading", name="What is happening")).to_be_visible()
    nav = page.get_by_role("navigation", name="Tools")
    check("sidebar lists exactly the five tools", [a.inner_text().strip() for a in nav.get_by_role("link").all()] == TOOLS)
    more = page.get_by_role("navigation", name="More")
    check("Needs you and Advanced sit below the tools", [a.inner_text().strip().split("\n")[0] for a in more.get_by_role("link").all()] == ["Needs you", "Advanced"])
    for tool in ("finder", "wallets", "logger", "reports", "hunter"):
        expect(page.locator(f'.mip-tool[data-tool="{tool}"] .mip-tool-line').first).to_be_visible()
    expect(page.locator('.mip-tool[data-tool="reports"]')).to_contain_text("Submitted")
    check("home shows each tool's state", True)
    expect(page.get_by_text("No site, wallet or operation selected")).to_be_visible()
    check("home lists what happened", page.locator(".mip-card").filter(has_text="What happened recently").locator("li").count() >= 1)
    shot(page, "01-home")

    # Site Finder: the queue explains itself; details are behind "Why".
    nav.get_by_role("link", name="Site Finder").click()
    expect(page.get_by_role("heading", name="Site Finder")).to_be_visible()
    queue = page.locator(".mip-card").filter(has_text="Worth a look now")
    cards = queue.locator("li.mip-item")
    expect(cards.first).to_be_visible()
    check("finder queue has sites waiting", cards.count() >= 1)
    first = cards.first
    first_meta = first.locator(".mip-meta").first.inner_text()
    check("each site says why it is worth a look", first_meta.startswith("•") or first_meta.startswith("Found this because"))
    score = first.get_by_text(re.compile(r"^Score \d+/100"))
    check("scores are hidden until you ask why", not score.is_visible())
    first.locator("details.mip-why > summary", has_text="Why?").first.click()
    expect(score).to_be_visible()
    check("why reveals the score and its meaning", "software estimate" in first.inner_text())
    shot(page, "02-finder-queue")
    # "Found this because ..." with the discovery chain behind "How was it found?"
    because = page.locator("[data-because]")
    if because.count():
        check("pursuit leads say why they were found", because.first.inner_text().startswith("Found this because"))
        card = page.locator("li.mip-item").filter(has=page.locator("[data-because]")).first
        how = card.locator("details.mip-why > summary", has_text="How was it found?")
        if how.count():
            how.click()
            check("the discovery chain is shown step by step", card.locator("ol li").count() >= 1)
    page.get_by_role("tab", name=re.compile(r"^Investigate")).click()
    expect(page.locator(".mip-card").filter(has_text="Sites you marked useful")).to_contain_text(SITE)
    check("the reviewed site is listed under Investigate with its stage", True)
    page.get_by_role("tab", name=re.compile(r"^Hunts")).click()
    hunting = page.locator(".mip-card").filter(has_text="Hunting now")
    expect(hunting).to_be_visible()
    check("hunts are listed in plain words", hunting.locator("li.mip-item").count() + page.locator("details.mip-why", has_text="Paused and finished hunts").count() >= 1)
    check("hunt internals stay behind Details", page.locator("details.mip-why", has_text="Details: where new sites came from").first.get_attribute("open") is None)
    shot(page, "03-finder-hunts")
    check("Site Finder shows exactly three views", [re.sub(r"\s*\d+$", "", t.inner_text().strip()) for t in page.locator(".mip-page .mip-tabs").first.get_by_role("tab").all()] == ["Find sites", "Investigate", "Hunts"])
    page.get_by_role("tab", name=re.compile(r"^Find sites")).click()

    # Investigate: look up the site; the context chip appears and the whole story is on one page.
    page.get_by_label("Look up a site").fill(SITE)
    page.get_by_role("button", name="Open").click()
    inv = page.locator(f'[data-site="{SITE}"]')
    expect(inv).to_be_visible()
    ctx = page.get_by_label("Current investigation context")
    expect(ctx).to_contain_text(SITE)
    check("picking a site sets the context", f"site={SITE}" in page.url)
    expect(inv.get_by_role("heading", name="What we know")).to_be_visible()
    expect(inv.get_by_role("heading", name="What you could do next")).to_be_visible() if inv.get_by_role("heading", name="What you could do next").count() else None
    expect(inv.locator(".mip-steps")).to_be_visible()
    expect(inv.get_by_text("Seen on the site").first).to_be_visible()
    check("evidence is labelled as seen on the site", True)
    check("no raw JSON or module-internal titles by default", '{"' not in inv.inner_text() and "wallet_display" not in inv.inner_text())
    check("site evidence comes first", "Seen on the site" in inv.locator(".mip-card").filter(has_text="Evidence (").locator("li.mip-item").first.inner_text())
    expect(inv.locator(".mip-card").filter(has_text="Operation").get_by_text("Suite test operation")).to_be_visible()
    check("shared-infrastructure caution is shown", "do not prove" in inv.inner_text())
    jobs_hidden = not inv.get_by_role("table").first.is_visible() if inv.get_by_role("table").count() else True
    check("module jobs stay behind Details", jobs_hidden)
    shot(page, "04-site-investigation")

    # Follow the money: the wallet joins the context, the site stays.
    inv.get_by_role("link", name="Follow the money").first.click()
    expect(page.get_by_role("heading", name="Wallet Investigator")).to_be_visible()
    expect(ctx).to_contain_text(SITE)
    expect(ctx.locator("small", has_text="wallet")).to_be_visible()
    check("site context survives the move to Wallet Investigator", f"site={SITE}" in page.url and "wallet=" in page.url)
    expect(page.get_by_text("Wallet Investigator recorded", exact=False)).to_be_visible()
    check("money flow explained in words", True)
    page.get_by_role("tab", name=re.compile(r"^Flow")).click()
    expect(page.locator("table.mip-table tbody tr").first).to_be_visible()
    page.get_by_role("tab", name=re.compile(r"^Connections")).click()
    body = page.locator(".mip-page")
    expect(body.get_by_role("link", name=SITE)).to_be_visible()
    expect(page.get_by_text("not an identity", exact=False)).to_be_visible()
    expect(page.get_by_role("link", name="Suite test operation")).to_be_visible()
    shot(page, "05-wallet")

    # Reload keeps the context (URL + tab memory).
    page.reload()
    expect(ctx).to_contain_text(SITE)
    check("context survives a reload", True)

    # Wallet Logger: passive, captures listed, context still there.
    nav.get_by_role("link", name="Wallet Logger").click()
    expect(page.get_by_role("heading", name="Wallet Logger")).to_be_visible()
    expect(page.get_by_text("passive", exact=False).first).to_be_visible()
    expect(page.locator("table.mip-table").get_by_role("link", name=SITE)).to_be_visible()
    check("logger capture visible in Main", True)
    expect(ctx).to_contain_text(SITE)
    shot(page, "06-logger")

    # Form Submitter: the approved report is submitted and confirmed.
    nav.get_by_role("link", name="Form Submitter").click()
    expect(page.get_by_role("heading", name="Form Submitter")).to_be_visible()
    expect(page.get_by_text("Submitted and confirmed")).to_be_visible()
    check("report status in plain words", True)
    expect(page.get_by_text("Nothing is filed until you approve", exact=False)).to_be_visible()
    shot(page, "07-reports")

    # Operation Hunter: opened from the site with the operation in context.
    page.goto(BASE + f"/finder?site={quote(SITE)}")
    page.locator(f'[data-site="{SITE}"]').get_by_role("link", name="Open in Operation Hunter").click()
    expect(page.get_by_role("heading", name="Operation Hunter", exact=True)).to_be_visible()
    expect(ctx.locator("small", has_text="operation")).to_be_visible()
    check("operation joins the context", "op=" in page.url and f"site={SITE}" in page.url)
    expect(page.get_by_role("heading", name="Suite test operation")).to_be_visible()
    expect(page.get_by_text("Three look-alike yield sites", exact=False)).to_be_visible()
    check("hunter briefing leads with the headline", True)
    page.get_by_role("tab", name=re.compile(r"^Evidence")).click()
    if OTHER:
        expect(page.locator(".mip-page").get_by_role("link", name=OTHER)).to_be_visible()
    check("membership is labelled as analysis", "not proof" in page.locator("main").inner_text() or "never proof" in page.locator("main").inner_text())
    shot(page, "08-hunter")

    # From a Hunter member site straight back into Site Finder.
    if OTHER:
        page.locator(".mip-page").get_by_role("link", name=OTHER).click()
        expect(page.locator(f'[data-site="{OTHER}"]')).to_be_visible()
        expect(ctx).to_contain_text(OTHER)
        check("member site opens in Site Finder with the new site in context", True)

    # Clearing the context.
    ctx.get_by_role("button", name="Clear site").click()
    expect(ctx).not_to_contain_text(OTHER or SITE)
    check("context can be cleared", "site=" not in page.url)

    # Advanced keeps Main's own views reachable.
    more.get_by_role("link", name="Advanced").click()
    expect(page.get_by_role("heading", name="Advanced")).to_be_visible()
    check("advanced links to Main's views", page.locator("main a[href^='/']").count() >= 5)
    shot(page, "09-advanced")

    # Phone width: no sideways scrolling on the main pages.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.on("pageerror", lambda e: errors.append(str(e)))
    for path in ["/", "/finder", f"/finder?site={quote(SITE)}", f"/wallets?wallet={quote(WALLET)}", "/logger", "/reports", f"/hunter?op={quote(OP)}"]:
        phone.goto(BASE + path)
        phone.wait_for_timeout(700)
        wide = phone.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        if wide > 1:
            culprits = phone.evaluate("""() => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll('body *')]
              .filter(e => e.getBoundingClientRect().right > w + 1 && getComputedStyle(e).position !== 'fixed')
              .slice(0, 8).map(e => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)} right=${Math.round(e.getBoundingClientRect().right)}`); }""")
            raise AssertionError(f"sideways scroll at phone width on {path}: {wide}px; {culprits}")
        check(f"no sideways scroll at phone width on {path.split('?')[0]}", True)
    shot(phone, "10-phone-home")

    real_errors = [e for e in errors if "favicon" not in e]
    check("no browser errors", not real_errors)
    browser.close()

print(json.dumps({"checks": len(checks), "passed": checks}))
