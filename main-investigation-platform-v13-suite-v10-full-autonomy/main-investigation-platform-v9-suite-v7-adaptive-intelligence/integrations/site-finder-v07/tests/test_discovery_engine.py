"""
Tests for app/discovery/engine.py using a fake, deterministic discoverer
registered in place of the real cold-start sources — this verifies the
engine's orchestration, dedup, audit-trail, and stats logic without depending
on any real network service (crt.sh, DNS, etc.), which this sandbox may not
have access to.
"""
from app.discovery.base import DiscoveryCandidate


class _FakeDiscoverer:
    def __init__(self, candidates):
        self._candidates = candidates

    def discover(self):
        return self._candidates


def test_engine_ingests_new_candidates_and_writes_discovery_fields(temp_db):
    db = temp_db
    import app.discovery.engine as engine_mod
    candidates = [
        DiscoveryCandidate(url="http://fake-scam-1.test", confidence=0.8,
                            reason="fake reason", category="investment_platform"),
    ]
    engine_mod.COLD_START_SOURCES = {"fake_source": lambda: _FakeDiscoverer(candidates)}

    from app.discovery.engine import DiscoveryEngine
    eng = DiscoveryEngine()
    result = eng.run(sources=["fake_source"])

    assert result["total_candidates"] == 1
    assert result["total_new_sites"] == 1
    assert result["total_duplicates"] == 0

    sites = db.list_sites()
    assert len(sites) == 1
    assert sites[0]["discovery_confidence"] == 0.8
    assert sites[0]["discovery_category"] == "investment_platform"
    assert sites[0]["discovery_reason"] == "fake reason"


def test_engine_dedupes_across_repeated_runs(temp_db):
    db = temp_db
    import app.discovery.engine as engine_mod
    candidates = [DiscoveryCandidate(url="http://fake-scam.test", confidence=0.7, reason="x")]
    engine_mod.COLD_START_SOURCES = {"fake_source": lambda: _FakeDiscoverer(candidates)}

    from app.discovery.engine import DiscoveryEngine
    eng = DiscoveryEngine()
    first = eng.run(sources=["fake_source"])
    second = eng.run(sources=["fake_source"])

    assert first["total_new_sites"] == 1
    assert second["total_new_sites"] == 0
    assert second["total_duplicates"] == 1
    assert len(db.list_sites()) == 1


def test_engine_logs_discovery_event_even_for_duplicates(temp_db):
    """The audit trail (discovery_events) must record every candidate a source
    surfaces, including ones that turn out to be duplicates — this is the
    'exactly why and where it was found' requirement, kept independent of
    whether it became a new sites row."""
    db = temp_db
    import app.discovery.engine as engine_mod
    candidates = [DiscoveryCandidate(url="http://fake-scam.test", confidence=0.7, reason="x")]
    engine_mod.COLD_START_SOURCES = {"fake_source": lambda: _FakeDiscoverer(candidates)}

    from app.discovery.engine import DiscoveryEngine
    eng = DiscoveryEngine()
    eng.run(sources=["fake_source"])
    eng.run(sources=["fake_source"])

    events = db.recent_discovery_events()
    assert len(events) == 2
    assert events[0]["was_duplicate"] == 1
    assert events[1]["was_duplicate"] == 0


def test_engine_records_run_stats_and_per_source_breakdown(temp_db):
    db = temp_db
    import app.discovery.engine as engine_mod
    candidates = [
        DiscoveryCandidate(url="http://a.test", confidence=0.5, reason="x"),
        DiscoveryCandidate(url="http://b.test", confidence=0.5, reason="x"),
    ]
    engine_mod.COLD_START_SOURCES = {"fake_source": lambda: _FakeDiscoverer(candidates)}

    from app.discovery.engine import DiscoveryEngine
    eng = DiscoveryEngine()
    result = eng.run(sources=["fake_source"])

    run = db.get_discovery_run(result["run_id"])
    assert run["total_new_sites"] == 2
    assert len(run["sources"]) == 1
    assert run["sources"][0]["source"] == "fake_source"
    assert run["sources"][0]["new_sites"] == 2


def test_engine_handles_source_exception_without_crashing_the_run(temp_db):
    """A single failing source (e.g. a rate-limited public API) must not take
    down the whole discovery run — its error is recorded, and the run completes."""
    db = temp_db
    import app.discovery.engine as engine_mod

    class BrokenDiscoverer:
        def discover(self):
            raise RuntimeError("simulated API failure")

    engine_mod.COLD_START_SOURCES = {"broken_source": lambda: BrokenDiscoverer()}

    from app.discovery.engine import DiscoveryEngine
    eng = DiscoveryEngine()
    result = eng.run(sources=["broken_source"])

    assert result["total_candidates"] == 0
    assert len(result["errors"]) == 1
    assert "simulated API failure" in result["errors"][0]

    run = db.get_discovery_run(result["run_id"])
    assert run["finished_at"] is not None


def test_engine_progress_callbacks_fire_for_discovered_sites(temp_db):
    db = temp_db
    import app.discovery.engine as engine_mod
    candidates = [DiscoveryCandidate(url="http://fake-scam.test", confidence=0.7, reason="x",
                                       category="cloud_mining")]
    engine_mod.COLD_START_SOURCES = {"fake_source": lambda: _FakeDiscoverer(candidates)}

    events = []
    from app.discovery.engine import DiscoveryEngine
    eng = DiscoveryEngine(progress_cb=lambda t, d: events.append((t, d)))
    eng.run(sources=["fake_source"])

    event_types = [e[0] for e in events]
    assert "discovery_run_started" in event_types
    assert "site_discovered" in event_types
    assert "discovery_run_finished" in event_types

    discovered_event = next(e for e in events if e[0] == "site_discovered")
    assert discovered_event[1]["category"] == "cloud_mining"


def test_engine_pivots_off_existing_sites_with_real_dns(temp_db):
    """
    Integration-style test of the pivot path using REAL DNS (not mocked) —
    verifies the engine actually calls the similar_domains pivot discoverer
    correctly end-to-end against a real, well-known domain. Skipped
    automatically if DNS resolution isn't available in this environment.
    """
    import socket
    try:
        socket.setdefaulttimeout(3)
        socket.gethostbyname("binance.com")
    except Exception:
        print("  (skipping: no DNS resolution available in this environment)")
        return

    db = temp_db
    sid = db.add_site("http://binance.com", "test", discovery_confidence=0.9,
                       discovery_reason="seed", discovery_category="fake_exchange")
    db.update_site_score(sid, 8.0, "test seed")

    from app.discovery.engine import DiscoveryEngine
    eng = DiscoveryEngine()
    result = eng.run(sources=["pivots"], pivot_seed_limit=1)

    assert result["total_candidates"] > 0, "expected at least one resolving typosquat variant"
    sites = db.list_sites()
    pivoted = [s for s in sites if s["source"] == "similar_domains"]
    assert len(pivoted) > 0
    assert all(s["domain"] != "binance.com" for s in pivoted)
