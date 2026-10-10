"""
Every discoverer is a class implementing `discover()`, which yields
DiscoveryCandidate objects. Add a new discovery source by subclassing
Discoverer and registering it in app/discovery/engine.py's SOURCE_REGISTRY —
nothing else in the system needs to change.

Two flavors of discoverer:
  - Plain discoverers pull candidates from a public source independent of
    anything already in our database (certificate transparency logs, search-
    engine-indexed keyword hits, etc).
  - Pivot discoverers take what's already been found (known scam domains,
    wallet addresses, contact info, page templates) and use it to find MORE
    candidates — typosquat variants, shared-infrastructure siblings, sites
    reusing the same template or wallet. These implement `discover_from_site()`
    instead, since they need a seed site's context rather than running cold.

Both kinds return the same DiscoveryCandidate shape so the engine can treat
them uniformly for dedup, scoring, and DB writes.
"""
from dataclasses import dataclass, field


@dataclass
class DiscoveryCandidate:
    url: str
    confidence: float               # 0.0-1.0: how confident this source is that it's worth investigating
    reason: str                     # plain-language explanation, shown in the UI's discovery log
    category: str = ""              # investment_platform, fake_exchange, fake_wallet, cloud_mining,
                                     # usdt_deposit, pig_butchering, brand_impersonation, other
    pivot_from_site_id: int | None = None   # set when this came from mining an existing site


class Discoverer:
    """Cold-start discoverer: finds candidates independent of anything already known."""
    name = "base"
    # Respect public-API etiquette: discoverers should self-limit request volume
    # and rate; the engine also enforces a per-run cap per source as a backstop.
    max_candidates_per_run = 100

    def discover(self) -> list:
        """Returns a list of DiscoveryCandidate. Must not raise for expected failure
        modes (network errors, rate limits) — catch and return whatever succeeded,
        logging the rest; the engine treats an uncaught exception as a hard source
        failure and records it, but a source that degrades gracefully is preferred."""
        raise NotImplementedError


class PivotDiscoverer:
    """Pivot discoverer: mines an already-known site for related candidates."""
    name = "base_pivot"
    max_candidates_per_site = 20

    def discover_from_site(self, site: dict) -> list:
        raise NotImplementedError
