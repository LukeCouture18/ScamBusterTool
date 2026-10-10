"""
Shared-infrastructure pivot discoverer.

Scam operations frequently run many sites from the same hosting IP, the same
nameservers, or the same narrow IP range — reusing infrastructure is cheaper
and faster to spin up than provisioning fresh hosting per site.

Given a candidate domain (surfaced by any other discoverer) and a cache of
infrastructure fingerprints (resolved IP, and nameservers if `dnspython` is
available) for already-known scam sites, this checks whether the candidate
shares that fingerprint with a known site — a strong corroborating signal,
since it means the same operator likely controls both.

Uses only standard DNS resolution (`socket.gethostbyname`, stdlib, always
available) for the IP signal — no paid reverse-IP API required, which keeps
this fully "passive and based on public information" with no service asking
for an API key. NS-record correlation is an optional bonus that activates
automatically if `dnspython` is installed; the discoverer works without it.
"""
import logging
import socket

logger = logging.getLogger("scamhunter.discovery.shared_infra")

try:
    import dns.resolver as _dns_resolver
    HAVE_DNSPYTHON = True
except ImportError:
    HAVE_DNSPYTHON = False
    logger.info("dnspython not installed; shared-infrastructure discovery will use IP "
                "matching only (no nameserver correlation). Install with: pip install dnspython")


def resolve_ip(domain: str) -> str | None:
    try:
        socket.setdefaulttimeout(4)
        return socket.gethostbyname(domain)
    except (socket.gaierror, socket.timeout, UnicodeError):
        return None


def resolve_nameservers(domain: str) -> list:
    """Returns sorted nameserver hostnames, or [] if unavailable/lookup fails."""
    if not HAVE_DNSPYTHON:
        return []
    try:
        answers = _dns_resolver.resolve(domain, "NS", lifetime=4)
        return sorted(str(r.target).rstrip(".").lower() for r in answers)
    except Exception:
        return []


def fingerprint_domain(domain: str) -> dict:
    """A site's infrastructure fingerprint: resolved IP and (if available) nameservers."""
    return {
        "ip": resolve_ip(domain),
        "nameservers": resolve_nameservers(domain),
    }


class SharedInfrastructureDiscoverer:
    """
    Not a subclass of Discoverer/PivotDiscoverer in the "find URLs cold" sense —
    this operates as a scoring/corroboration pass the engine applies to
    candidates already surfaced by other sources, since "shared infrastructure"
    is naturally a *match against what we know* rather than a generator of new
    domains on its own. See app/discovery/engine.py for how it's wired in.
    """
    name = "shared_infrastructure"

    def __init__(self, fingerprint_fn=fingerprint_domain):
        self._fingerprint = fingerprint_fn

    def build_fingerprint_cache(self, domains: list) -> dict:
        """Resolves fingerprints for a list of known-scam domains once, up front,
        so checking many candidates against them doesn't re-resolve on every check."""
        cache = {}
        for domain in domains:
            cache[domain] = self._fingerprint(domain)
        return cache

    def check_candidate_against_known(self, candidate_domain: str, known_fingerprints: dict) -> tuple:
        """
        Given a candidate domain and a pre-built {domain: fingerprint} cache of
        already-known scam sites, checks for a shared-IP (or shared-nameserver)
        match. Returns (matched_site_domain, reason) or (None, "") if no match.
        """
        candidate_fp = self._fingerprint(candidate_domain)
        if not candidate_fp["ip"]:
            return None, ""

        for known_domain, known_fp in known_fingerprints.items():
            if known_domain == candidate_domain:
                continue
            if known_fp.get("ip") and known_fp["ip"] == candidate_fp["ip"]:
                return known_domain, f"shares hosting IP {candidate_fp['ip']} with known site '{known_domain}'"
            if (known_fp.get("nameservers") and candidate_fp["nameservers"]
                    and known_fp["nameservers"] == candidate_fp["nameservers"]):
                ns_list = ", ".join(candidate_fp["nameservers"][:2])
                return known_domain, f"shares nameservers ({ns_list}) with known site '{known_domain}'"
        return None, ""
