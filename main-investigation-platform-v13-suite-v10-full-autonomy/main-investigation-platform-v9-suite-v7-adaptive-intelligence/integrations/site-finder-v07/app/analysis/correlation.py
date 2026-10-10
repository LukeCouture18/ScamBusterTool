"""
The correlation engine: turns a pile of separate findings into families.

This is the part that answers "who else is running this?" rather than "what
else exists?". It never touches the network — it works purely on observations
already recorded by the scanners, comparing them to find sites that share
reusable public artifacts.

The observed/derived line is absolute here. Everything this module writes is
a DERIVED correlation, and every derived row points back to the specific
observed indicator that justifies it. A reviewer can always ask "why are these
two linked?" and get a concrete, checkable answer: *because both sites showed
this exact wallet address, on these pages, at these times.*

Cluster priority deliberately mirrors the per-site quality gate: a family is
prioritised by how many INDEPENDENT STRONG indicator types tie it together,
not by how many sites it contains. Twenty sites sharing one cheap shared-hosting
IP is weak. Three sites sharing a wallet, a Telegram handle and an analytics ID
is a confirmed operation.
"""
import logging
import time

from app import db
from app.db import INDICATOR_STRENGTH, STRONG_INDICATOR_TYPES

logger = logging.getLogger("scamhunter.correlation")

# Indicator types too promiscuous to justify a link on their own. Sharing one
# of these is recorded, but never by itself creates a relationship — otherwise
# every site behind the same CDN or registrar would "cluster" together.
WEAK_ALONE_TYPES = {"asn", "registrar"}

# An indicator seen on more than this many sites is treated as infrastructure
# noise rather than a fingerprint (e.g. a Cloudflare IP, a shared nameserver at
# a huge host). Sharing it proves nothing about common ownership.
PROMISCUITY_LIMIT = {
    "ip": 25,
    "nameserver": 60,
    "asn": 1000,
    "registrar": 1000,
    "cert_sha256": 25,
    "favicon_hash": 40,
    "template_hash": 40,
    # Strong identity-bound indicators have no practical limit — a wallet shared
    # across 200 sites is the single most interesting thing we could find.
}


def _is_usable_for_linking(indicator: dict) -> tuple:
    """Returns (usable, reason_if_not)."""
    itype = indicator["indicator_type"]
    if itype in WEAK_ALONE_TYPES:
        return False, f"{itype} is too generic to imply shared ownership on its own"
    limit = PROMISCUITY_LIMIT.get(itype)
    if limit and indicator["site_count"] > limit:
        return False, (f"{itype} {indicator['value'][:40]!r} appears on "
                       f"{indicator['site_count']} sites — treated as shared infrastructure "
                       "noise, not a fingerprint")
    return True, ""


def _explain(indicator: dict, site_a: dict, site_b: dict, observations: dict) -> str:
    """Plain-language justification recorded on every derived relationship."""
    itype = indicator["indicator_type"]
    value = indicator["value"]
    obs_a = observations.get((site_a["id"], indicator["id"]))
    obs_b = observations.get((site_b["id"], indicator["id"]))

    where_a = (obs_a or {}).get("source_url") or site_a["domain"]
    where_b = (obs_b or {}).get("source_url") or site_b["domain"]
    how_a = (obs_a or {}).get("source_method") or "scan"
    how_b = (obs_b or {}).get("source_method") or "scan"

    readable = {
        "wallet": "the same cryptocurrency address",
        "analytics_id": "the same analytics/tag account ID",
        "telegram": "the same Telegram handle",
        "whatsapp": "the same WhatsApp number",
        "email": "the same contact email address",
        "phone": "the same phone number",
        "cert_sha256": "the same TLS certificate",
        "template_hash": "the same page template fingerprint",
        "favicon_hash": "the same favicon",
        "nameserver": "the same nameservers",
        "ip": "the same hosting IP address",
    }.get(itype, f"the same {itype}")

    note = ""
    if itype == "wallet":
        note = (" A reused payment address is among the most discriminating indicators "
                "available, since addresses are not usually shared by accident. It still "
                "does not by itself establish who controls either site: addresses are "
                "republished, copied between sites, and occasionally posted by third "
                "parties. Treat it as a strong lead to verify, not a conclusion.")
    elif itype in ("analytics_id",):
        note = (" Analytics and tag IDs are issued per account, so reuse points to a shared "
                "account or a copied template. Which of those it is has to be established "
                "separately.")
    elif itype == "ip":
        note = (" Shared hosting can cause this innocently, so on its own it is suggestive "
                "rather than conclusive.")

    return (f"Both sites exposed {readable}: {value}. "
            f"Observed on {site_a['domain']} via {how_a} at {where_a}, and on "
            f"{site_b['domain']} via {how_b} at {where_b}.{note}")


def derive_relationships(scan_id: str = "") -> dict:
    """
    Compares every observation and records a derived relationship for each pair
    of sites sharing a usable indicator. Idempotent — re-running refreshes
    last_confirmed rather than duplicating.
    """
    started = time.time()
    created = 0
    skipped_noise = 0

    with db.get_conn() as conn:
        indicators = [dict(r) for r in conn.execute(
            "SELECT * FROM indicators WHERE site_count > 1"
        ).fetchall()]

        observations = {}
        for row in conn.execute(
            """SELECT site_id, indicator_id, source_url, source_method
               FROM site_indicators"""
        ).fetchall():
            observations[(row["site_id"], row["indicator_id"])] = dict(row)

    site_cache = {}

    def site(site_id):
        if site_id not in site_cache:
            site_cache[site_id] = db.get_site(site_id)
        return site_cache[site_id]

    for indicator in indicators:
        usable, reason = _is_usable_for_linking(indicator)
        if not usable:
            skipped_noise += 1
            logger.debug("Skipping indicator for linking: %s", reason)
            continue

        sharing = db.sites_sharing_indicator(indicator["id"])
        relation_type = f"shared_{indicator['indicator_type']}"

        for i, site_a in enumerate(sharing):
            for site_b in sharing[i + 1:]:
                a, b = site(site_a["id"]), site(site_b["id"])
                if not a or not b:
                    continue
                explanation = _explain(indicator, a, b, observations)
                rel_id = db.record_relationship(
                    a["id"], b["id"], relation_type, indicator["id"], explanation,
                    strength=INDICATOR_STRENGTH.get(indicator["indicator_type"], 0.5),
                )
                if rel_id:
                    created += 1
                    for site_id, other in ((a["id"], b), (b["id"], a)):
                        db.add_timeline_event(
                            site_id, "relationship_derived", "derived",
                            f"Linked to {other['domain']} via shared "
                            f"{indicator['indicator_type']}",
                            explanation,
                            ref_table="indicators", ref_id=indicator["id"],
                        )

    return {
        "relationships_recorded": created,
        "indicators_considered": len(indicators),
        "indicators_skipped_as_noise": skipped_noise,
        "elapsed_seconds": round(time.time() - started, 2),
    }


def _connected_components(edges: dict) -> list:
    """Plain union-find over the relationship graph."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[ry] = rx

    for node, neighbours in edges.items():
        find(node)
        for neighbour in neighbours:
            union(node, neighbour)

    groups = {}
    for node in parent:
        groups.setdefault(find(node), set()).add(node)
    return [sorted(members) for members in groups.values()]


def build_clusters(scan_id: str = "") -> dict:
    """
    Groups sites into families from the derived relationship graph, scores each
    family, and rewrites the cluster tables.

    Priority is driven by INDEPENDENT STRONG indicator types, matching the
    quality-over-quantity principle: a family held together by several unrelated
    kinds of evidence outranks a bigger family held together by one weak one.
    """
    started = time.time()
    relationships = db.all_relationships()
    if not relationships:
        db.replace_clusters([])
        return {"clusters": 0, "clustered_sites": 0, "elapsed_seconds": 0.0}

    edges = {}
    rel_by_pair = {}
    for rel in relationships:
        a, b = rel["site_a_id"], rel["site_b_id"]
        edges.setdefault(a, set()).add(b)
        edges.setdefault(b, set()).add(a)
        rel_by_pair.setdefault((a, b), []).append(rel)

    components = _connected_components(edges)
    clusters = []

    for members in components:
        if len(members) < 2:
            continue

        member_set = set(members)
        internal = [r for (a, b), rels in rel_by_pair.items()
                    if a in member_set and b in member_set for r in rels]

        types_present = {r["relation_type"].replace("shared_", "") for r in internal}
        strong_types = types_present & STRONG_INDICATOR_TYPES

        # Gather per-site confidence and wallet counts for the family.
        max_confidence = 0.0
        total_wallets = 0
        domains = []
        for site_id in members:
            site = db.get_site(site_id)
            if site:
                domains.append(site["domain"])
            profile = db.get_deep_profile(site_id)
            if profile and profile.get("confidence_score"):
                max_confidence = max(max_confidence, profile["confidence_score"])
            total_wallets += len([w for w in db.wallets_with_validation_for_site(site_id)
                                   if w.get("format_valid")])

        # Priority: independent strong evidence dominates; size is a mild bonus.
        strength_component = sum(INDICATOR_STRENGTH.get(t, 0.3) for t in types_present)
        priority = (
            len(strong_types) * 3.0
            + strength_component
            + min(len(members), 10) * 0.4
            + max_confidence * 2.0
            + min(total_wallets, 10) * 0.3
        )

        label = _cluster_label(domains, strong_types)
        summary = _cluster_summary(domains, types_present, strong_types,
                                    internal, max_confidence, total_wallets)

        member_rows = []
        for site_id in members:
            reasons = sorted({
                r["relation_type"].replace("shared_", "")
                for (a, b), rels in rel_by_pair.items()
                if site_id in (a, b) and a in member_set and b in member_set
                for r in rels
            })
            member_rows.append({
                "site_id": site_id,
                "join_reason": "Linked to this family by shared " + ", ".join(reasons),
            })

        clusters.append({
            "label": label,
            "site_count": len(members),
            "distinct_indicator_types": len(types_present),
            "strong_indicator_types": len(strong_types),
            "priority_score": round(priority, 2),
            "max_site_confidence": round(max_confidence, 3),
            "total_validated_wallets": total_wallets,
            "summary": summary,
            "members": member_rows,
        })

    clusters.sort(key=lambda c: c["priority_score"], reverse=True)
    db.replace_clusters(clusters)

    # Record cluster membership on each site's timeline.
    for cluster in db.list_clusters(limit=1000, min_sites=2):
        full = db.get_cluster(cluster["id"])
        for member in full["members"]:
            db.add_timeline_event(
                member["site_id"], "cluster_joined", "derived",
                f"Grouped into family: {cluster['label']}",
                f"{member['join_reason']}. Family summary: {cluster['summary']}",
                ref_table="clusters", ref_id=cluster["id"],
            )

    return {
        "clusters": len(clusters),
        "clustered_sites": sum(c["site_count"] for c in clusters),
        "elapsed_seconds": round(time.time() - started, 2),
    }


def _cluster_label(domains: list, strong_types: set) -> str:
    if not domains:
        return "Unnamed family"
    anchor = sorted(domains, key=len)[0]
    if strong_types:
        return f"{anchor} family ({', '.join(sorted(strong_types)[:2])})"
    return f"{anchor} family"


def _cluster_summary(domains, types_present, strong_types, internal,
                      max_confidence, total_wallets) -> str:
    parts = [
        f"{len(domains)} sites connected by {len(types_present)} kind(s) of shared indicator: "
        f"{', '.join(sorted(types_present))}."
    ]
    if strong_types:
        parts.append(
            f"{len(strong_types)} of these are high-discrimination indicators "
            f"({', '.join(sorted(strong_types))}) — the kind that are not usually shared by "
            "coincidence, which is why this grouping is worth investigating. This is a "
            "statement about shared indicators only: it does not establish common ownership, "
            "control, or wrongdoing by any of these sites, each of which must be assessed "
            "on its own evidence.")
    else:
        parts.append(
            "No strong identity-bound indicator is shared, so this grouping is "
            "suggestive rather than conclusive — it may reflect shared hosting "
            "or a common template vendor rather than a common operator.")
    if total_wallets:
        parts.append(f"{total_wallets} checksum-validated wallet(s) across the family.")
    if max_confidence:
        parts.append(f"Strongest member confidence: {max_confidence:.0%}.")
    parts.append(f"Derived from {len(internal)} pairwise relationship(s).")
    return " ".join(parts)


def run_correlation(scan_id: str = "") -> dict:
    """Full correlation pass: derive relationships, then rebuild clusters."""
    rel = derive_relationships(scan_id=scan_id)
    clusters = build_clusters(scan_id=scan_id)
    return {"relationships": rel, "clusters": clusters}


def wallet_reuse_report(min_sites: int = 2) -> list:
    """
    Every wallet seen on more than one site — the highest-value cross-site
    signal this tool produces, surfaced on its own because it deserves to be.
    """
    with db.get_conn() as conn:
        rows = conn.execute(
            """SELECT i.id, i.value AS address, i.site_count
               FROM indicators i
               WHERE i.indicator_type='wallet' AND i.site_count >= ?
               ORDER BY i.site_count DESC""",
            (min_sites,),
        ).fetchall()

    report = []
    for row in rows:
        sites = db.sites_sharing_indicator(row["id"])
        wallet_row = None
        with db.get_conn() as conn:
            wallet_row = conn.execute(
                """SELECT w.*, v.format_valid, v.tx_count, v.balance, v.total_received
                   FROM wallets w LEFT JOIN wallet_validations v ON v.wallet_id = w.id
                   WHERE lower(w.address)=lower(?) LIMIT 1""",
                (row["address"],),
            ).fetchone()
        report.append({
            "address": row["address"],
            "network": (dict(wallet_row).get("network") if wallet_row else None),
            "site_count": row["site_count"],
            "format_valid": (dict(wallet_row).get("format_valid") if wallet_row else None),
            "tx_count": (dict(wallet_row).get("tx_count") if wallet_row else None),
            "total_received": (dict(wallet_row).get("total_received") if wallet_row else None),
            "sites": [{"site_id": s["id"], "domain": s["domain"], "url": s["url"]} for s in sites],
            "evidence_class": "observed",
            "explanation": (
                f"This address was independently observed on {row['site_count']} different "
                "sites. Each sighting is an observed fact with its own page URL and context; "
                "the conclusion that these sites are related is derived from those facts."
            ),
        })
    return report
