"""
Browser automation core: investigates one site in an isolated browser context,
following links likely to lead to deposit/wallet/funding/investment/trading
pages, extracting wallet evidence, and recording why it made each navigation
decision — while refusing outright to cross certain lines.

HARD SAFETY RULES (enforced in code, not just prompted to Claude):
- Never submits any form that looks like a payment/checkout/crypto-send/wallet-connect
  action. FORBIDDEN_ACTION_SIGNALS below causes an immediate abort of that action.
- The moment a page shows a CAPTCHA, KYC/identity-verification, phone-verification,
  or payment-requirement wall, the ENTIRE investigation stops right there — it does
  not try another link, does not retry, does not attempt to work around it. This is
  recorded as the investigation's stop_reason so a human can see exactly what it hit.
- Never types into password fields except in the dedicated, explicitly-enabled signup
  module — and even there, stops the moment a CAPTCHA/verification/2FA element appears.
- Never clicks anything matching CAPTCHA/verification widgets or third-party wallet
  connect buttons (MetaMask, WalletConnect, Trust Wallet, etc.).
- Each browser context is fresh and isolated per site: no cookies, storage, or
  session state carries over between investigations.
- Read-only navigation by default; the signup module is only invoked when the
  caller explicitly opts in AND the page understanding confirms this is a normal
  signup form (not something already behind a CAPTCHA/verification wall).
"""
import logging
import random
import re
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout, Error as PWError

from app.config import (
    PAGE_LOAD_TIMEOUT_MS, NAV_DELAY_SECONDS, USER_AGENT, SCREENSHOT_DIR,
    MAX_PAGES_PER_INVESTIGATION, MAX_LINKS_PER_PAGE_TO_CONSIDER,
    DEEP_WALLET_HUNT_MAX_PAGES, DEEP_WALLET_HUNT_MAX_LINKS_PER_PAGE,
    WALLET_TAB_SIGNALS, WALLET_TAB_EXCLUDE_SIGNALS, POST_SIGNUP_MAX_PAGES,
)
from app.investigate.wallet_extractor import extract_wallets
from app.investigate.page_classifier import (
    classify_page_keyword, filter_interesting_links, filter_wallet_priority_links,
)
from app.investigate.page_understanding import understand_page
from app.investigate.url_utils import VisitedTracker
from app.claude_client import pick_links_to_investigate, classify_page_type
from app import db

logger = logging.getLogger("scamhunter.navigator")

# Anything matching these, anywhere in a button/link/element's text or attributes,
# means "do not click, do not submit" — no exceptions, regardless of what any
# ranking or LLM suggestion says.
FORBIDDEN_ACTION_SIGNALS = [
    "connect wallet", "metamask", "walletconnect", "trust wallet", "coinbase wallet",
    "confirm payment", "confirm transaction", "send transaction", "approve transaction",
    "sign transaction", "captcha", "verify you are human", "i'm not a robot",
    "2fa", "two-factor", "one-time code", "otp", "verification code",
    "buy now", "checkout", "pay now", "submit payment",
]

INTERNAL_LINK_ONLY = True  # never follow links off the target site's domain


def _looks_forbidden(text: str) -> bool:
    lower = (text or "").lower()
    return any(sig in lower for sig in FORBIDDEN_ACTION_SIGNALS)


def _looks_like_wallet_tab(text: str) -> bool:
    """
    True if this element's visible text looks like a currency/network tab
    switch on a deposit page (e.g. "BTC", "USDT-TRC20") rather than an action
    button. Clicking these only changes which read-only address is displayed —
    never submits, pays, connects, or sends anything — but we still exclude
    anything that ALSO matches an action word, since a button can share a
    currency name while doing something unsafe (e.g. "Buy BTC Now").
    """
    lower = (text or "").strip().lower()
    if not lower or len(lower) > 40:
        return False  # tabs are short labels; long text is prose, not a tab
    if any(sig in lower for sig in WALLET_TAB_EXCLUDE_SIGNALS):
        return False
    return any(sig in lower for sig in WALLET_TAB_SIGNALS)


def _same_domain(base_url: str, other_url: str) -> bool:
    try:
        return urlparse(base_url).netloc.split(":")[0].lstrip("www.") == \
               urlparse(other_url).netloc.split(":")[0].lstrip("www.")
    except Exception:
        return False


def _safe_filename_fragment(url: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", url)[:120]


class SiteInvestigation:
    """
    One browsing session scoped to a single site, in its own isolated browser
    context. All safety checks (access-control stop, forbidden-action filter,
    domain restriction) are enforced here, not left to the caller or to Claude.
    """

    def __init__(self, site: dict, headless: bool = True, progress_cb=None, should_stop=None,
                 allow_signup: bool = False, deep_wallet_hunt: bool = False):
        self.site = site
        self.site_id = site["id"]
        self.base_url = site["url"]
        self.headless = headless
        self.allow_signup = allow_signup
        self.deep_wallet_hunt = deep_wallet_hunt

        max_pages = DEEP_WALLET_HUNT_MAX_PAGES if deep_wallet_hunt else MAX_PAGES_PER_INVESTIGATION
        self.max_links_per_page = (
            DEEP_WALLET_HUNT_MAX_LINKS_PER_PAGE if deep_wallet_hunt else MAX_LINKS_PER_PAGE_TO_CONSIDER
        )
        self.visited = VisitedTracker(max_pages=max_pages)
        self.pages_visited = 0
        self.all_wallets_found = []
        self.pages_recorded = []
        self.stop_reason: str | None = None
        self.final_status = "completed"   # completed, blocked, error, unreachable, stopped
        self.post_signup_pages_visited = 0

        # Optional hooks for the live UI: progress_cb(event_type, data) is called at
        # key points (page visited, wallet found, etc.); should_stop() is polled
        # between pages so a Pause/Stop request from the UI can take effect promptly
        # without killing the browser mid-page-load. Both default to no-ops so the
        # navigator behaves the same way when called from the CLI or tests.
        self.progress_cb = progress_cb or (lambda event, data: None)
        self.should_stop = should_stop or (lambda: False)
        self.stopped_early = False

        self.investigation_id = db.create_investigation(self.site_id)

    # ---------- top-level run ----------

    def run(self) -> dict:
        db.set_site_status(self.site_id, "scanning")
        db.update_investigation(self.investigation_id, status="browsing", current_url=self.base_url)
        self._log_decision("navigate", f"Starting investigation at {self.base_url}", self.base_url)

        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(headless=self.headless)
                # A fresh, isolated context per site: no cookies/storage/session
                # state is shared between investigations, and nothing persists
                # after this context closes.
                context = browser.new_context(user_agent=USER_AGENT, viewport={"width": 1366, "height": 900})
                page = context.new_page()
                page.set_default_timeout(PAGE_LOAD_TIMEOUT_MS)

                try:
                    self._crawl(page, self.base_url, depth=0)
                except Exception as e:
                    logger.error("Investigation error on %s: %s", self.base_url, e)
                    self.final_status = "error"
                    self.stop_reason = f"Unexpected error: {e}"
                    self._log_decision("error", self.stop_reason, self.base_url)
                finally:
                    context.close()
                    browser.close()
        except Exception as e:
            # Browser itself failed to launch, or some other catastrophic failure —
            # this is distinct from a per-page error and still must not crash the caller.
            logger.error("Browser launch/session failure for %s: %s", self.base_url, e)
            self.final_status = "error"
            self.stop_reason = f"Browser session failure: {e}"
            self._log_decision("error", self.stop_reason, self.base_url)

        db.mark_scanned(self.site_id)

        if self.stopped_early and self.final_status == "completed":
            self.final_status = "stopped"

        db.finish_investigation(self.investigation_id, self.final_status, self.stop_reason)
        self.progress_cb("investigation_status", {
            "site_id": self.site_id, "investigation_id": self.investigation_id,
            "status": self.final_status, "stop_reason": self.stop_reason,
        })

        return {
            "investigation_id": self.investigation_id,
            "status": self.final_status,
            "stop_reason": self.stop_reason,
            "pages_visited": self.pages_visited,
            "wallets_found": len(self.all_wallets_found),
            "pages": self.pages_recorded,
            "stopped_early": self.stopped_early,
            "post_signup_pages_visited": self.post_signup_pages_visited,
            "deep_wallet_hunt": self.deep_wallet_hunt,
        }

    # ---------- crawl loop ----------

    def _crawl(self, page, url: str, depth: int):
        if self.should_stop():
            self.stopped_early = True
            return
        if self.visited.at_limit():
            self._log_decision("skip", "Reached max pages for this investigation; stopping crawl.", url)
            return
        if self.visited.already_visited(url):
            self._log_decision("skip", "Already visited this page (or an equivalent URL) — avoiding a loop.", url)
            return
        if INTERNAL_LINK_ONLY and depth > 0 and not _same_domain(self.base_url, url):
            self._log_decision("skip", "Link leads off-domain; investigation stays within the target site.", url)
            return

        self.visited.mark_visited(url)
        self.progress_cb("page_loading", {"site_id": self.site_id, "url": url})
        db.update_investigation(self.investigation_id, current_url=url, pages_visited=self.pages_visited)

        load_result = self._load_page(page, url)
        if load_result is None:
            return  # already logged/handled inside _load_page

        title, visible_text, html, final_url = load_result

        time.sleep(random.uniform(*NAV_DELAY_SECONDS))  # politeness delay
        self.pages_visited += 1

        # --- understand the page: access control, login/signup, or normal content ---
        links = self._extract_links(page, final_url)
        has_password_field = self._has_password_field(page)
        understanding = understand_page(final_url, title, visible_text, html, links, has_password_field)

        if understanding.access_control:
            self._handle_access_control_stop(page, understanding, final_url)
            return  # the ENTIRE investigation stops here, not just this branch

        if understanding.is_login_page or understanding.is_signup_page:
            self._handle_auth_page(page, understanding, final_url)
            # After a recognized login/signup page, we don't crawl further from
            # it automatically — signup (if enabled) is a terminal action for
            # this branch, and login pages offer no more useful navigation for
            # an unauthenticated researcher who won't be entering credentials.
            return

        # --- record evidence for a normal content page ---
        page_type = classify_page_keyword(final_url, title, visible_text)
        if page_type == "other":
            page_type = classify_page_type(final_url, title, visible_text)

        screenshot_path = self._screenshot(page, final_url)
        html_path = self._save_html(html, final_url)

        page_id = db.add_page(
            site_id=self.site_id, url=final_url, title=title, page_type=page_type,
            screenshot_path=str(screenshot_path), html_snapshot_path=str(html_path),
        )
        self.pages_recorded.append({"url": final_url, "type": page_type, "screenshot": str(screenshot_path)})
        self.progress_cb("page_visited", {
            "site_id": self.site_id, "url": final_url, "title": title, "page_type": page_type,
            "pages_visited": self.pages_visited, "screenshot": str(screenshot_path),
        })
        db.update_investigation(self.investigation_id, pages_visited=self.pages_visited)

        if page_type in ("deposit", "wallet", "funding", "investment", "trading"):
            self._log_decision("navigate", f"Reached a {page_type} page — recording as evidence.", final_url)

        # --- wallet extraction with dedicated per-wallet evidence ---
        self._extract_and_record_wallets(page, visible_text, html, final_url, page_id)

        # --- click through currency/network tabs on deposit-style pages to reveal
        # additional wallet addresses hidden behind a tab switch (e.g. separate
        # BTC / ETH / USDT-TRC20 / USDT-ERC20 tabs on the same deposit page) ---
        if page_type in ("deposit", "wallet", "funding") and not self.should_stop():
            self._hunt_wallet_tabs(page, final_url, page_id)

        # --- decide where to go next ---
        if self.should_stop():
            self.stopped_early = True
            return
        if self.visited.at_limit():
            return

        self._navigate_onward(page, understanding, depth)

    # ---------- page loading with redirect/timeout/dead-site handling ----------

    def _load_page(self, page, url: str):
        """
        Returns (title, visible_text, html, final_url) on success, or None if the
        page couldn't be loaded (timeout, DNS failure, connection refused, etc.) —
        in which case the failure has already been logged and recorded.
        """
        try:
            response = page.goto(url, wait_until="domcontentloaded")
        except PWTimeout:
            self._log_decision("error", "Page load timed out — site may be slow or unresponsive.", url)
            self.progress_cb("page_error", {"site_id": self.site_id, "url": url, "error": "timeout"})
            return None
        except PWError as e:
            msg = str(e)
            reason = "unreachable"
            if "ERR_NAME_NOT_RESOLVED" in msg:
                reason = "DNS resolution failed (domain doesn't resolve)"
            elif "ERR_CONNECTION_REFUSED" in msg:
                reason = "connection refused (server not accepting connections)"
            elif "ERR_CONNECTION_TIMED_OUT" in msg:
                reason = "connection timed out"
            elif "ERR_CERT" in msg or "SSL" in msg:
                reason = "SSL/certificate error"
            else:
                reason = f"navigation error: {msg[:200]}"
            self._log_decision("error", f"Could not load page: {reason}", url)
            self.progress_cb("page_error", {"site_id": self.site_id, "url": url, "error": reason})
            # If this happened on the very first page of the investigation, the
            # whole site is unreachable — mark the investigation accordingly.
            if self.pages_visited == 0:
                self.final_status = "unreachable"
                self.stop_reason = reason
            return None
        except Exception as e:
            self._log_decision("error", f"Unexpected error loading page: {e}", url)
            return None

        final_url = page.url  # reflects any redirect chain Playwright followed
        if response is not None and final_url != url:
            self._log_decision(
                "navigate", f"Site redirected {url} -> {final_url}; continuing on the redirected page.", final_url,
            )

        if response is not None and response.status >= 400:
            self._log_decision(
                "error", f"Page returned HTTP {response.status} — treating as a dead/broken page.", final_url,
            )
            self.progress_cb("page_error", {
                "site_id": self.site_id, "url": final_url, "error": f"HTTP {response.status}",
            })
            if self.pages_visited == 0:
                self.final_status = "unreachable"
                self.stop_reason = f"Site returned HTTP {response.status}"
            return None

        title = page.title()
        try:
            visible_text = page.inner_text("body")
        except Exception:
            visible_text = ""
        html = page.content()
        return title, visible_text, html, final_url

    # ---------- access control: stop, don't bypass ----------

    def _handle_access_control_stop(self, page, understanding, url: str):
        control_type = understanding.access_control
        detail = (
            f"Encountered a {control_type.replace('_', ' ')} wall "
            f"(matched signal: {understanding.access_control_detail!r}). "
            "Stopping this investigation rather than attempting to bypass it."
        )
        logger.info("Access control stop on %s: %s", url, detail)

        # Capture evidence of exactly what stopped the investigation, so a human
        # reviewer can see the access-control wall itself, not just a text note.
        screenshot_path = self._screenshot(page, url)
        db.add_page(
            site_id=self.site_id, url=url, title=understanding.title, page_type="access_control",
            screenshot_path=str(screenshot_path), html_snapshot_path="",
        )
        self.pages_recorded.append({"url": url, "type": "access_control", "screenshot": str(screenshot_path)})

        self._log_decision("stop", detail, url)
        self.final_status = "blocked"
        self.stop_reason = f"{control_type}: {understanding.access_control_detail}"
        self.progress_cb("investigation_blocked", {
            "site_id": self.site_id, "url": url, "control_type": control_type, "detail": detail,
        })

    # ---------- login/signup recognition ----------

    def _handle_auth_page(self, page, understanding, url: str):
        kind = "signup" if understanding.is_signup_page else "login"
        screenshot_path = self._screenshot(page, url)
        page_id = db.add_page(
            site_id=self.site_id, url=url, title=understanding.title, page_type=kind,
            screenshot_path=str(screenshot_path), html_snapshot_path="",
        )
        self.pages_recorded.append({"url": url, "type": kind, "screenshot": str(screenshot_path)})

        if kind == "login":
            self._log_decision(
                "login_detected",
                "Recognized this as a login page. Not entering any credentials — "
                "unauthenticated research only.",
                url,
            )
            return

        # Signup page recognized.
        if not self.allow_signup:
            self._log_decision(
                "signup_detected",
                "Recognized this as a signup page. Account registration was not enabled "
                "for this investigation, so no signup was attempted.",
                url,
            )
            return

        self._log_decision(
            "signup_attempted",
            "Recognized this as a signup page and account registration is enabled for "
            "this investigation. Attempting a normal signup; will stop immediately if "
            "any CAPTCHA or verification step appears.",
            url,
        )
        self.progress_cb("signup_starting", {"site_id": self.site_id, "url": url})
        try:
            from app.investigate.signup import attempt_signup_on_page
            result = attempt_signup_on_page(page, self.site, self.investigation_id)
            self._log_decision(
                "signup_attempted",
                f"Signup attempt result: {result['status']} — {result['detail']}",
                url,
            )
            self.progress_cb("signup_result", {"site_id": self.site_id, "url": url, "result": result})

            if result.get("status") == "success" and not self.should_stop():
                self._hunt_wallets_after_signup(page, url)
        except Exception as e:
            logger.warning("Signup attempt failed with an exception: %s", e)
            self._log_decision("error", f"Signup attempt raised an error: {e}", url)

    def _hunt_wallets_after_signup(self, page, signup_url: str):
        """
        Called ONLY after attempt_signup_on_page() itself reports a clean
        'success' result — meaning it never hit a CAPTCHA/verification wall and
        the form actually submitted. This is not a separate access attempt: it
        continues browsing whatever page the site's own signup flow already
        landed us on (typically an account dashboard), using the exact same
        safety rules as the rest of the crawl (forbidden-action filter, access-
        control stop, domain restriction, loop avoidance) — it just also treats
        this as a fresh sub-crawl with its own small page budget so it doesn't
        eat into the main investigation's budget, since a logged-in area is
        often where deposit/wallet pages actually are.
        """
        self._log_decision(
            "navigate",
            "Signup succeeded without hitting any verification wall. Continuing into the "
            "account area to look for deposit/wallet pages, using the same safety rules "
            "as the rest of this investigation.",
            page.url,
        )
        post_signup_visited = VisitedTracker(max_pages=POST_SIGNUP_MAX_PAGES)
        post_signup_visited.mark_visited(signup_url)
        self._crawl_post_signup(page, page.url, post_signup_visited)

    def _crawl_post_signup(self, page, url: str, tracker: "VisitedTracker"):
        """A small, separately-budgeted crawl reusing _crawl's per-page logic
        via the same safety checks, scoped to the post-signup account area."""
        if self.should_stop() or tracker.at_limit() or tracker.already_visited(url):
            return
        if not _same_domain(self.base_url, url):
            return
        tracker.mark_visited(url)

        load_result = self._load_page(page, url)
        if load_result is None:
            return
        title, visible_text, html, final_url = load_result
        time.sleep(random.uniform(*NAV_DELAY_SECONDS))
        self.pages_visited += 1
        self.post_signup_pages_visited += 1

        links = self._extract_links(page, final_url)
        has_password_field = self._has_password_field(page)
        understanding = understand_page(final_url, title, visible_text, html, links, has_password_field)

        if understanding.access_control:
            self._handle_access_control_stop(page, understanding, final_url)
            return

        page_type = classify_page_keyword(final_url, title, visible_text)
        if page_type == "other":
            page_type = classify_page_type(final_url, title, visible_text)

        screenshot_path = self._screenshot(page, final_url)
        html_path = self._save_html(html, final_url)
        page_id = db.add_page(
            site_id=self.site_id, url=final_url, title=title, page_type=page_type,
            screenshot_path=str(screenshot_path), html_snapshot_path=str(html_path),
        )
        self.pages_recorded.append({"url": final_url, "type": page_type, "screenshot": str(screenshot_path)})
        self.progress_cb("page_visited", {
            "site_id": self.site_id, "url": final_url, "title": title, "page_type": page_type,
            "pages_visited": self.pages_visited, "screenshot": str(screenshot_path),
        })

        self._extract_and_record_wallets(page, visible_text, html, final_url, page_id)
        if page_type in ("deposit", "wallet", "funding"):
            self._hunt_wallet_tabs(page, final_url, page_id)

        if self.should_stop() or tracker.at_limit():
            return

        candidates = filter_wallet_priority_links(links, max_links=10) or filter_interesting_links(links, max_links=10)
        for link in candidates:
            if self.should_stop() or tracker.at_limit():
                return
            href = link["href"]
            if _looks_forbidden(link.get("text", "")) or _looks_forbidden(href):
                continue
            self._crawl_post_signup(page, href, tracker)
            if self.final_status == "blocked":
                return

    # ---------- wallet extraction with evidence ----------

    def _hunt_wallet_tabs(self, page, url: str, page_id: int):
        """
        Many scam deposit pages show one currency/network's address at a time,
        switched via tabs, a dropdown, or a pill-button row (e.g. "BTC | ETH |
        USDT-TRC20 | USDT-ERC20"). A single static scrape of the page only
        catches whichever one loaded by default. This clicks through every
        matching tab-like element it can find, re-scanning for wallets after
        each click, so hidden addresses on the other tabs get caught too.

        Safety: only elements whose visible text matches WALLET_TAB_SIGNALS and
        does NOT match WALLET_TAB_EXCLUDE_SIGNALS are ever clicked (see
        _looks_like_wallet_tab). This never types into a field, never submits
        a form, and never clicks anything resembling a payment/connect/confirm
        action — it only switches which read-only address is currently shown.
        """
        try:
            raw = page.eval_on_selector_all(
                "button, [role='tab'], a, li, .tab, .nav-link, .currency-tab, .coin-tab",
                "els => els.map((e, i) => ({index: i, text: (e.innerText || '').trim()}))",
            )
        except Exception:
            return

        # De-dupe by text (many frameworks render the same tab in multiple
        # matched selectors) and cap how many we try, regardless of mode.
        seen_labels = set()
        tab_candidates = []
        for item in raw:
            text = item.get("text", "")
            if not text or text.lower() in seen_labels:
                continue
            if _looks_like_wallet_tab(text):
                seen_labels.add(text.lower())
                tab_candidates.append(text)

        if not tab_candidates:
            return

        max_tabs = 12 if self.deep_wallet_hunt else 6
        tab_candidates = tab_candidates[:max_tabs]

        self._log_decision(
            "navigate",
            f"Found {len(tab_candidates)} currency/network tab(s) on this deposit page "
            f"({', '.join(tab_candidates)}); clicking through each to reveal any addresses "
            "hidden behind a tab switch.",
            url,
        )

        for label in tab_candidates:
            if self.should_stop():
                return
            try:
                locator = page.get_by_text(label, exact=True)
                if locator.count() == 0:
                    locator = page.get_by_text(label, exact=False)
                if locator.count() == 0:
                    continue
                locator.first.click(timeout=3000)
                time.sleep(0.6)  # let any async-loaded address render
            except Exception as e:
                logger.debug("Wallet tab click failed for %r on %s: %s", label, url, e)
                continue

            try:
                visible_text = page.inner_text("body")
                html = page.content()
            except Exception:
                continue

            before_count = len(self.all_wallets_found)
            self._extract_and_record_wallets(page, visible_text, html, url, page_id)
            new_count = len(self.all_wallets_found) - before_count
            if new_count > 0:
                self._log_decision(
                    "navigate",
                    f"Clicking tab {label!r} revealed {new_count} additional wallet address(es).",
                    url,
                )

    def _extract_and_record_wallets(self, page, visible_text: str, html: str, url: str, page_id: int):
        wallets = extract_wallets(visible_text) + extract_wallets(html)
        seen_this_page = set()
        for w in wallets:
            key = (w["network"], w["address"].lower())
            if key in seen_this_page:
                continue
            seen_this_page.add(key)

            wallet_id, sighting_id = db.add_wallet_sighting(
                address=w["address"], network=w["network"], site_id=self.site_id,
                page_id=page_id, context_snippet=w["context"], confidence=w["confidence"],
            )

            if sighting_id is None:
                # Already recorded this exact wallet+page sighting before (e.g. this
                # is a re-scan of the same page after clicking a currency tab, and
                # the address was already visible before that click). Not a new find —
                # must NOT be added to all_wallets_found, or the reported wallet count
                # would balloon every time a page gets re-scanned, even though nothing
                # new was actually found (caught via a real over-counting bug during
                # deep-wallet-hunt testing: a 3-tab page reported 13 "wallets found"
                # when only 4 distinct addresses actually existed).
                continue

            self.all_wallets_found.append(w)

            # Genuinely new sighting: capture dedicated evidence for it. We try to
            # scroll the address into view first so the screenshot actually shows
            # it (rather than just whatever was visible at page-load time).
            evidence_screenshot = self._wallet_evidence_screenshot(page, w["address"], url)
            db.add_wallet_evidence(sighting_id, str(evidence_screenshot) if evidence_screenshot else "",
                                    w["context"])
            self._log_decision(
                "navigate",
                f"Found a {w['network']} wallet address on this page (confidence {w['confidence']:.1f}).",
                url,
            )

            self.progress_cb("wallet_found", {
                "site_id": self.site_id, "network": w["network"], "address": w["address"],
                "confidence": w["confidence"], "page_url": url,
            })

        if self.all_wallets_found:
            db.update_investigation(self.investigation_id, wallets_found=len(self.all_wallets_found))

    def _wallet_evidence_screenshot(self, page, address: str, url: str) -> Path | None:
        """
        Best-effort: try to scroll the wallet address into view before screenshotting,
        so the evidence actually shows the address rather than the top of the page.
        Falls back to a normal viewport screenshot if the address text can't be
        located as a DOM text node (e.g. it was rendered inside an image/canvas).
        """
        try:
            locator = page.get_by_text(address, exact=False)
            if locator.count() > 0:
                locator.first.scroll_into_view_if_needed(timeout=3000)
                time.sleep(0.3)
        except Exception:
            pass  # fall through to a plain screenshot below; still useful evidence

        safe_name = _safe_filename_fragment(url)
        addr_fragment = re.sub(r"[^a-zA-Z0-9]+", "", address)[:16]
        path = SCREENSHOT_DIR / f"site{self.site_id}_wallet_{addr_fragment}_{safe_name}_{int(time.time())}.png"
        try:
            page.screenshot(path=str(path))  # viewport screenshot, not full_page, to show the scrolled-to spot
            return path
        except Exception as e:
            logger.warning("Wallet evidence screenshot failed for %s: %s", address, e)
            return None

    # ---------- onward navigation ----------

    def _navigate_onward(self, page, understanding, depth: int):
        links = understanding.links
        if self.deep_wallet_hunt:
            # Prioritize links that specifically look like they lead to a deposit
            # address (narrower word list) over general finance-adjacent content,
            # so the larger page budget in this mode is spent productively.
            candidates = filter_wallet_priority_links(links, max_links=self.max_links_per_page)
            if not candidates:
                candidates = filter_interesting_links(links, max_links=self.max_links_per_page)
        else:
            candidates = filter_interesting_links(links)[:self.max_links_per_page]

        if not candidates:
            self._log_decision(
                "navigate",
                "No links on this page looked relevant to deposit/wallet/funding/investment/trading content.",
                understanding.url,
            )
            return

        page_context = f"page_type_hint=other; login={understanding.is_login_page}; signup={understanding.is_signup_page}"
        claude_picks = pick_links_to_investigate(understanding.url, candidates, page_context=page_context)

        if claude_picks:
            self._log_decision(
                "navigate",
                "Claude selected " + str(len(claude_picks)) + " link(s) to follow: " +
                "; ".join(f"{p['text']!r} ({p['reason']})" for p in claude_picks if p.get("reason")),
                understanding.url,
            )
            next_links = claude_picks
        else:
            fallback_count = self.max_links_per_page if self.deep_wallet_hunt else 5
            next_links = candidates[:fallback_count]
            self._log_decision(
                "navigate",
                f"Falling back to keyword-based link selection: {len(next_links)} candidate(s) queued.",
                understanding.url,
            )

        for link in next_links:
            if self.should_stop():
                self.stopped_early = True
                return
            href = link["href"]
            if _looks_forbidden(link.get("text", "")) or _looks_forbidden(href):
                self._log_decision(
                    "skip",
                    f"Skipping link {link.get('text', '')!r} — matches a forbidden-action signal "
                    "(payment/wallet-connect/verification), never followed regardless of relevance.",
                    href,
                )
                continue
            self._crawl(page, href, depth + 1)
            if self.final_status == "blocked":
                return  # access control stop propagates up immediately, no further links tried

    # ---------- helpers: links, screenshots, html, decision logging ----------

    def _has_password_field(self, page) -> bool:
        try:
            return page.query_selector("input[type=password]") is not None
        except Exception:
            return False

    def _extract_links(self, page, base_url: str) -> list:
        try:
            raw = page.eval_on_selector_all(
                "a[href]",
                "els => els.map(e => ({text: e.innerText || e.getAttribute('aria-label') || '', href: e.href}))",
            )
        except Exception:
            return []
        results = []
        for item in raw:
            href = item.get("href", "")
            if not href or href.startswith("javascript:") or href.startswith("mailto:"):
                continue
            results.append({"text": item.get("text", "").strip()[:150], "href": href})
        return results

    def _screenshot(self, page, url: str) -> Path:
        safe_name = _safe_filename_fragment(url)
        path = SCREENSHOT_DIR / f"site{self.site_id}_{safe_name}_{int(time.time())}.png"
        try:
            page.screenshot(path=str(path), full_page=True)
        except Exception as e:
            logger.warning("Screenshot failed for %s: %s", url, e)
        return path

    def _save_html(self, html: str, url: str) -> Path:
        safe_name = _safe_filename_fragment(url)
        path = SCREENSHOT_DIR / f"site{self.site_id}_{safe_name}_{int(time.time())}.html"
        try:
            path.write_text(html, errors="ignore")
        except Exception as e:
            logger.warning("HTML save failed for %s: %s", url, e)
        return path

    def _log_decision(self, decision_type: str, detail: str, url: str = ""):
        db.log_decision(self.investigation_id, self.site_id, decision_type, detail, url)
        self.progress_cb("decision_logged", {
            "site_id": self.site_id, "investigation_id": self.investigation_id,
            "decision_type": decision_type, "detail": detail, "url": url,
        })


def investigate_site(site: dict, headless: bool = True, progress_cb=None, should_stop=None,
                      allow_signup: bool = False, deep_wallet_hunt: bool = False) -> dict:
    inv = SiteInvestigation(site, headless=headless, progress_cb=progress_cb,
                            should_stop=should_stop, allow_signup=allow_signup,
                            deep_wallet_hunt=deep_wallet_hunt)
    return inv.run()
