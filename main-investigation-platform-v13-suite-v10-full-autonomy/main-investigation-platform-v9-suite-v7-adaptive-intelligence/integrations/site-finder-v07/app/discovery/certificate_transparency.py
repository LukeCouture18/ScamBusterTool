"""
Certificate Transparency (CT) log discoverer, via crt.sh.

Why this is a strong signal for "recently created suspicious crypto sites":
every publicly-trusted TLS certificate is logged in append-only, publicly
auditable CT logs the moment it's issued (this is a CA/Browser Forum
requirement, not an opt-in). crt.sh provides a free, no-API-key search over
this data. A domain whose *certificate subject* contains a scam-relevant
keyword (e.g. "usdt-invest", "cloudmining", "binance-support") and was issued
very recently is a much stronger, more specific signal than a generic web
search, and costs nothing to query.

This is entirely passive: crt.sh is a public read-only search service, we
make simple GET requests to it, and we self-rate-limit rather than hammering
it (see CRT_SH_REQUEST_DELAY_SECONDS in config.py).
"""
import datetime
import logging
import time

import requests

from app.config import (
    DISCOVERY_KEYWORDS, CRT_SH_BASE_URL, CRT_SH_TIMEOUT_SECONDS,
    CRT_SH_MAX_QUERIES_PER_RUN, CRT_SH_REQUEST_DELAY_SECONDS, USER_AGENT,
)
from app.discovery.base import Discoverer, DiscoveryCandidate

logger = logging.getLogger("scamhunter.discovery.crt_sh")

HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}

# Recently-issued certs are the interesting signal ("recently created suspicious
# crypto sites"); crt.sh returns entry_timestamp per certificate, which we use
# to boost confidence for genuinely new domains rather than long-standing ones
# that merely happen to contain a keyword.
RECENT_DAYS_HIGH_CONFIDENCE = 14
RECENT_DAYS_MEDIUM_CONFIDENCE = 60

# crt.sh matches domain names, not full phrases with spaces — map each
# category to a short, domain-plausible fragment to search for.
CATEGORY_DOMAIN_FRAGMENTS = {
    "investment_platform": "invest",
    "trading_platform": "trading",
    "fake_exchange": "exchange",
    "fake_wallet": "wallet-recovery",
    "cloud_mining": "cloudmining",
    "usdt_deposit": "usdt-invest",
    "pig_butchering": "invest-mentor",
}


def _query_crt_sh(keyword: str) -> list:
    """
    crt.sh's identity search (%keyword%) matches against the certificate's
    subject/SAN entries. We search for the keyword with wildcards on both
    sides so it matches anywhere in the domain (subdomains included).
    """
    params = {"q": f"%{keyword.replace(' ', '')}%", "output": "json"}
    try:
        resp = requests.get(CRT_SH_BASE_URL, params=params, headers=HEADERS,
                             timeout=CRT_SH_TIMEOUT_SECONDS)
        resp.raise_for_status()
        if not resp.text.strip():
            return []
        return resp.json()
    except requests.exceptions.RequestException as e:
        logger.warning("crt.sh query failed for keyword %r: %s", keyword, e)
        return []
    except ValueError as e:
        # crt.sh occasionally returns malformed/truncated JSON under load; treat
        # as "no results this time" rather than crashing the whole discoverer.
        logger.warning("crt.sh returned unparseable JSON for keyword %r: %s", keyword, e)
        return []


def _entry_age_days(entry: dict) -> float | None:
    ts = entry.get("entry_timestamp") or entry.get("not_before")
    if not ts:
        return None
    try:
        # crt.sh timestamps look like "2026-09-10T12:34:56"
        parsed = datetime.datetime.fromisoformat(ts.replace("Z", "").split(".")[0])
        age = (datetime.datetime.utcnow() - parsed).total_seconds() / 86400
        return max(0.0, age)
    except (ValueError, TypeError):
        return None


def _confidence_for_age(age_days: float | None) -> tuple:
    if age_days is None:
        return 0.4, ""
    if age_days <= RECENT_DAYS_HIGH_CONFIDENCE:
        return 0.75, f", certificate issued {age_days:.0f} days ago (very recent)"
    if age_days <= RECENT_DAYS_MEDIUM_CONFIDENCE:
        return 0.55, f", certificate issued {age_days:.0f} days ago"
    return 0.35, f", certificate issued {age_days:.0f} days ago (established)"


class CertificateTransparencyDiscoverer(Discoverer):
    name = "certificate_transparency"
    max_candidates_per_run = 150

    def __init__(self, keyword_groups: dict | None = None):
        self.keyword_groups = keyword_groups or DISCOVERY_KEYWORDS

    def discover(self) -> list:
        candidates = []
        seen_domains_this_run = set()
        queries_made = 0

        for category in self.keyword_groups:
            if queries_made >= CRT_SH_MAX_QUERIES_PER_RUN:
                break
            fragment = CATEGORY_DOMAIN_FRAGMENTS.get(category, "")
            if not fragment:
                continue

            entries = _query_crt_sh(fragment)
            queries_made += 1
            time.sleep(CRT_SH_REQUEST_DELAY_SECONDS)

            for entry in entries:
                if len(candidates) >= self.max_candidates_per_run:
                    return candidates
                name_value = entry.get("name_value", "")
                for raw_domain in name_value.split("\n"):
                    domain = raw_domain.strip().lower().lstrip("*.")
                    if not domain or " " in domain or domain in seen_domains_this_run:
                        continue
                    seen_domains_this_run.add(domain)

                    age_days = _entry_age_days(entry)
                    confidence, age_note = _confidence_for_age(age_days)

                    candidates.append(DiscoveryCandidate(
                        url=f"https://{domain}",
                        confidence=confidence,
                        reason=(
                            f"Certificate Transparency log match: domain contains "
                            f"'{fragment}' (category: {category}){age_note}"
                        ),
                        category=category,
                    ))

        return candidates
