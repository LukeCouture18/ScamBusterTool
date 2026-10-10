"""
Ranks candidate sites so the most suspicious get investigated first.

v1 approach: cheap heuristics only need a lightweight HTTP GET (no browser),
so we can rank thousands of sites quickly before spending browser-automation
time on the top candidates. Claude can optionally be used to re-rank the top
slice using the fetched homepage text for a smarter read, but the bulk sort
is done without any LLM calls to keep this scalable and cheap.
"""
import logging
import re

import requests

from app.config import SCAM_KEYWORDS, USER_AGENT
from app.investigate.domain_age import domain_age_score
from app.db import domain_of

logger = logging.getLogger("scamhunter.ranker")

HEADERS = {"User-Agent": USER_AGENT}

SUSPICIOUS_TLDS = {".top", ".xyz", ".vip", ".live", ".cc", ".pw", ".click", ".buzz"}


def quick_fetch(url: str, timeout: int = 8):
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
        return resp.text[:200_000], resp.status_code
    except Exception as e:
        logger.debug("quick_fetch failed for %s: %s", url, e)
        return "", None


def heuristic_score(url: str, html: str) -> tuple[float, list[str]]:
    reasons = []
    score = 0.0
    lower = html.lower()

    for kw in SCAM_KEYWORDS:
        if kw in lower:
            score += 2.0
            reasons.append(f"keyword:'{kw}'")

    for tld in SUSPICIOUS_TLDS:
        if url.lower().split("?")[0].endswith(tld):
            score += 1.0
            reasons.append(f"suspicious_tld:{tld}")
            break

    # crude wallet-address presence bump (cheap regex, full extraction happens later)
    if re.search(r"0x[a-fA-F0-9]{40}", html) or re.search(r"\bT[a-km-zA-HJ-NP-Z1-9]{33}\b", html):
        score += 3.0
        reasons.append("wallet_address_present_on_homepage")

    if re.search(r"guarante|daily.{0,15}(profit|return|interest)", lower):
        score += 2.0
        reasons.append("guarantee_language")

    if "telegram" in lower and ("support" in lower or "customer service" in lower):
        score += 1.0
        reasons.append("telegram_only_support")

    if len(html.strip()) < 200:
        score += 0.5
        reasons.append("thin_content_page")

    return round(score, 2), reasons


def rank_site(site: dict) -> tuple[float, str]:
    """Fetch homepage cheaply and compute a heuristic suspicion score."""
    html, status = quick_fetch(site["url"])
    if status is None:
        # Unreachable sites are still worth a lower-priority look (could be geofenced,
        # or down temporarily) but shouldn't jump the queue.
        base_score, base_reason = 0.1, "unreachable_on_quick_fetch"
        bonus, bonus_reason = _discovery_confidence_bonus(site)
        if bonus_reason:
            return round(base_score + bonus, 2), f"{base_reason}; {bonus_reason}"
        return base_score, base_reason

    score, reasons = heuristic_score(site["url"], html)

    # Domain-age is a comparatively slow, sometimes-rate-limited lookup, so it's kept
    # as a separate optional bonus rather than baked into heuristic_score() (which
    # stays a pure, fast function safe to unit-test without network calls).
    age_bonus, age_reason = domain_age_score(domain_of(site["url"]))
    if age_reason:
        score += age_bonus
        reasons.append(age_reason)

    # A site a discoverer flagged with high confidence deserves a priority bump
    # even when the quick heuristic scan alone doesn't find strong signals —
    # e.g. a brand-new domain caught by certificate-transparency monitoring may
    # not have much content up yet, but the discovery signal itself (a cert
    # issued minutes ago for a keyword-matching domain) is already meaningful.
    disc_bonus, disc_reason = _discovery_confidence_bonus(site)
    if disc_reason:
        score += disc_bonus
        reasons.append(disc_reason)

    return round(score, 2), "; ".join(reasons) if reasons else "no_signals_found"


def _discovery_confidence_bonus(site: dict) -> tuple[float, str]:
    """
    Translates a site's discovery_confidence (0.0-1.0, set when a discoverer
    found it — see app/discovery/) into a ranking score bonus, so sites that
    were flagged with strong discovery signals (e.g. matched a known scam's
    infrastructure, or a very-recently-issued certificate) get prioritized
    appropriately rather than starting from zero like a manually-added URL.
    """
    confidence = site.get("discovery_confidence")
    if not confidence or confidence <= 0.5:
        return 0.0, ""  # 0.5 is the neutral default; only meaningfully-confident finds get a bonus
    bonus = round((confidence - 0.5) * 6, 2)  # confidence 1.0 -> +3.0, confidence 0.5 -> +0.0
    category = site.get("discovery_category") or ""
    category_note = f" ({category})" if category else ""
    return bonus, f"discovery_confidence:{confidence:.2f}{category_note}"
