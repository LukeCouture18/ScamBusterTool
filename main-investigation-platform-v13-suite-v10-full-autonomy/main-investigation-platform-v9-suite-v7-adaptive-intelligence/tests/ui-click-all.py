"""Interaction sweep: every page of the real app tree, every control on it, actually activated.

Driven by tests/suite-workflow.mjs against the Main instance and data it just built, with the UI of
tests/ui/build-all.mjs (route table generated from app/**/page.tsx, served when the cookie
mip_ui=all is set, so direct navigation and reloads of real paths work as in the product).

For every page (opened by direct navigation, i.e. a cold load of that URL):
  * the page renders (no 404 marker, no React error, no uncaught exception);
For every visible, enabled control on it (button, link, summary/Details/Why, tab, select,
checkbox/radio), on a freshly loaded page:
  * activating it must have an observable effect: a request, a navigation, or a DOM change;
    a control with none of these is reported as a dead click handler;
  * no console error, no uncaught exception, no failed request (network error or HTTP 5xx), no
    request to a path that does not exist (404 on /api/), no missing script/stylesheet.
External links are checked for a valid absolute URL and not followed.
Prints one JSON line: {"ok": bool, "pages": n, "controls": n, "failures": [...], "warnings": [...]}.
Without Playwright it prints {"skipped": ...}.

SUITE_URL      Main base URL
SUITE_PAGES    JSON list of concrete paths to sweep
SUITE_LIMIT    optional: at most this many controls per page (a quick pass after a restart)
"""
import json
import os
import sys
import time
from urllib.parse import urlparse

try:
    from playwright.sync_api import sync_playwright
except Exception as exc:  # pragma: no cover - depends on the machine
    print(json.dumps({"skipped": f"playwright is not installed ({exc})"}))
    sys.exit(0)

BASE = os.environ["SUITE_URL"].rstrip("/")
PAGES = json.loads(os.environ["SUITE_PAGES"])
LIMIT = int(os.environ.get("SUITE_LIMIT") or 0)
HOST = urlparse(BASE).netloc
SITE = os.environ.get("SUITE_SITE", "example.test")

CONTROLS = ("button, a[href], summary, select, [role=tab], [role=button], [role=menuitem], "
            "input[type=checkbox], input[type=radio]")

# Enumerates visible, enabled controls in DOM order with a label that identifies them again after a reload.
ENUMERATE = """(sel) => {
  const out = [];
  const seen = new Map();
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('[inert]')) continue;
    if ([...function*(p){while(p){if(p.tagName==='DETAILS')yield p;p=p.parentElement;}}(el.parentElement)].some(d=>!d.open&&d.querySelector(':scope > summary')!==el)) continue;
    const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const key = el.tagName + '|' + text + '|' + (el.getAttribute('href') || '');
    const n = seen.get(key) || 0; seen.set(key, n + 1);
    out.push({tag: el.tagName.toLowerCase(), text, href: el.getAttribute('href'), target: el.getAttribute('target'),
              type: el.getAttribute('type'), key, nth: n, options: el.tagName === 'SELECT' ? [...el.options].map(o => o.value) : null,
              value: el.value ?? null,
              // already in the state a click would put it in: a selected tab, the current page's link, a pressed toggle
              active: el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true' ||
                      !!el.getAttribute('aria-current') || /(^|\s)(active|on|selected)(\s|$)/.test(el.className || '') ||
                      (el.tagName === 'A' && el.href && el.href.split('#')[0] === location.href.split('#')[0])});
  }
  return out;
}"""

FIND = """([sel, key, nth]) => {
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('[inert]')) continue;
    if ([...function*(p){while(p){if(p.tagName==='DETAILS')yield p;p=p.parentElement;}}(el.parentElement)].some(d=>!d.open&&d.querySelector(':scope > summary')!==el)) continue;
    const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    if (el.tagName + '|' + text + '|' + (el.getAttribute('href') || '') !== key) continue;
    if (n++ === nth) {
      el.setAttribute('data-sweep-target', '1');
      // active now (state can differ from the first load: e.g. a site put in context by an earlier click)
      return {active: el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true' ||
              !!el.getAttribute('aria-current') || /(^|\\s)(active|on|selected)(\\s|$)/.test(el.className || '') ||
              (el.tagName === 'A' && !!el.href && el.href.split('#')[0] === location.href.split('#')[0])};
    }
  }
  return null;
}"""

FILL_FORM = """(value) => {
  const el = document.querySelector('[data-sweep-target="1"]');
  const form = el && el.closest('form');
  const submits = el && (el.tagName === 'BUTTON' ? (el.getAttribute('type') || 'submit') === 'submit' : el.type === 'submit');
  if (!form || !submits) return 0;
  let n = 0;
  for (const input of form.querySelectorAll('input:not([type]), input[type=text], input[type=search], input[type=url], textarea')) {
    if (input.value) continue;
    const setter = Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
    setter.call(input, value); input.dispatchEvent(new Event('input', {bubbles: true})); n++;
  }
  return n;
}"""

WATCH = """() => { window.__sweepMutations = 0; if (window.__sweepObserver) window.__sweepObserver.disconnect();
  window.__sweepObserver = new MutationObserver(list => { window.__sweepMutations += list.length; });
  window.__sweepObserver.observe(document.body, {subtree: true, childList: true, attributes: true, characterData: true}); }"""

failures, warnings = [], []
stats = {"pages": 0, "controls": 0, "clicked": 0, "external_links": 0}


def launch(pw):
    try:
        return pw.chromium.launch(headless=True)
    except Exception:
        return pw.chromium.launch(headless=True, executable_path="/opt/pw-browsers/chromium")


def settle(page, ms=250):
    try:
        page.wait_for_load_state("networkidle", timeout=4000)
    except Exception:
        pass
    page.wait_for_timeout(ms)


with sync_playwright() as pw:
    try:
        browser = launch(pw)
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"skipped": f"no Chromium available ({exc})"}))
        sys.exit(0)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    context.add_cookies([{"name": "mip_ui", "value": "all", "url": BASE}])
    page = context.new_page()
    page.on("dialog", lambda d: d.dismiss())

    events = {"requests": [], "console": [], "errors": [], "failed": [], "bad": []}

    def on_request(req):
        events["requests"].append((req.method, urlparse(req.url).netloc, urlparse(req.url).path))

    def on_response(resp):
        u = urlparse(resp.url)
        if u.netloc != HOST:
            return
        if resp.status >= 500 or (resp.status == 404 and (u.path.startswith("/api/") or u.path.startswith("/__ui/"))):
            events["bad"].append(f"{resp.request.method} {u.path} -> {resp.status}")

    page.on("request", on_request)
    page.on("response", on_response)
    page.on("requestfailed", lambda r: events["failed"].append(f"{r.method} {urlparse(r.url).path}: {r.failure}") if urlparse(r.url).netloc == HOST else None)
    page.on("console", lambda m: events["console"].append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: events["errors"].append(str(e)))

    def reset_events():
        for k in events:
            events[k].clear()

    def problems(where, navigated=False):
        failed=[]
        for f in events["failed"]:
            if navigated and f.startswith('GET /api/v1/') and f.endswith('net::ERR_ABORTED'):
                warnings.append({"where":where,"note":"Read request cancelled when its page navigated away: "+f})
            else:
                failed.append(f)
        found = [f"console error: {c}" for c in events["console"]] + [f"exception: {e}" for e in events["errors"]] + \
                [f"request failed: {f}" for f in failed] + [f"bad response: {b}" for b in events["bad"]]
        for p in found:
            failures.append({"where": where, "problem": p[:400]})
        return bool(found)

    def open_page(path):
        reset_events()
        page.goto(BASE + path, wait_until="domcontentloaded")
        settle(page, 400)
        page.evaluate("() => document.querySelectorAll('details').forEach(d => d.open = true)")

    for path in PAGES:
        stats["pages"] += 1
        open_page(path)
        rendered = page.evaluate("() => ({notFound: !!document.querySelector('[data-not-found]'), text: document.body.innerText.length, root: document.getElementById('root')?.children.length || 0})")
        if rendered["notFound"] or rendered["root"] == 0 or rendered["text"] < 40:
            failures.append({"where": path, "problem": f"page did not render: {rendered}"})
            continue
        if page.evaluate("() => window.__MIP_RENDER__") != "hydrate":
            failures.append({"where": path, "problem": "page was not server-rendered and hydrated"})
        else:
            stats["hydrated"] = stats.get("hydrated", 0) + 1
        problems(f"{path} (load)")
        # Reload keeps the same page (refresh of a deep link).
        reset_events()
        page.reload(wait_until="domcontentloaded")
        settle(page, 300)
        if page.evaluate("() => !!document.querySelector('[data-not-found]')"):
            failures.append({"where": path, "problem": "reload lost the page"})
        problems(f"{path} (reload)")
        page.evaluate("() => document.querySelectorAll('details').forEach(d => d.open = true)")
        controls = page.evaluate(ENUMERATE, CONTROLS)
        print(f"SWEEP {path}: {len(controls)} controls", file=sys.stderr, flush=True)
        if LIMIT:
            controls = controls[:LIMIT]
        stats["controls"] += len(controls)
        for c in controls:
            label = f"{path} :: {c['tag']} '{c['text'] or c['href'] or '?'}'" + (f" #{c['nth'] + 1}" if c["nth"] else "")
            href = c.get("href") or ""
            if c["tag"] == "a" and href:
                target = urlparse(href)
                if target.scheme in ("http", "https") and target.netloc and target.netloc != HOST:
                    stats["external_links"] += 1
                    if not target.netloc or " " in href:
                        failures.append({"where": label, "problem": f"invalid external link {href}"})
                    continue
                if href.startswith("mailto:") or href.startswith("tel:"):
                    continue
            open_page(path)
            found = page.evaluate(FIND, [CONTROLS, c["key"], c["nth"]])
            if found:
                c["active"] = found["active"]
            if not found:
                warnings.append({"where": label, "note": "control not present after a fresh load (content changed by an earlier click)"})
                continue
            el = page.locator("[data-sweep-target='1']").first
            # A submit button acts on its form: give empty text fields a real value first (a known site).
            filled = page.evaluate(FILL_FORM, SITE)
            # Quiet window: what the page does on its own (polling, timers), so a click's effect is
            # judged against it rather than credited with background activity.
            page.evaluate(WATCH)
            reset_events()
            page.wait_for_timeout(700)
            noise_mut = page.evaluate("() => window.__sweepMutations || 0")
            noise_req = {r for r in events["requests"] if r[1] == HOST}
            page.evaluate(WATCH)
            before_url = page.url
            reset_events()
            try:
                if c["tag"] == "select":
                    options = [o for o in (c["options"] or []) if o != c["value"]]
                    if not options:
                        warnings.append({"where": label, "note": "select with a single option"})
                        continue
                    el.select_option(options[0], timeout=4000)
                elif c["type"] in ("checkbox", "radio"):
                    el.click(timeout=4000)
                else:
                    el.click(timeout=4000, no_wait_after=True)
            except Exception as exc:
                failures.append({"where": label, "problem": f"could not activate: {str(exc).splitlines()[0][:200]}"})
                continue
            settle(page, 500)
            stats["clicked"] += 1
            mutated = 0
            try:
                mutated = page.evaluate("() => window.__sweepMutations || 0")
            except Exception:
                mutated = -1          # the page navigated away: that is an effect
            navigated = page.url != before_url
            new_requests = {r for r in events["requests"] if r[1] == HOST} - noise_req
            # A controlled form choice changes its rendered value, which is a DOM
            # property rather than a MutationObserver attribute/request/navigation.
            changed_value = c["tag"] == "select" and not navigated and el.input_value() != c["value"]
            if noise_mut and not (navigated or new_requests):
                # The page changes by itself: a DOM change alone cannot be attributed to the click.
                if mutated <= noise_mut:
                    warnings.append({"where": label, "note": f"page updates on its own ({noise_mut} changes idle vs {mutated} after the click); effect not isolated"})
            elif not (mutated or navigated or new_requests or changed_value):
                if c.get("active"):
                    stats["already_active"] = stats.get("already_active", 0) + 1   # selected tab / current page: no change is correct
                else:
                    failures.append({"where": label, "problem": "dead control: no request, no navigation and no change on the page"})
            problems(label,navigated=navigated)
            if navigated and urlparse(page.url).netloc == HOST and page.evaluate("() => !!document.querySelector('[data-not-found]')"):
                failures.append({"where": label, "problem": f"navigates to a page that does not exist: {urlparse(page.url).path}"})
    browser.close()

print(json.dumps({"ok": not failures, **stats, "failures": failures, "warnings": warnings}))
