"""
Tests for app/discovery/knowledge_graph.py — the v0.4 persistent graph.

The user's standing requirement for this release is that everything be
explainable from stored evidence, and that observed facts stay separable from
software conclusions. A graph is exactly where that distinction gets lost, so
these tests check the separation is real and survives export.
"""
from app.analysis import correlation
from app.discovery import knowledge_graph as kg

WALLET = "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"
TELEGRAM = "vaultsupportdesk"


def _site(db, domain, indicators, confidence=0.85, source="test"):
    site_id = db.add_site(f"http://{domain}", source)
    db.save_deep_profile(site_id, {
        "status": "complete", "domain": domain, "full_url": f"http://{domain}",
        "confidence_score": confidence})
    for itype, value in indicators:
        db.record_observation(site_id, itype, value, f"http://{domain}/d", "page_text", "x")
    return site_id


def _two_related_sites(db):
    a = _site(db, "alpha.test", [("wallet", WALLET), ("telegram", TELEGRAM),
                                 ("ip", "198.51.100.5")])
    b = _site(db, "beta.test", [("wallet", WALLET), ("telegram", TELEGRAM),
                                ("ip", "198.51.100.5")])
    correlation.run_correlation("test-scan")
    return a, b


# ---------------------------------------------------------------------------
# Shape
# ---------------------------------------------------------------------------

def test_graph_contains_sites_indicators_wallets_and_infrastructure(temp_db):
    db = temp_db
    _two_related_sites(db)
    graph = kg.build_graph()

    types = {n["type"] for n in graph["nodes"]}
    assert {"site", "wallet", "infrastructure", "discovery_source"} <= types


def test_wallets_and_infrastructure_are_separate_node_types(temp_db):
    """'Same host' and 'same wallet' must not look alike in the graph."""
    db = temp_db
    _two_related_sites(db)
    graph = kg.build_graph()

    wallets = [n for n in graph["nodes"] if n["type"] == "wallet"]
    infra = [n for n in graph["nodes"] if n["type"] == "infrastructure"]
    assert wallets and infra
    assert all(n["indicator_type"] == "wallet" for n in wallets)
    assert all(n["indicator_type"] in kg.INFRASTRUCTURE_TYPES for n in infra)


def test_families_appear_as_cluster_nodes(temp_db):
    db = temp_db
    _two_related_sites(db)
    graph = kg.build_graph()
    assert any(n["type"] == "cluster" for n in graph["nodes"])
    assert any(e["type"] == "in_cluster" for e in graph["edges"])


def test_every_site_records_where_it_was_discovered(temp_db):
    db = temp_db
    _site(db, "found.test", [("wallet", WALLET)], source="campaign:wallet_reuse")
    graph = kg.build_graph()
    edges = [e for e in graph["edges"] if e["type"] == "discovered_by"]
    assert edges
    assert all(e["reason"] for e in edges)


# ---------------------------------------------------------------------------
# The observed / derived line
# ---------------------------------------------------------------------------

def test_every_node_and_edge_declares_its_evidence_class(temp_db):
    db = temp_db
    _two_related_sites(db)
    graph = kg.build_graph()

    for node in graph["nodes"]:
        assert node["evidence_class"] in ("observed", "derived"), node
    for edge in graph["edges"]:
        assert edge["evidence_class"] in ("observed", "derived"), edge


def test_observed_only_view_strips_every_software_conclusion(temp_db):
    db = temp_db
    _two_related_sites(db)
    observed = kg.build_graph(observed_only=True)

    assert observed["derived_edges"] == 0
    assert all(e["evidence_class"] == "observed" for e in observed["edges"])
    assert all(e["type"] == "observed_on" or e["type"] == "discovered_by"
               for e in observed["edges"])
    assert observed["edges"], "stripping conclusions should not empty the graph"


def test_an_observed_edge_says_where_the_fact_came_from(temp_db):
    db = temp_db
    _two_related_sites(db)
    graph = kg.build_graph()
    observed = [e for e in graph["edges"] if e["type"] == "observed_on"]
    assert observed
    for edge in observed:
        assert "was observed on" in edge["reason"]


def test_every_derived_edge_states_a_reason(temp_db):
    db = temp_db
    _two_related_sites(db)
    graph = kg.build_graph()
    derived = [e for e in graph["edges"] if e["evidence_class"] == "derived"]
    assert derived
    for edge in derived:
        assert edge["reason"].strip(), f"derived edge with no reason: {edge['id']}"


def test_graph_language_never_claims_shared_ownership(temp_db):
    import pathlib
    banned = ["same party", "owned by the same", "single operation", "same operator",
              "proves", "run by the same", "confirms they are"]
    source = pathlib.Path(kg.__file__).read_text(encoding="utf-8").lower()
    for phrase in banned:
        assert phrase not in source, f"knowledge_graph.py overclaims: {phrase!r}"

    db = temp_db
    _two_related_sites(db)
    graph = kg.build_graph()
    blob = (graph["note"] + " ".join(e["reason"] for e in graph["edges"])).lower()
    for phrase in banned:
        assert phrase not in blob, f"graph output overclaims: {phrase!r}"
    assert "not a finding about" in graph["note"].lower()


# ---------------------------------------------------------------------------
# Queries and export
# ---------------------------------------------------------------------------

def test_neighbourhood_returns_the_graph_around_one_site(temp_db):
    db = temp_db
    a, b = _two_related_sites(db)
    around = kg.neighbourhood(a, radius=1)

    node_ids = {n["id"] for n in around["nodes"]}
    assert f"site:{a}" in node_ids
    assert f"site:{b}" in node_ids, "a related site should be inside the neighbourhood"


def test_neighbourhood_of_an_unknown_site_says_so(temp_db):
    assert "error" in kg.neighbourhood(9999)


def test_graph_stats_are_cheap_and_complete(temp_db):
    db = temp_db
    _two_related_sites(db)
    stats = kg.graph_stats()
    for key in ("sites", "indicators", "wallets", "infrastructure",
                "relationships", "clusters", "campaigns"):
        assert key in stats
    assert stats["sites"] == 2
    assert stats["wallets"] == 1


def test_platform_export_is_typed_and_carries_its_evidence_policy(temp_db):
    db = temp_db
    _two_related_sites(db)
    export = kg.export_for_platform()

    assert export["format"] == "scamhunter.knowledge_graph.v1"
    assert set(export["node_types"]) == set(kg.NODE_TYPES)
    assert set(export["edge_types"]) == set(kg.EDGE_TYPES)
    assert "observed" in export["evidence_policy"]
    assert "derived" in export["evidence_policy"]
    assert "not evidence of shared ownership" in export["evidence_policy"]["derived"]
    assert export["nodes"] and export["edges"]


def test_export_node_and_edge_types_are_all_declared(temp_db):
    """A consumer should never meet a type the format did not announce."""
    db = temp_db
    _two_related_sites(db)
    export = kg.export_for_platform()
    for node in export["nodes"]:
        assert node["type"] in kg.NODE_TYPES, node["type"]
    for edge in export["edges"]:
        assert edge["type"] in kg.EDGE_TYPES, edge["type"]
