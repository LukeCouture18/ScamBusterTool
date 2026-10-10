"""
Threat-intelligence matching.

Two layers, both safe to run with no API keys:

1. INTERNAL intel — the strongest and most reliable source here, because it's
   built from what this tool has already confirmed itself. If a wallet address
   on this site was previously seen on a site you already approved as a scam,
   that's a direct, evidenced match, not a third-party guess.

2. EXTERNAL feeds — an optional, user-supplied list of public blocklists
   (domain lists / wallet-address lists) in data/threat_feeds.txt. Ships empty
   by default: you add feeds you trust. Entirely passive, plain GETs, cached
   per-run so a big batch doesn't re-download the same list repeatedly.
"""
import logging
import time

import requests

from app import db
from app.config import DATA_DIR, USER_AGENT

logger = logging.getLogger("scamhunter.analysis.threat_intel")

FEEDS_FILE = DATA_DIR / "threat_feeds.txt"
FEED_TIMEOUT_SECONDS = 15
FEED_CACHE_TTL_SECONDS = 3600

DEFAULT_FEEDS_CONTENT = """\
# Threat-intelligence feeds, one URL per line. Lines starting with # are ignored.
#
# Each feed should be a plain-text list with one indicator per line — either
# domains or wallet addresses. The matcher checks both, so a mixed list is fine.
#
# Ships empty on purpose: verify a feed's trustworthiness and licensing before
# pointing this tool at it. Examples of the kind of source that fits here are
# community-maintained scam-domain blocklists and published scam-wallet lists.
"""

_feed_cache = {"fetched_at": 0.0, "indicators": set()}


def _ensure_feeds_file():
    if not FEEDS_FILE.exists():
        FEEDS_FILE.parent.mkdir(parents=True, exist_ok=True)
        FEEDS_FILE.write_text(DEFAULT_FEEDS_CONTENT, encoding="utf-8")


def _feed_urls() -> list:
    _ensure_feeds_file()
    urls = []
    for line in FEEDS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            urls.append(line)
    return urls


def _load_external_indicators() -> set:
    """Fetches and caches all configured feeds. Failures are logged, not raised."""
    now = time.time()
    if _feed_cache["indicators"] and (now - _feed_cache["fetched_at"]) < FEED_CACHE_TTL_SECONDS:
        return _feed_cache["indicators"]

    indicators = set()
    for url in _feed_urls():
        try:
            resp = requests.get(url, headers={"User-Agent": USER_AGENT},
                                 timeout=FEED_TIMEOUT_SECONDS)
            resp.raise_for_status()
            for line in resp.text.splitlines():
                line = line.strip().lower()
                if line and not line.startswith("#"):
                    indicators.add(line)
        except requests.exceptions.RequestException as e:
            logger.warning("Threat feed unreachable (%s): %s", url, e)

    _feed_cache["indicators"] = indicators
    _feed_cache["fetched_at"] = now
    return indicators


def _check_internal(domain: str, wallet_addresses: list) -> list:
    """
    Matches against what this tool has already confirmed — the highest-quality
    signal available, since it's evidence we collected and a human approved.
    """
    hits = []

    for address in wallet_addresses:
        with db.get_conn() as conn:
            rows = conn.execute(
                """SELECT DISTINCT s.domain, f.review_status
                   FROM wallets w
                   JOIN wallet_sightings ws ON ws.wallet_id = w.id
                   JOIN sites s ON s.id = ws.site_id
                   LEFT JOIN findings f ON f.site_id = s.id
                   WHERE lower(w.address) = lower(?) AND s.domain != ?""",
                (address, domain),
            ).fetchall()
        approved = [r["domain"] for r in rows if r["review_status"] == "approved"]
        others = [r["domain"] for r in rows]
        if approved:
            hits.append({
                "source": "internal:confirmed_scam_wallet",
                "verdict": "malicious",
                "detail": (f"Wallet {address} was already confirmed on approved scam site(s): "
                           f"{', '.join(sorted(set(approved))[:5])}"),
            })
        elif others:
            hits.append({
                "source": "internal:wallet_reuse",
                "verdict": "suspicious",
                "detail": (f"Wallet {address} also appears on {len(set(others))} other "
                           f"site(s) in this database: {', '.join(sorted(set(others))[:5])}"),
            })

    with db.get_conn() as conn:
        row = conn.execute(
            """SELECT f.review_status FROM findings f
               JOIN sites s ON s.id = f.site_id
               WHERE s.domain = ? AND f.review_status = 'approved' LIMIT 1""",
            (domain,),
        ).fetchone()
    if row:
        hits.append({
            "source": "internal:previously_approved",
            "verdict": "malicious",
            "detail": f"{domain} was previously reviewed and approved as a scam in this database",
        })

    return hits


def check_threat_intel(domain: str, wallet_addresses: list = None) -> list:
    """
    Returns a list of {"source", "verdict", "detail"} matches.
    verdict is one of: malicious, suspicious, clean.
    Always returns a list; never raises.
    """
    wallet_addresses = wallet_addresses or []
    results = []

    try:
        results.extend(_check_internal(domain, wallet_addresses))
    except Exception as e:
        logger.warning("Internal threat-intel check failed for %s: %s", domain, e)

    try:
        external = _load_external_indicators()
    except Exception as e:
        logger.warning("External threat feeds failed to load: %s", e)
        external = set()

    if external:
        if domain.lower() in external:
            results.append({
                "source": "external_feed", "verdict": "malicious",
                "detail": f"{domain} appears on a configured threat feed",
            })
        for address in wallet_addresses:
            if address.lower() in external:
                results.append({
                    "source": "external_feed", "verdict": "malicious",
                    "detail": f"Wallet {address} appears on a configured threat feed",
                })
    else:
        results.append({
            "source": "external_feed", "verdict": "clean",
            "detail": ("No external threat feeds configured (add them to "
                       "data/threat_feeds.txt); internal checks still applied"),
        })

    return results
