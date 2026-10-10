"""
Tests for app/discovery/pivot_engine.py — the v0.3 branching expansion.

Two things matter most here and both are tested explicitly:

1. The engine actually branches. A site reachable only through two hops must
   be found, because "surface leads my original searches would have missed"
   is the entire point of the feature.

2. The engine cannot run away. Every brake is tested in isolation, because a
   discovery engine that expands without bound is worse than no engine.
"""
from app.discovery.pivot_engine import (
    run_pivot_expansion, generate_leads_for_site, prioritized_leads, PivotBudget,
    _lead_key, PIVOTABLE,
)

WALLET = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"
WALLET2 = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"


def _seed(db, domain="seed.test", confidence=0.88):
    site_id = db.add_site(f"http://{domain}", "test")
    db.save_deep_profile(site_id, {
        "status": "complete", "domain": domain, "full_url": f"http://{domain}",
        "confidence_score": confidence})
    return site_id


def test_refuses_to_pivot_without_confident_seeds(temp_db):
    """Expanding from unconfirmed sites would compound uncertainty every hop."""
    temp_db.add_site("http://weak.test", "test")
    result = run_pivot_expansion()
    assert result["seeds"] == 0
    assert "confidence" in result["note"].lower()


def test_finds_site_sharing_an_indicator_with_the_seed(temp_db):
    db = temp_db
    seed = _seed(db)
    db.record_observation(seed, "wallet", WALLET, "http://seed.test/d", "page_text", "x")
    other = db.add_site("http://other.test", "test")
    db.record_observation(other, "wallet", WALLET, "http://other.test/d", "page_text", "x")

    run_pivot_expansion(max_depth=1)
    paths = db.paths_for_site(other)
    assert paths, "the site sharing a wallet with the seed should have been reached"
    assert paths[0]["pivot_type"] == "wallet_reuse"


def test_branches_to_depth_two(temp_db):
    """
    seed --wallet--> B --telegram--> C
    C shares nothing with the seed directly, so only a branching engine finds it.
    """
    db = temp_db
    seed = _seed(db)
    db.record_observation(seed, "wallet", WALLET, "http://seed.test/d", "page_text", "x")

    b = db.add_site("http://b.test", "test")
    db.record_observation(b, "wallet", WALLET, "http://b.test/d", "page_text", "x")
    db.record_observation(b, "telegram", "@chain", source_method="page_text")

    c = db.add_site("http://c.test", "test")
    db.record_observation(c, "telegram", "@chain", source_method="page_text")

    run_pivot_expansion(max_depth=2)
    paths = db.paths_for_site(c)
    assert paths, "depth-2 site should be reachable by branching"
    assert paths[0]["depth"] == 2


def test_depth_limit_is_expressed_in_hops_from_seed(temp_db):
    """
    Regression test for a real bug: max_depth capped LEAD depth, but a lead at
    depth d discovers sites at depth d+1 — so max_depth=1 quietly reached
    depth 2. max_depth must mean hops from the seed to a discovered site.
    """
    db = temp_db
    seed = _seed(db)
    db.record_observation(seed, "wallet", WALLET, "http://seed.test/d", "page_text", "x")
    b = db.add_site("http://b.test", "test")
    db.record_observation(b, "wallet", WALLET, "http://b.test/d", "page_text", "x")
    db.record_observation(b, "telegram", "@chain", source_method="page_text")
    c = db.add_site("http://c.test", "test")
    db.record_observation(c, "telegram", "@chain", source_method="page_text")

    run_pivot_expansion(max_depth=1)
    assert db.pivot_stats()["max_depth_reached"] <= 1


def test_lead_budget_stops_the_run(temp_db):
    db = temp_db
    seed = _seed(db)
    for kind, value in (("wallet", WALLET), ("telegram", "@h"), ("email", "a@b.test")):
        db.record_observation(seed, kind, value, "http://seed.test", "page_text", "x")
    for i in range(10):
        s = db.add_site(f"http://n{i}.test", "test")
        db.record_observation(s, "wallet", WALLET, f"http://n{i}.test", "page_text", "x")

    result = run_pivot_expansion(max_depth=2, max_leads=2)
    assert result["leads_executed"] <= 2
    assert result["stopped_reason"] == "lead_limit"


def test_time_limit_stops_the_run(temp_db):
    db = temp_db
    seed = _seed(db)
    db.record_observation(seed, "wallet", WALLET, "http://seed.test", "page_text", "x")
    result = run_pivot_expansion(max_depth=2, max_seconds=0)
    assert result["stopped_reason"] == "time_limit"


def test_candidate_budget_caps_new_sites(temp_db):
    db = temp_db
    seed = _seed(db)
    db.record_observation(seed, "wallet", WALLET2, "http://seed.test", "page_text", "x")
    result = run_pivot_expansion(max_depth=1, max_new_sites=2)
    assert result["new_sites"] <= 2


def test_leads_are_not_re_executed_across_runs(temp_db):
    """A lead explored once stays explored — otherwise every run redoes the work."""
    db = temp_db
    seed = _seed(db)
    db.record_observation(seed, "wallet", WALLET, "http://seed.test", "page_text", "x")
    other = db.add_site("http://other.test", "test")
    db.record_observation(other, "wallet", WALLET, "http://other.test", "page_text", "x")

    first = run_pivot_expansion(max_depth=1)
    second = run_pivot_expansion(max_depth=1)
    assert first["leads_executed"] > 0
    assert second["leads_executed"] == 0


def test_weak_indicators_never_become_leads(temp_db):
    """Registrar and ASN describe the hosting market, not a specific site."""
    db = temp_db
    site_id = db.add_site("http://weak.test", "test")
    db.record_observation(site_id, "registrar", "SomeRegistrar", source_method="whois")
    db.record_observation(site_id, "asn", "AS13335", source_method="whois")

    result = generate_leads_for_site(1, db.get_site(site_id), depth=0)
    # Only the domain-shape lead may be generated; neither weak type is pivotable.
    assert result["created"] <= 1
    assert "registrar" not in PIVOTABLE
    assert "asn" not in PIVOTABLE


def test_promiscuous_indicator_is_skipped(temp_db):
    """An IP on 30 sites describes a host, not a fingerprint."""
    db = temp_db
    for i in range(30):
        s = db.add_site(f"http://cdn{i}.test", "test")
        db.record_observation(s, "ip", "104.20.0.1", source_method="dns_a")
    site_id = db.add_site("http://cdnseed.test", "test")
    db.record_observation(site_id, "ip", "104.20.0.1", source_method="dns_a")

    result = generate_leads_for_site(1, db.get_site(site_id), depth=0)

    # The IP must not become a lead, and the refusal must say why in terms a
    # person can check — the assertion is on the behaviour and the presence of
    # a reason, not on the exact wording, which the noise gate owns.
    ip_refusals = [r for r in result["skipped"] if "104.20.0.1" in r or r.startswith("ip ")]
    assert ip_refusals, f"the promiscuous IP was not refused: {result['skipped']}"
    assert any("site" in r for r in ip_refusals), (
        f"the refusal does not explain the site count: {ip_refusals}")


def test_convergence_ranks_multi_path_sites_higher(temp_db):
    """
    A site reached by two INDEPENDENT pivots is a better lead than one reached
    by a single pivot, and must rank above it.
    """
    db = temp_db
    seed = _seed(db)
    db.record_observation(seed, "wallet", WALLET, "http://seed.test", "page_text", "x")
    db.record_observation(seed, "analytics_id", "G-SHARED", "http://seed.test", "html", "x")

    # single-route site
    single = db.add_site("http://single.test", "test")
    db.record_observation(single, "wallet", WALLET, "http://single.test", "page_text", "x")

    # multi-route site: reachable via analytics AND via single's telegram
    multi = db.add_site("http://multi.test", "test")
    db.record_observation(multi, "analytics_id", "G-SHARED", "http://multi.test", "html", "x")
    db.record_observation(single, "telegram", "@bridge", source_method="page_text")
    db.record_observation(multi, "telegram", "@bridge", source_method="page_text")

    run_pivot_expansion(max_depth=2)
    ranked = {item["domain"]: item for item in prioritized_leads()}
    assert "multi.test" in ranked and "single.test" in ranked
    assert ranked["multi.test"]["path_count"] >= 2
    assert ranked["multi.test"]["connection_score"] > ranked["single.test"]["connection_score"]


def test_every_discovered_site_has_an_explaining_path(temp_db):
    """A lead you can't explain is not usable evidence."""
    db = temp_db
    seed = _seed(db)
    db.record_observation(seed, "wallet", WALLET, "http://seed.test", "page_text", "x")
    other = db.add_site("http://other.test", "test")
    db.record_observation(other, "wallet", WALLET, "http://other.test", "page_text", "x")

    run_pivot_expansion(max_depth=1)
    for item in prioritized_leads():
        assert item["paths"], f"{item['domain']} has no discovery path"
        for path in item["paths"]:
            assert path["path_text"] and "→" in path["path_text"]
            assert path["why"]


def test_convergence_summary_does_not_claim_ownership(temp_db):
    """
    The engine reports shared indicators. It must not assert that sites are
    owned, controlled, or operated by the same party, because shared hosting,
    copied templates and recycled certificates produce identical signals.
    """
    db = temp_db
    seed = _seed(db)
    db.record_observation(seed, "wallet", WALLET, "http://seed.test", "page_text", "x")
    other = db.add_site("http://other.test", "test")
    db.record_observation(other, "wallet", WALLET, "http://other.test", "page_text", "x")

    run_pivot_expansion(max_depth=1)
    banned = ["same party", "same owner", "owned by", "operated by", "controls both",
              "single operation", "is malicious", "confirmed scam"]
    for item in prioritized_leads():
        text = (item["summary"] or "").lower()
        for phrase in banned:
            assert phrase not in text, f"overclaiming phrase {phrase!r} in: {text}"


def test_budget_reports_which_brake_stopped_it(temp_db):
    budget = PivotBudget(max_depth=2, max_new_sites=1, max_leads=100, max_seconds=100)
    budget.new_sites = 1
    assert budget.exhausted()
    assert budget.stop_reason == "candidate_limit"


def test_lead_keys_are_stable_and_case_insensitive():
    assert _lead_key("wallet_reuse", "ABC") == _lead_key("wallet_reuse", "abc")
    assert _lead_key("cert_san", "x") != _lead_key("wallet_reuse", "x")
