"""
Domain-age lookup used as an additional ranking signal: brand-new domains are
disproportionately likely to be scam sites (they get burned and replaced
constantly), so a domain registered in the last few weeks is worth bumping up
the investigation queue.

Uses the `python-whois` package if installed; if it's missing, or a WHOIS
lookup fails/times out/is rate-limited (common for many registrars), this
degrades gracefully to "unknown" rather than blocking the ranking pipeline.
WHOIS lookups are also cached in-memory per run since re-querying the same
registrar repeatedly is slow and can get you rate-limited.
"""
import datetime
import logging

logger = logging.getLogger("scamhunter.domain_age")

try:
    import whois as _whois_lib
    HAVE_WHOIS = True
except ImportError:
    HAVE_WHOIS = False
    logger.info("python-whois not installed; domain-age scoring will be skipped. "
                "Install with: pip install python-whois")

_cache: dict[str, "int | None"] = {}


def _first_of(value):
    """python-whois sometimes returns a list of dates for creation_date; take the earliest."""
    if isinstance(value, list):
        value = min(v for v in value if v is not None) if value else None
    return value


def domain_age_days(domain: str) -> int | None:
    """Returns age in days, or None if unavailable (missing lib, lookup failure, no data)."""
    if not HAVE_WHOIS:
        return None
    if domain in _cache:
        return _cache[domain]

    try:
        result = _whois_lib.whois(domain)
        created = _first_of(getattr(result, "creation_date", None))
        if created is None:
            _cache[domain] = None
            return None
        if isinstance(created, str):
            # Some registrars return raw strings instead of datetime objects.
            created = datetime.datetime.fromisoformat(created.replace("Z", "+00:00"))
        if created.tzinfo is not None:
            created = created.replace(tzinfo=None)
        age = (datetime.datetime.utcnow() - created).days
        _cache[domain] = age
        return age
    except Exception as e:
        logger.debug("WHOIS lookup failed for %s: %s", domain, e)
        _cache[domain] = None
        return None


def domain_age_score(domain: str) -> tuple[float, str | None]:
    """
    Returns (score_delta, reason) for use by the ranker. Newer domains score higher;
    domains older than ~1 year get no bonus (established sites can still be scams,
    but age alone isn't a signal there — other heuristics should catch them).
    """
    age = domain_age_days(domain)
    if age is None:
        return 0.0, None
    if age <= 7:
        return 3.0, f"domain_registered_{age}d_ago"
    if age <= 30:
        return 2.0, f"domain_registered_{age}d_ago"
    if age <= 90:
        return 1.0, f"domain_registered_{age}d_ago"
    return 0.0, None
