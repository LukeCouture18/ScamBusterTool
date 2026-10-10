"""One human decision taken in the real UI (tests/suite-workflow.mjs drives the workflow with it).

Opens a page, optionally selects a tab, finds the button inside the given scope and clicks it,
then waits for the API request that click must send and prints its outcome as one JSON line:
  {"status": <HTTP status>, "body": <response JSON>, "errors": [console errors / exceptions]}

UI_ACT (JSON): {"base": url, "path": "/finder", "tab": "^Review", "within": css selector,
                "within_text": text the scope contains, "button": "^Useful$",
                "method": "POST", "api": "/api/v1/suite/actions"}
Without Playwright it prints {"skipped": ...}.
"""
import json
import os
import re
import sys

try:
    from playwright.sync_api import sync_playwright
except Exception as exc:  # pragma: no cover
    print(json.dumps({"skipped": f"playwright is not installed ({exc})"}))
    sys.exit(0)

spec = json.loads(os.environ["UI_ACT"])
errors = []

with sync_playwright() as pw:
    try:
        browser = pw.chromium.launch(headless=True)
    except Exception:
        try:
            browser = pw.chromium.launch(headless=True, executable_path="/opt/pw-browsers/chromium")
        except Exception as exc:  # pragma: no cover
            print(json.dumps({"skipped": f"no Chromium available ({exc})"}))
            sys.exit(0)
    page = browser.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(spec["base"].rstrip("/") + spec["path"])
    if spec.get("tab"):
        page.get_by_role("tab", name=re.compile(spec["tab"])).click()
    scope = page
    if spec.get("within"):
        scope = page.locator(spec["within"]).first
    elif spec.get("within_text"):
        scope = page.locator("li, article, section, .mip-card", has_text=spec["within_text"]).last
    if spec.get("button", "").startswith("^Investigate"):
        scope.get_by_text("Advanced investigation controls", exact=True).click()
    button = scope.get_by_role("button", name=re.compile(spec["button"])).first
    button.wait_for(state="visible", timeout=15000)
    method, api = spec.get("method", "POST"), spec["api"]
    with page.expect_response(lambda r: r.request.method == method and api in r.url, timeout=15000) as info:
        button.click()
    response = info.value
    try:
        body = response.json()
    except Exception:
        body = response.text()
    page.wait_for_timeout(300)
    browser.close()

print(json.dumps({"status": response.status, "body": body, "errors": errors}))
