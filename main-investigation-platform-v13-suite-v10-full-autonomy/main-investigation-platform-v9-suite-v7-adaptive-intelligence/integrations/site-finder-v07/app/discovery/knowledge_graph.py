"""
The Discovery Knowledge Graph: one persistent view over everything learned.

Sites, indicators, wallets, infrastructure, clusters, discovery sources and
the pivots that connected them are all already stored — but they live in
separate tables shaped for the code that writes them. This module assembles
them into a single graph of typed nodes and typed edges, which is the form
the Main Investigation Platform will consume and the form a person can
actually read.

The graph is a VIEW, not a second copy. Nothing here is a new source of
truth: every node and edge is built from existing rows on demand, so the
graph can never drift out of step with the evidence behind it, and deleting
a site removes it from the graph automatically.

THE OBSERVED / DERIVED LINE
---------------------------
Every node and every edge carries an evidence_class:

  observed  a fact recorded from a public source — this page showed this
            wallet address; this domain resolved to this IP; this
            certificate listed this name. Checkable by anyone.
  derived   something this software concluded by comparing observations —
            that two sites are related, that a group of sites forms a
            family, that a discovery technique is productive.

The distinction is carried on every row rather than being implied by the
edge type, because the whole value of the graph to an investigator is being
able to strip it back to only what was actually seen.

WHAT AN EDGE IS NOT
-------------------
A 'shares_indicator' or 'in_cluster' edge means the two endpoints have a
specific public artifact in common. It is not an assertion of common
ownership, control, or wrongdoing — shared hosting, copied templates,
recycled certificates, resold contact handles and compromised sites all
produce exactly the same edges. Each edge stores the reason it exists so a
reviewer can judge it directly.
"""
import logging

from app import db
from app.db import INDICATOR_STRENGTH, STRONG_INDICATOR_TYPES

logger = logging.getLogger("scamhunter.knowledge_graph")

NODE_TYPES = ("site", "indicator", "wallet", "infrastructure", "cluster",
              "discovery_source", "campaign")

EDGE_TYPES = ("observed_on", "shares_indicator", "in_cluster", "discovered_by",
              "pivoted_to", "matches_family")

# Indicator types that describe where a site is hosted rather than what it
# contains. Separated out because "same host" is the single most
# misinterpreted edge in a graph like this.
INFRASTRUCTURE_TYPES = {"ip", "asn", "nameserver", "registrar", "cert_sha256", "cert_issuer"}


def _node(node_type: str, key, label: str, evidence_class: str, **attrs) -> dict:
    node = {"id": f"{node_type}:{key}", "type": node_type, "label": label,
            "evidence_class": evidence_class}
    node.update(attrs)
    return node


def _edge(source: str, target: str, edge_type: str, evidence_class: str,
          reason: str, weight: float = 0.5, **attrs) -> dict:
    edge = {"id": f"{source}->{target}:{edge_type}", "source": source, "target": target,
            "type": edge_type, "evidence_class": evidence_class, "reason": reason,
            "weight": round(weight, 3)}
    edge.update(attrs)
    return edge


def build_graph(site_limit: int = 300, min_indicator_strength: float = 0.0,
                include_infrastructure: bool = True,
                observed_only: bool = False) -> dict:
    """
    Assembles the graph. `observed_only` strips every software conclusion and
    leaves only what was recorded from public sources — the view to use when
    the question is "what do we actually know?".
    """
    nodes, edges = {}, {}

    def add_node(node):
        nodes.setdefault(node["id"], node)
        return node["id"]

    def add_edge(edge):
        edges.setdefault(edge["id"], edge)

    sites = db.list_sites(limit=site_limit)
    site_ids = {s["id"] for s in sites}

    # ---- Sites, and the indicators observed on them ----
    for site in sites:
        profile = db.get_deep_profile(site["id"])
        site_node = add_node(_node(
            "site", site["id"], site["domain"], "observed",
            url=site["url"], status=site.get("status"),
            confidence=(profile or {}).get("confidence_score"),
            discovery_source=site.get("source"),
            discovery_reason=site.get("discovery_reason")))

        # Where this site came from is itself a fact worth keeping in the graph.
        source = site.get("source") or "unknown"
        source_id = add_node(_node("discovery_source", source, source, "observed"))
        add_edge(_edge(
            site_node, source_id, "discovered_by", "observed",
            site.get("discovery_reason") or f"Recorded as found via {source}.",
            weight=site.get("discovery_confidence") or 0.5))

        for row in db.indicators_for_site(site["id"]):
            itype, value = row["indicator_type"], row["value"]
            strength = INDICATOR_STRENGTH.get(itype, 0.3)
            if strength < min_indicator_strength:
                continue
            is_infra = itype in INFRASTRUCTURE_TYPES
            if is_infra and not include_infrastructure:
                continue

            node_type = "wallet" if itype == "wallet" else (
                "infrastructure" if is_infra else "indicator")
            indicator_id = add_node(_node(
                node_type, f"{itype}|{value}", f"{itype}: {str(value)[:48]}", "observed",
                indicator_type=itype, value=value, strength=strength,
                site_count=row.get("site_count"),
                identity_bound=itype in STRONG_INDICATOR_TYPES))

            add_edge(_edge(
                site_node, indicator_id, "observed_on", "observed",
                (f"{itype} {str(value)[:40]} was observed on {site['domain']}"
                 + (f" at {row['source_url']}" if row.get("source_url") else "")
                 + (f" via {row['source_method']}." if row.get("source_method") else ".")),
                weight=strength,
                still_present=bool(row.get("still_present", 1)),
                first_observed=row.get("first_observed")))

    if observed_only:
        return _finish(nodes, edges, observed_only=True)

    # ---- Derived: relationships the correlation engine concluded ----
    for rel in db.all_relationships(limit=5000):
        a, b = rel["site_a_id"], rel["site_b_id"]
        if a not in site_ids or b not in site_ids:
            continue
        add_edge(_edge(
            f"site:{a}", f"site:{b}", "shares_indicator", "derived",
            rel.get("explanation") or rel.get("relation_type", "shared indicator"),
            weight=rel.get("strength") or 0.5,
            relation_type=rel.get("relation_type")))

    # ---- Derived: families ----
    for cluster in db.list_clusters(limit=100, min_sites=2):
        full = db.get_cluster(cluster["id"])
        cluster_id = add_node(_node(
            "cluster", cluster["id"], cluster.get("label") or f"family {cluster['id']}",
            "derived", site_count=cluster.get("site_count"),
            priority_score=cluster.get("priority_score"),
            summary=cluster.get("summary")))
        for member in (full or {}).get("members", []):
            if member["site_id"] not in site_ids:
                continue
            add_edge(_edge(
                f"site:{member['site_id']}", cluster_id, "in_cluster", "derived",
                (member.get("join_reason")
                 or "Grouped with this family by shared public indicators. Shared "
                    "indicators can also come from shared hosting, copied templates or "
                    "a compromised site."),
                weight=0.6))

    # ---- Derived: how pivoting actually reached each site ----
    for site in sites:
        for path in db.paths_for_site(site["id"]):
            origin = path.get("origin_site_id")
            if not origin or origin not in site_ids:
                continue
            add_edge(_edge(
                f"site:{origin}", f"site:{site['id']}", "pivoted_to", "derived",
                path.get("path_text") or (
                    f"Reached by a {path.get('pivot_type')} pivot at depth {path.get('depth')}."),
                weight=path.get("link_strength") or 0.5,
                pivot_type=path.get("pivot_type"), depth=path.get("depth")))

    # ---- Derived: newly appearing domains matching a known family ----
    for new_domain in db.list_cluster_new_domains(limit=200):
        if new_domain["site_id"] not in site_ids:
            continue
        cluster_node = f"cluster:{new_domain['cluster_id']}"
        if cluster_node not in nodes:
            continue
        add_edge(_edge(
            f"site:{new_domain['site_id']}", cluster_node, "matches_family", "derived",
            new_domain.get("match_explanation") or "Matched a known family signature.",
            weight=0.55))

    return _finish(nodes, edges, observed_only=False)


def _finish(nodes: dict, edges: dict, observed_only: bool) -> dict:
    node_list = list(nodes.values())
    edge_list = list(edges.values())
    counts = {}
    for node in node_list:
        counts[node["type"]] = counts.get(node["type"], 0) + 1
    edge_counts = {}
    for edge in edge_list:
        edge_counts[edge["type"]] = edge_counts.get(edge["type"], 0) + 1

    observed_edges = sum(1 for e in edge_list if e["evidence_class"] == "observed")
    return {
        "nodes": node_list, "edges": edge_list,
        "node_counts": counts, "edge_counts": edge_counts,
        "observed_edges": observed_edges,
        "derived_edges": len(edge_list) - observed_edges,
        "observed_only": observed_only,
        "note": ("Observed rows are facts recorded from public sources. Derived rows are "
                 "conclusions this software reached by comparing those facts — a shared "
                 "indicator, a family grouping, a discovery path. A derived edge means two "
                 "things have a public artifact in common; it is not a finding about "
                 "ownership, control, or wrongdoing."),
    }


def neighbourhood(site_id: int, radius: int = 1) -> dict:
    """
    The graph around one site: what was observed on it, what it shares with
    what, and how it was reached. This is the query the investigation
    workspace and the platform export both need.
    """
    site = db.get_site(site_id)
    if not site:
        return {"error": f"No site {site_id}"}

    frontier = {site_id}
    collected = {site_id}
    for _ in range(max(1, radius)):
        nxt = set()
        for current in frontier:
            for rel in db.relationships_for_site(current):
                other = rel.get("other_site_id") or rel.get("site_b_id")
                if other and other not in collected:
                    nxt.add(other)
            for path in db.paths_for_site(current):
                origin = path.get("origin_site_id")
                if origin and origin not in collected:
                    nxt.add(origin)
        collected |= nxt
        frontier = nxt
        if not frontier:
            break

    graph = build_graph(site_limit=1000)
    keep = {f"site:{s}" for s in collected}
    nodes = [n for n in graph["nodes"]
             if n["id"] in keep or any(
                 e["source"] in keep or e["target"] in keep
                 for e in graph["edges"] if n["id"] in (e["source"], e["target"]))]
    node_ids = {n["id"] for n in nodes}
    edges = [e for e in graph["edges"]
             if e["source"] in node_ids and e["target"] in node_ids
             and (e["source"] in keep or e["target"] in keep)]

    return {"center": f"site:{site_id}", "domain": site["domain"],
            "radius": radius, "nodes": nodes, "edges": edges,
            "note": graph["note"]}


def graph_stats() -> dict:
    """Cheap counters for the dashboard — no full graph assembly."""
    with db.get_conn() as conn:
        def count(sql):
            return conn.execute(sql).fetchone()["c"]
        return {
            "sites": count("SELECT COUNT(*) c FROM sites"),
            "indicators": count("SELECT COUNT(*) c FROM indicators"),
            "observations": count("SELECT COUNT(*) c FROM site_indicators"),
            "wallets": count("SELECT COUNT(*) c FROM indicators WHERE indicator_type='wallet'"),
            "infrastructure": count(
                "SELECT COUNT(*) c FROM indicators WHERE indicator_type IN "
                "('ip','asn','nameserver','registrar','cert_sha256','cert_issuer')"),
            "relationships": count("SELECT COUNT(*) c FROM site_relationships"),
            "clusters": count("SELECT COUNT(*) c FROM clusters"),
            "discovery_paths": count("SELECT COUNT(*) c FROM discovery_paths"),
            "family_matches": count("SELECT COUNT(*) c FROM cluster_new_domains"),
            "campaigns": count("SELECT COUNT(*) c FROM campaigns"),
        }


def export_for_platform(site_limit: int = 500) -> dict:
    """
    The whole graph in the shape the Main Investigation Platform expects:
    typed nodes, typed edges, every row labelled observed or derived, and
    every derived row carrying the reason it exists.
    """
    graph = build_graph(site_limit=site_limit)
    return {
        "format": "scamhunter.knowledge_graph.v1",
        "node_types": list(NODE_TYPES), "edge_types": list(EDGE_TYPES),
        "nodes": graph["nodes"], "edges": graph["edges"],
        "counts": {"nodes": graph["node_counts"], "edges": graph["edge_counts"]},
        "evidence_policy": {
            "observed": "Recorded directly from a public source and independently checkable.",
            "derived": ("Concluded by comparing observations. Every derived row states its "
                        "reason. A derived link means shared public artifacts only — it is "
                        "not evidence of shared ownership, control, or wrongdoing."),
        },
        "note": graph["note"],
    }
