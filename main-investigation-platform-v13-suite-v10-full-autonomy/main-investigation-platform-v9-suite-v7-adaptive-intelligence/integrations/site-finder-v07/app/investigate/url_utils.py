"""
URL normalization used to detect "have we effectively already visited this
page" even when the literal URL string differs — trailing slashes, URL
fragments (#section), and common tracking query params are all noise that
would otherwise make the navigator re-visit the same page under a slightly
different URL and think it's new territory (a loop by another name).
"""
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

# Query parameters that don't change page content and just add noise — dropped
# during normalization so ?utm_source=... variants of the same page dedupe correctly.
NOISE_QUERY_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "ref", "referrer", "session", "sid",
}


def normalize_url(url: str) -> str:
    """Canonical form of a URL for loop/dedup comparisons. Not for actual navigation."""
    try:
        parsed = urlparse(url)
    except Exception:
        return url

    netloc = parsed.netloc.lower()
    if netloc.startswith("www."):
        netloc = netloc[4:]

    path = parsed.path.rstrip("/") or "/"

    # Keep query params that aren't known tracking noise, sorted for stable comparison.
    kept_params = sorted(
        (k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
        if k.lower() not in NOISE_QUERY_PARAMS
    )
    query = urlencode(kept_params)

    # Fragments (#section) never change server-rendered content for this tool's purposes.
    return urlunparse((parsed.scheme.lower(), netloc, path, "", query, ""))


class VisitedTracker:
    """
    Tracks normalized URLs visited during one investigation, so the navigator
    can cheaply ask "have I effectively already been here" regardless of minor
    URL differences, and enforce a hard cap on total pages to guarantee
    termination even against a pathologically link-heavy or cyclic site.
    """

    def __init__(self, max_pages: int):
        self._seen: set = set()
        self.max_pages = max_pages

    def already_visited(self, url: str) -> bool:
        return normalize_url(url) in self._seen

    def mark_visited(self, url: str):
        self._seen.add(normalize_url(url))

    def count(self) -> int:
        return len(self._seen)

    def at_limit(self) -> bool:
        return len(self._seen) >= self.max_pages
