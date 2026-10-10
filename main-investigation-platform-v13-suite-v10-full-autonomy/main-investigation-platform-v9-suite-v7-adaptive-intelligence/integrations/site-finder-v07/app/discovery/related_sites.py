"""
Related-site discovery: pivoting outward from sites we already trust.

This is discovery with a different goal to the usual kind. Ordinary discovery
asks "what other scam sites exist?"; this asks "what else is THIS operation
running?" — which produces far better leads, because the starting point is
already a confirmed high-confidence site rather than a keyword guess.

Pivots, in rough order of yield:
  - certificate SANs : one cert listing many domains means those names were
                       covered by a single issuance — a strong lead, though
                       hosts and CDNs also share certs across unrelated customers
  - reverse-IP       : other domains on the same host (bounded, since shared
                       hosting makes this noisy)
  - nameserver       : other domains on an unusual nameserver set
  - domain patterns  : sibling domains following the same naming scheme
  - wallet backtrack : any site already in our database sharing this wallet

Everything found here is recorded as a normal discovery candidate with its
pivot origin attached, so it still goes through triage and deep analysis
rather than being trusted just because of where it came from.
"""
import logging
import re
import socket

from app import db
from app.discovery.base import DiscoveryCandidate
from app.analysis.indicator_extractor import tls_cert_fingerprint

logger = logging.getLogger("scamhunter.discovery.related_sites")

MAX_SANS_PER_CERT = 40
MAX_SIBLINGS_PER_PIVOT = 25


def _resolves(domain: str) -> bool:
    try:
        socket.setdefaulttimeout(3)
        socket.gethostbyname(domain)
        return True
    except Exception:
        return False


def pivot_certificate_sans(site: dict) -> list:
    """
    Domains listed in the site's own TLS certificate. This is the single best
    pivot available: a certificate covering example-a.com and example-b.com is
    direct, publicly-verifiable evidence that one party provisioned both.
    """
    domain = site["domain"].split(":")[0]
    cert = tls_cert_fingerprint(domain)
    candidates = []

    for san in (cert.get("sans") or [])[:MAX_SANS_PER_CERT]:
        san = san.lstrip("*.").strip().lower()
        if not san or san == domain or san.endswith(".local"):
            continue
        candidates.append(DiscoveryCandidate(
            url=f"https://{san}",
            confidence=0.80,
            reason=(f"Listed as a Subject Alternative Name on the TLS certificate served by "
                    f"{domain}. That the two names share a certificate is an observed fact "
                    "read from the certificate itself. It means they were covered by one "
                    "issuance, which is worth checking — but hosting providers and CDNs also "
                    "place unrelated customers on shared certificates, so it does not by "
                    "itself indicate common ownership."),
            category="",
            pivot_from_site_id=site["id"],
        ))
    return candidates


def pivot_shared_wallet(site: dict) -> list:
    """
    Sites already in our database that share a wallet with this one. Not new
    domains, but it surfaces connections that may not have been correlated yet
    and is cheap to run.
    """
    candidates = []
    for wallet in db.wallets_for_site(site["id"]):
        for other in db.wallet_seen_elsewhere(wallet["address"], wallet["network"], site["id"]):
            candidates.append(DiscoveryCandidate(
                url=other["url"],
                confidence=0.95,
                reason=(f"Already in the database and shows the same {wallet['network']} address "
                        f"{wallet['address']} as {site['domain']}. Both sightings are observed "
                        "facts. A reused address is a strong lead, but does not by itself "
                        "establish who controls either site."),
                category="",
                pivot_from_site_id=site["id"],
            ))
    return candidates


def pivot_domain_pattern(site: dict) -> list:
    """
    Sibling domains following the same naming scheme — e.g. cryptogrow1.top
    suggests cryptogrow2.top. Only numeric-suffix and common-affix variants are
    tried, and each is DNS-checked, so this stays cheap and low-noise.
    """
    domain = site["domain"].split(":")[0]
    if "." not in domain:
        return []
    root, tld = domain.rsplit(".", 1)
    candidates = []
    tried = set()

    # Numeric sequence siblings: foo1 -> foo2, foo3...
    match = re.match(r"^(.*?)(\d{1,3})$", root)
    if match:
        stem, number = match.group(1), int(match.group(2))
        for delta in (1, 2, 3, -1):
            sibling_num = number + delta
            if sibling_num < 1:
                continue
            sibling = f"{stem}{sibling_num}.{tld}"
            if sibling in tried or sibling == domain:
                continue
            tried.add(sibling)
            if _resolves(sibling):
                candidates.append(DiscoveryCandidate(
                    url=f"http://{sibling}",
                    confidence=0.60,
                    reason=(f"Numeric sibling of {domain} following the same naming scheme, "
                            "and it resolves in DNS. Operators frequently number their fleet."),
                    category="", pivot_from_site_id=site["id"],
                ))
    else:
        # Affix siblings: foo -> foo1, foopro, foo-vip
        for suffix in ("1", "2", "pro", "vip", "官网", "app", "-official"):
            sibling = f"{root}{suffix}.{tld}"
            if sibling in tried or sibling == domain or not sibling.isascii():
                continue
            tried.add(sibling)
            if len(candidates) >= 6:
                break
            if _resolves(sibling):
                candidates.append(DiscoveryCandidate(
                    url=f"http://{sibling}",
                    confidence=0.55,
                    reason=(f"Shares the root name of {domain} with a common fleet suffix "
                            f"{suffix!r}, and it resolves in DNS."),
                    category="", pivot_from_site_id=site["id"],
                ))
    return candidates[:MAX_SIBLINGS_PER_PIVOT]


PIVOTS = {
    "certificate_sans": pivot_certificate_sans,
    "shared_wallet": pivot_shared_wallet,
    "domain_pattern": pivot_domain_pattern,
}


def discover_related_sites(min_confidence: float = 0.70, max_seeds: int = 10,
                            pivots: list = None, progress_cb=None) -> dict:
    """
    Runs every pivot against the strongest confirmed sites.

    Seeds come from high-confidence deep profiles only — pivoting from a weak
    or unconfirmed site just multiplies noise, which is exactly what this
    upgrade is meant to avoid.
    """
    progress = progress_cb or (lambda event, data: None)
    pivot_names = pivots or list(PIVOTS.keys())

    seeds = db.list_deep_profiles(min_confidence=min_confidence, limit=max_seeds)
    if not seeds:
        return {"seeds": 0, "candidates": 0, "new_sites": 0,
                "note": (f"No sites at or above {min_confidence:.0%} confidence to pivot from. "
                         "Run deep analysis first — pivoting from unconfirmed sites would "
                         "just multiply noise.")}

    total_candidates = 0
    new_sites = 0
    per_pivot = {}

    for profile in seeds:
        site = db.get_site(profile["site_id"])
        if not site:
            continue
        progress("related_discovery_seed", {"site_id": site["id"], "domain": site["domain"]})

        for name in pivot_names:
            pivot_fn = PIVOTS.get(name)
            if not pivot_fn:
                continue
            try:
                candidates = pivot_fn(site)
            except Exception as e:
                logger.warning("Pivot %s failed for %s: %s", name, site["domain"], e)
                continue

            per_pivot.setdefault(name, 0)
            for candidate in candidates:
                total_candidates += 1
                per_pivot[name] += 1
                domain = db.domain_of(candidate.url)
                already = db.domain_known(domain)

                site_id = None
                if not already:
                    site_id = db.add_site(
                        candidate.url, f"related:{name}",
                        discovery_confidence=candidate.confidence,
                        discovery_reason=candidate.reason,
                        discovery_category=candidate.category or "",
                    )
                    if site_id:
                        new_sites += 1
                        progress("site_discovered", {
                            "site_id": site_id, "url": candidate.url,
                            "source": f"related:{name}", "confidence": candidate.confidence,
                            "reason": candidate.reason,
                        })
                        db.add_timeline_event(
                            site_id, "discovered", "derived",
                            f"Found by pivoting from {site['domain']}",
                            candidate.reason, url=candidate.url,
                        )

                db.log_discovery_event(
                    url=candidate.url, source=f"related:{name}",
                    confidence=candidate.confidence, reason=candidate.reason,
                    category=candidate.category or "",
                    pivot_from_site_id=site["id"],
                    resulted_in_site_id=site_id, was_duplicate=already,
                )

    return {
        "seeds": len(seeds),
        "candidates": total_candidates,
        "new_sites": new_sites,
        "per_pivot": per_pivot,
    }
