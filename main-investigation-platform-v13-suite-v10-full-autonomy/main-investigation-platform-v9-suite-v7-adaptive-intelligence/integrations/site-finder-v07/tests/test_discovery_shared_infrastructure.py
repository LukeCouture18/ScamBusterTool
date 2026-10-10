"""Tests for app/discovery/shared_infrastructure.py, using a mocked fingerprint
function so the matching logic is verified deterministically without real DNS."""
from app.discovery.shared_infrastructure import SharedInfrastructureDiscoverer


def _fake_fingerprint_factory(fingerprints):
    def fn(domain):
        return fingerprints.get(domain, {"ip": None, "nameservers": []})
    return fn


def test_matches_on_shared_ip():
    fingerprints = {
        "known-scam.test": {"ip": "1.2.3.4", "nameservers": []},
        "new-candidate.test": {"ip": "1.2.3.4", "nameservers": []},
    }
    disc = SharedInfrastructureDiscoverer(fingerprint_fn=_fake_fingerprint_factory(fingerprints))
    cache = disc.build_fingerprint_cache(["known-scam.test"])

    matched, reason = disc.check_candidate_against_known("new-candidate.test", cache)
    assert matched == "known-scam.test"
    assert "1.2.3.4" in reason


def test_no_match_on_different_ip():
    fingerprints = {
        "known-scam.test": {"ip": "1.2.3.4", "nameservers": []},
        "unrelated-site.test": {"ip": "9.9.9.9", "nameservers": []},
    }
    disc = SharedInfrastructureDiscoverer(fingerprint_fn=_fake_fingerprint_factory(fingerprints))
    cache = disc.build_fingerprint_cache(["known-scam.test"])

    matched, reason = disc.check_candidate_against_known("unrelated-site.test", cache)
    assert matched is None
    assert reason == ""


def test_matches_on_shared_nameservers_when_ip_differs():
    fingerprints = {
        "known-scam.test": {"ip": "1.2.3.4", "nameservers": ["ns1.cheap-host.test", "ns2.cheap-host.test"]},
        "new-candidate.test": {"ip": "5.6.7.8", "nameservers": ["ns1.cheap-host.test", "ns2.cheap-host.test"]},
    }
    disc = SharedInfrastructureDiscoverer(fingerprint_fn=_fake_fingerprint_factory(fingerprints))
    cache = disc.build_fingerprint_cache(["known-scam.test"])

    matched, reason = disc.check_candidate_against_known("new-candidate.test", cache)
    assert matched == "known-scam.test"
    assert "cheap-host.test" in reason


def test_no_match_when_candidate_has_no_resolvable_ip():
    fingerprints = {
        "known-scam.test": {"ip": "1.2.3.4", "nameservers": []},
        "dead-domain.test": {"ip": None, "nameservers": []},
    }
    disc = SharedInfrastructureDiscoverer(fingerprint_fn=_fake_fingerprint_factory(fingerprints))
    cache = disc.build_fingerprint_cache(["known-scam.test"])

    matched, reason = disc.check_candidate_against_known("dead-domain.test", cache)
    assert matched is None


def test_does_not_match_against_itself():
    fingerprints = {"same-domain.test": {"ip": "1.2.3.4", "nameservers": []}}
    disc = SharedInfrastructureDiscoverer(fingerprint_fn=_fake_fingerprint_factory(fingerprints))
    cache = disc.build_fingerprint_cache(["same-domain.test"])

    matched, reason = disc.check_candidate_against_known("same-domain.test", cache)
    assert matched is None


def test_build_fingerprint_cache_covers_all_requested_domains():
    fingerprints = {
        "a.test": {"ip": "1.1.1.1", "nameservers": []},
        "b.test": {"ip": "2.2.2.2", "nameservers": []},
    }
    disc = SharedInfrastructureDiscoverer(fingerprint_fn=_fake_fingerprint_factory(fingerprints))
    cache = disc.build_fingerprint_cache(["a.test", "b.test"])
    assert set(cache.keys()) == {"a.test", "b.test"}
