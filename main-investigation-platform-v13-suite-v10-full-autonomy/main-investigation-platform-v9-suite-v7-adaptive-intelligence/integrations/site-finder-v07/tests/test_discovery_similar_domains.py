"""Tests for app/discovery/similar_domains.py."""
from app.discovery.similar_domains import generate_variants, domain_root, SimilarDomainsDiscoverer


def test_domain_root_strips_scheme_and_www():
    assert domain_root("http://binance.com") == "binance"
    assert domain_root("https://www.binance.com/") == "binance"
    assert domain_root("binance.com") == "binance"
    assert domain_root("BINANCE.COM") == "binance"


def test_generate_variants_excludes_seed_itself():
    variants = generate_variants("binance")
    assert "binance" not in variants


def test_generate_variants_includes_affix_patterns():
    variants = generate_variants("binance", max_variants=200)
    assert "binance-support" in variants
    assert "binancesupport" in variants
    assert "binance-wallet" in variants


def test_generate_variants_includes_omission_and_doubling():
    variants = generate_variants("abcd", max_variants=200)
    assert "bcd" in variants or "acd" in variants or "abd" in variants or "abc" in variants
    assert "aabcd" in variants or "abbcd" in variants or "abccd" in variants or "abcdd" in variants


def test_generate_variants_respects_max_limit():
    variants = generate_variants("binance", max_variants=5)
    assert len(variants) <= 5


def test_generate_variants_handles_short_root_without_crashing():
    variants = generate_variants("ab")
    assert isinstance(variants, list)


def _fake_resolver_factory(resolving_domains):
    def resolver(domain):
        return domain in resolving_domains
    return resolver


def test_discover_from_site_only_returns_resolving_variants():
    resolver = _fake_resolver_factory({"binance-support.com"})
    disc = SimilarDomainsDiscoverer(tlds=[".com"], resolver=resolver)

    site = {"id": 42, "domain": "binance.com"}
    candidates = disc.discover_from_site(site)

    assert len(candidates) == 1
    assert candidates[0].url == "http://binance-support.com"
    assert candidates[0].pivot_from_site_id == 42
    assert candidates[0].confidence > 0


def test_discover_from_site_returns_nothing_when_no_variants_resolve():
    resolver = _fake_resolver_factory(set())
    disc = SimilarDomainsDiscoverer(tlds=[".com"], resolver=resolver)
    site = {"id": 1, "domain": "somebrand.com"}
    candidates = disc.discover_from_site(site)
    assert candidates == []


def test_discover_from_site_skips_short_roots():
    resolver = _fake_resolver_factory({"ab-support.com"})
    disc = SimilarDomainsDiscoverer(tlds=[".com"], resolver=resolver)
    site = {"id": 1, "domain": "ab.com"}
    candidates = disc.discover_from_site(site)
    assert candidates == []


def test_discover_from_brands_tags_brand_impersonation_category():
    resolver = _fake_resolver_factory({"binance-support.com"})
    disc = SimilarDomainsDiscoverer(tlds=[".com"], resolver=resolver)
    candidates = disc.discover_from_brands()
    matching = [c for c in candidates if "binance-support" in c.url]
    assert len(matching) == 1
    assert matching[0].category == "brand_impersonation"
    assert matching[0].pivot_from_site_id is None


def test_discover_respects_max_dns_checks_budget():
    resolver = _fake_resolver_factory({f"variant{i}.com" for i in range(100)})
    disc = SimilarDomainsDiscoverer(tlds=[".com"], resolver=resolver, max_dns_checks=5)
    site = {"id": 1, "domain": "somebrandname.com"}
    disc.discover_from_site(site)
    assert disc._dns_checks_used <= 5
