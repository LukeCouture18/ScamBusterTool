"""
Similar-domains pivot discoverer.

Given a seed (either a known scam domain we've already found, or a well-known
crypto brand name), generates plausible typosquat/permutation variants and
checks which ones actually resolve in DNS — a resolving variant is a strong
signal someone registered it on purpose, since these aren't real words.

This is a PIVOT discoverer: it takes what we already know (scam domains found
by other sources, or the configured brand list) and uses it to find MORE
candidates, per the "similar domains" requirement.

Passive and respectful: DNS resolution is a standard, lightweight lookup (not
an HTTP request to the target), and we cap both the number of variants
generated per seed and the total DNS checks per run.
"""
import logging
import socket

from app.config import (
    KNOWN_CRYPTO_BRANDS, SIMILAR_DOMAIN_MAX_VARIANTS_PER_SEED,
    SIMILAR_DOMAIN_MAX_DNS_CHECKS_PER_RUN, SIMILAR_DOMAIN_TLDS_TO_TRY,
)
from app.discovery.base import PivotDiscoverer, DiscoveryCandidate

logger = logging.getLogger("scamhunter.discovery.similar_domains")

KEYBOARD_ADJACENT = {
    "a": "qsz", "b": "vghn", "c": "xdfv", "d": "serfcx", "e": "wsdr",
    "f": "drtgvc", "g": "ftyhbv", "h": "gyujnb", "i": "ujko", "j": "huikmn",
    "k": "jiolm", "l": "kop", "m": "njk", "n": "bhjm", "o": "iklp",
    "p": "ol", "q": "wa", "r": "edft", "s": "awedxz", "t": "rfgy",
    "u": "yhji", "v": "cfgb", "w": "qesa", "x": "zsdc", "y": "tghu", "z": "asx",
}


def domain_root(domain_or_brand: str) -> str:
    """Extracts a bare root name (no TLD, no www.) to permute from."""
    name = domain_or_brand.lower().strip()
    name = name.split("://")[-1]
    name = name.split("/")[0]
    if name.startswith("www."):
        name = name[4:]
    # Drop the TLD (everything after the last dot) if present.
    if "." in name:
        name = name.rsplit(".", 1)[0]
    return name


def generate_variants(root: str, max_variants: int = SIMILAR_DOMAIN_MAX_VARIANTS_PER_SEED) -> list:
    """
    Generates typosquat-style permutations of a root domain name:
    character omission, doubling, adjacent-key substitution, transposition,
    and common scam-suffix/prefix additions (a pig-butchering/impersonation
    favorite: "binance-support", "coinbase-app", etc).
    """
    variants = set()
    n = len(root)

    # Omission: drop one character
    for i in range(n):
        variants.add(root[:i] + root[i + 1:])

    # Doubling: repeat one character
    for i in range(n):
        variants.add(root[:i] + root[i] + root[i:])

    # Adjacent-key substitution (classic fat-finger typosquat)
    for i, ch in enumerate(root):
        for adj in KEYBOARD_ADJACENT.get(ch, ""):
            variants.add(root[:i] + adj + root[i + 1:])

    # Transposition: swap two adjacent characters
    for i in range(n - 1):
        chars = list(root)
        chars[i], chars[i + 1] = chars[i + 1], chars[i]
        variants.add("".join(chars))

    # Common scam-affix patterns (brand impersonation favorites)
    for affix in ("support", "app", "official", "login", "wallet", "secure", "help", "pro"):
        variants.add(f"{root}-{affix}")
        variants.add(f"{root}{affix}")

    variants.discard(root)  # never "find" the seed itself
    variants.discard("")
    variants = [v for v in variants if v and (v.replace("-", "").isalnum())]
    return sorted(variants)[:max_variants]


def resolves(domain: str) -> bool:
    try:
        socket.setdefaulttimeout(3)
        socket.gethostbyname(domain)
        return True
    except (socket.gaierror, socket.timeout, UnicodeError):
        return False


class SimilarDomainsDiscoverer(PivotDiscoverer):
    name = "similar_domains"
    max_candidates_per_site = 15

    def __init__(self, tlds: list | None = None,
                 max_dns_checks: int = SIMILAR_DOMAIN_MAX_DNS_CHECKS_PER_RUN,
                 resolver=resolves):
        self.tlds = tlds or SIMILAR_DOMAIN_TLDS_TO_TRY
        self.max_dns_checks = max_dns_checks
        self._resolves = resolver  # injectable for testing without real DNS
        self._dns_checks_used = 0

    def discover_from_site(self, site: dict) -> list:
        root = domain_root(site["domain"])
        if len(root) < 4:
            return []  # too short to permute meaningfully without pure noise
        return self._check_variants(root, seed_label=site["domain"], pivot_from_site_id=site["id"])

    def discover_from_brands(self) -> list:
        """Cold-start pass: check permutations of well-known crypto brand names,
        independent of anything we've already found — this is how the discoverer
        finds brand-impersonation sites even before any related scam is known."""
        candidates = []
        for brand in KNOWN_CRYPTO_BRANDS:
            if self._dns_checks_used >= self.max_dns_checks:
                break
            candidates.extend(self._check_variants(brand, seed_label=f"brand:{brand}", pivot_from_site_id=None))
        return candidates

    def _check_variants(self, root: str, seed_label: str, pivot_from_site_id) -> list:
        candidates = []
        variants = generate_variants(root)
        for variant in variants:
            if self._dns_checks_used >= self.max_dns_checks:
                break
            if len(candidates) >= self.max_candidates_per_site:
                break
            for tld in self.tlds:
                if self._dns_checks_used >= self.max_dns_checks:
                    break
                candidate_domain = f"{variant}{tld}"
                self._dns_checks_used += 1
                if self._resolves(candidate_domain):
                    candidates.append(DiscoveryCandidate(
                        url=f"http://{candidate_domain}",
                        confidence=0.55,
                        reason=(
                            f"Domain '{candidate_domain}' resolves and is a close variant "
                            f"(typosquat/permutation) of '{seed_label}'."
                        ),
                        category="brand_impersonation" if seed_label.startswith("brand:") else "",
                        pivot_from_site_id=pivot_from_site_id,
                    ))
                    break  # one resolving TLD per variant is enough signal; move to next variant
        return candidates
