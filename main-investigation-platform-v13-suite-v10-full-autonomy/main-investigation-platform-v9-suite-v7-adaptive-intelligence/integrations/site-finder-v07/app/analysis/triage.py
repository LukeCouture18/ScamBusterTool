"""
Fast triage: the quality gate between mass discovery and deep analysis.

The whole point of this stage is to be CHEAP (one lightweight HTTP GET, no
browser) so it can run across a very large discovery pool, while being STRICT
enough that only genuinely promising sites earn expensive deep analysis.

The key design decision — and the thing that delivers "quality over quantity" —
is that a site is scored on how many DISTINCT INDICATOR CATEGORIES fire, not
on raw keyword count. A page that says "investment" fifteen times trips exactly
one category and will not pass. A page that has a wallet address AND
guarantee-language AND a deposit page AND a brand-new domain trips four
categories and passes easily. This is what stops the system returning hundreds
of weak keyword-only matches.

Categories are deliberately independent signals — each one is evidence of a
different kind, so several firing together is much stronger than any one of
them firing loudly.
"""
import logging
import re

import requests

from app.config import (
    SCAM_KEYWORDS, USER_AGENT, DISCOVERY_SUSPICIOUS_TLDS,
    TRIAGE_MIN_INDICATOR_CATEGORIES, TRIAGE_MIN_SCORE, TRIAGE_TIMEOUT_SECONDS,
    TRIAGE_MAX_BYTES,
)
from app.investigate.wallet_extractor import extract_wallets

logger = logging.getLogger("scamhunter.analysis.triage")

HEADERS = {"User-Agent": USER_AGENT}

# Each entry: category -> (weight, description). Weight reflects how much that
# single category contributes to the triage score; the category COUNT is what
# gates passage, and score is used for ordering within the passing set.
CATEGORY_WEIGHTS = {
    "wallet_address": 4.0,       # a crypto address visible on the landing page
    "deposit_language": 2.5,     # deposit/recharge/top-up flows referenced
    "guarantee_language": 2.5,   # "guaranteed returns", "daily profit", etc.
    "investment_scheme": 2.0,    # tiered plans, VIP levels, referral bonuses
    "offchain_contact": 1.5,     # Telegram/WhatsApp-only "support"
    "suspicious_tld": 1.0,       # throwaway TLD commonly used for scam infra
    "brand_impersonation": 3.0,  # domain mimics a known crypto brand
    "urgency_pressure": 1.5,     # limited-time / act-now pressure language
    "fake_trust_signals": 1.5,   # fabricated licences, fake audit badges
}

DEPOSIT_PATTERNS = [
    r"\bdeposit\b", r"\brecharge\b", r"\btop[\s\-]?up\b", r"\bwithdraw", r"\bmin(?:imum)?\s+deposit\b",
]
GUARANTEE_PATTERNS = [
    r"guarantee\w*\s+(?:profit|return|income|roi)", r"daily\s+(?:profit|return|roi|income|interest)",
    r"risk[\s\-]?free", r"double\s+your", r"\b\d{1,3}\s*%\s*(?:daily|per day|weekly|monthly)\b",
]
INVESTMENT_SCHEME_PATTERNS = [
    r"\bvip\s*(?:level|tier|plan)", r"\breferral\s+bonus\b", r"\binvite\s+bonus\b",
    r"\b(?:bronze|silver|gold|platinum|diamond)\s+plan\b", r"\bmining\s+(?:plan|contract|pool)\b",
    r"\bstaking\s+(?:plan|reward)\b",
]
OFFCHAIN_CONTACT_PATTERNS = [
    r"t\.me/", r"telegram", r"wa\.me/", r"whatsapp",
]
URGENCY_PATTERNS = [
    r"limited\s+time", r"act\s+now", r"hurry", r"offer\s+ends", r"only\s+\d+\s+spots?\s+left",
    r"last\s+chance",
]
FAKE_TRUST_PATTERNS = [
    r"\bsec\s+registered\b", r"\bfca\s+regulated\b", r"government\s+licen[cs]ed",
    r"\b100%\s+(?:safe|secure|guaranteed)\b", r"fully\s+insured",
]

# Well-known crypto brand names; a domain containing one of these while NOT
# being the real domain is a strong impersonation signal.
BRAND_TOKENS = [
    "binance", "coinbase", "kraken", "metamask", "trustwallet", "bybit",
    "okx", "kucoin", "bitget", "ledger", "trezor", "bitfinex", "gemini",
]
LEGITIMATE_BRAND_DOMAINS = {
    "binance.com", "binance.us", "coinbase.com", "kraken.com", "metamask.io",
    "trustwallet.com", "bybit.com", "okx.com", "kucoin.com", "bitget.com",
    "ledger.com", "trezor.io", "bitfinex.com", "gemini.com",
}


def _any_pattern(patterns, text) -> str:
    """Returns the first matching pattern's matched text, or ''."""
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(0)[:80]
    return ""


def fetch_for_triage(url: str):
    """
    One cheap GET, size-capped. Returns (text, status_code) — text is '' and
    status None when unreachable. Never raises.
    """
    try:
        resp = requests.get(url, headers=HEADERS, timeout=TRIAGE_TIMEOUT_SECONDS,
                             allow_redirects=True, stream=True)
        content = resp.raw.read(TRIAGE_MAX_BYTES, decode_content=True) or b""
        text = content.decode(resp.encoding or "utf-8", errors="ignore")
        return text, resp.status_code
    except requests.exceptions.RequestException as e:
        logger.debug("Triage fetch failed for %s: %s", url, e)
        return "", None
    except Exception as e:
        logger.debug("Triage fetch unexpected error for %s: %s", url, e)
        return "", None


def evaluate_indicators(url: str, domain: str, html: str) -> list:
    """
    Pure function (no network) — returns a list of fired indicators:
    [{"category":..., "detail":..., "weight":...}]. Unit-testable directly.
    """
    indicators = []
    lower = html.lower()

    def fire(category, detail):
        indicators.append({
            "category": category,
            "detail": detail,
            "weight": CATEGORY_WEIGHTS.get(category, 1.0),
        })

    # 1. Wallet address visible on the landing page — the single strongest signal.
    wallets = extract_wallets(html)
    if wallets:
        networks = sorted({w["network"] for w in wallets})
        fire("wallet_address",
             f"{len(wallets)} crypto address(es) on landing page ({', '.join(networks)})")

    # 2. Deposit / withdrawal flow language
    hit = _any_pattern(DEPOSIT_PATTERNS, lower)
    if hit:
        fire("deposit_language", f"deposit/withdrawal flow referenced ({hit!r})")

    # 3. Guaranteed-return language
    hit = _any_pattern(GUARANTEE_PATTERNS, lower)
    if hit:
        fire("guarantee_language", f"guaranteed-return claim ({hit!r})")
    else:
        for kw in SCAM_KEYWORDS:
            if kw in lower:
                fire("guarantee_language", f"scam-phrase keyword ({kw!r})")
                break

    # 4. Tiered investment scheme structure
    hit = _any_pattern(INVESTMENT_SCHEME_PATTERNS, lower)
    if hit:
        fire("investment_scheme", f"tiered/referral scheme structure ({hit!r})")

    # 5. Off-platform contact as primary support channel
    hit = _any_pattern(OFFCHAIN_CONTACT_PATTERNS, lower)
    if hit:
        fire("offchain_contact", f"off-platform contact channel ({hit!r})")

    # 6. Throwaway TLD
    for tld in DISCOVERY_SUSPICIOUS_TLDS:
        if domain.endswith(tld):
            fire("suspicious_tld", f"domain uses throwaway TLD {tld}")
            break

    # 7. Brand impersonation in the domain itself
    if domain not in LEGITIMATE_BRAND_DOMAINS:
        for brand in BRAND_TOKENS:
            if brand in domain.replace("-", "").replace(".", ""):
                fire("brand_impersonation",
                     f"domain contains crypto brand {brand!r} but is not the official domain")
                break

    # 8. Urgency / pressure tactics
    hit = _any_pattern(URGENCY_PATTERNS, lower)
    if hit:
        fire("urgency_pressure", f"urgency/pressure language ({hit!r})")

    # 9. Fabricated trust/regulatory claims
    hit = _any_pattern(FAKE_TRUST_PATTERNS, lower)
    if hit:
        fire("fake_trust_signals", f"unverifiable regulatory/trust claim ({hit!r})")

    return indicators


def score_indicators(indicators: list) -> tuple:
    """Returns (score, distinct_category_count)."""
    categories = {ind["category"] for ind in indicators}
    score = sum(CATEGORY_WEIGHTS.get(c, 1.0) for c in categories)
    return round(score, 2), len(categories)


def triage_site(site: dict) -> dict:
    """
    Runs the full cheap triage on one site. Returns a dict describing the
    outcome — the caller persists it via db.record_triage().
    """
    url = site["url"]
    domain = site.get("domain") or ""
    html, status = fetch_for_triage(url)

    if status is None:
        return {
            "passed": False, "triage_score": 0.0, "indicator_count": 0, "indicators": [],
            "reject_reason": "Site was unreachable during triage (no response).",
            "http_status": None,
        }
    if status >= 400:
        return {
            "passed": False, "triage_score": 0.0, "indicator_count": 0, "indicators": [],
            "reject_reason": f"Site returned HTTP {status} during triage.",
            "http_status": status,
        }

    indicators = evaluate_indicators(url, domain, html)
    score, category_count = score_indicators(indicators)

    # THE QUALITY GATE: require multiple independent indicator categories AND a
    # meaningful score. One loud signal is not enough; several different kinds
    # of evidence pointing the same way is what earns deep analysis.
    passed = category_count >= TRIAGE_MIN_INDICATOR_CATEGORIES and score >= TRIAGE_MIN_SCORE

    if passed:
        reject_reason = ""
    elif category_count < TRIAGE_MIN_INDICATOR_CATEGORIES:
        fired = ", ".join(sorted({i["category"] for i in indicators})) or "none"
        reject_reason = (
            f"Only {category_count} distinct indicator category/categories fired "
            f"({fired}); need at least {TRIAGE_MIN_INDICATOR_CATEGORIES} independent "
            "signals to justify deep analysis."
        )
    else:
        reject_reason = (
            f"Triage score {score} is below the minimum of {TRIAGE_MIN_SCORE} "
            "despite enough categories firing."
        )

    return {
        "passed": passed,
        "triage_score": score,
        "indicator_count": category_count,
        "indicators": indicators,
        "reject_reason": reject_reason,
        "http_status": status,
    }
