"""
Cluster watch: noticing when a new domain looks like an existing family.

Clustering (app/analysis/correlation.py) answers "which of the sites I already
have belong together?". This module answers the forward-looking question:
*a new domain just turned up — does it match the shape of a family I already
know about?* That is how an operation's next site gets caught early rather
than being rediscovered from scratch months later.

WHAT A SIGNATURE IS
-------------------
A family signature is the set of reusable public indicators that the members
of a cluster actually share, grouped into categories (wallet, contact,
template, certificate, infrastructure, analytics, nameserver, content). It is
built only from indicators that are genuinely shared by members and that are
not so common as to be meaningless — an indicator sitting on hundreds of
unrelated sites is infrastructure, not a fingerprint.

WHY A MATCH NEEDS A COMBINATION
-------------------------------
One shared nameserver is nothing: millions of sites share a nameserver. So a
match requires EITHER one identity-bound indicator (a wallet address, a
Telegram handle, an analytics property — things an operator supplies rather
than inherits from a host) OR at least two indicators from different
categories. Requiring a combination is what keeps this from flagging every
customer of a large hosting provider.

WHAT A MATCH MEANS
------------------
That two sites share specific public artifacts, and nothing more. There are
ordinary explanations for every category here — shared hosting, a bought or
stolen template, a recycled certificate, a compromised site, a copied page.
A match is a reason to look, recorded with the exact indicator that caused it
so a person can check it. It is not a conclusion about who runs the site.
"""
import logging
import time

from app import db
from app.db import INDICATOR_STRENGTH, STRONG_INDICATOR_TYPES
from app.analysis.correlation import PROMISCUITY_LIMIT, WEAK_ALONE_TYPES

logger = logging.getLogger("scamhunter.cluster_watch")

# Which indicator types belong to which category. A match that spans two
# categories is far more interesting than two indicators of the same kind,
# because the categories fail independently.
INDICATOR_CATEGORY = {
    "wallet": "wallet",
    "telegram": "contact", "whatsapp": "contact", "email": "contact",
    "phone": "contact", "social": "contact",
    "template_hash": "template", "favicon_hash": "template", "page_title": "template",
    "cert_sha256": "certificate", "cert_issuer": "certificate",
    "ip": "infrastructure", "asn": "infrastructure", "registrar": "infrastructure",
    "nameserver": "nameserver",
    "analytics_id": "analytics", "adsense_id": "analytics", "gtag_id": "analytics",
    "brand": "content", "distinctive_text": "content",
}

# Indicators an operator supplies rather than inherits. One of these matching
# is meaningful on its own; everything else needs corroboration.
IDENTITY_BOUND = {"wallet", "telegram", "whatsapp", "email", "phone",
                  "analytics_id", "adsense_id", "gtag_id"}

# Plain-language reasons a shared indicator can have nothing to do with common
# operation. Every recorded match carries the one that fits, so the record can
# never be read as an accusation.
INNOCENT_EXPLANATION = {
    "infrastructure": ("shared hosting puts unrelated sites on the same address, "
                       "and address reuse is normal"),
    "nameserver": "most sites use a nameserver operated by someone else",
    "certificate": ("certificates are reissued and shared by hosts and CDNs across "
                    "unrelated customers"),
    "template": ("templates are bought, copied and stolen, so a shared layout can "
                 "mean imitation rather than common operation"),
    "content": "page text is routinely copied between unrelated sites",
    "analytics": ("an analytics property can be copied from a template, or left in "
                  "place by a later owner"),
    "contact": ("a contact handle can be impersonated, resold, or copied from "
                "another site"),
    "wallet": ("a receiving address can be reused by a payment processor, copied "
               "from another site, or shared by unconnected people"),
}

MIN_CATEGORIES_FOR_MATCH = 2

# A domain younger than this counts as genuinely newly created rather than
# merely newly scanned, where its registration date is actually known.
NEW_DOMAIN_MAX_AGE_DAYS = 120


def build_signature(cluster_id: int) -> dict:
    """
    Derives a family signature from what a cluster's members actually share.
    Returns {"indicators": [...], "categories": [...], "note": str}.
    """
    cluster = db.get_cluster(cluster_id)
    if not cluster:
        return {"indicators": [], "categories": [], "note": f"No cluster {cluster_id}."}

    member_ids = [m["site_id"] for m in cluster["members"]]
    if len(member_ids) < 2:
        return {"indicators": [], "categories": [],
                "note": "A single-site cluster has nothing shared to build a signature from."}

    # Count how many members carry each indicator; only shared ones qualify.
    seen = {}
    for site_id in member_ids:
        for row in db.indicators_for_site(site_id):
            key = (row["indicator_type"], row["value"])
            entry = seen.setdefault(key, {
                "indicator_type": row["indicator_type"], "value": row["value"],
                "site_count": row.get("site_count") or 0, "members": 0})
            entry["members"] += 1

    indicators, categories = [], set()
    skipped_noise = 0
    for entry in seen.values():
        if entry["members"] < 2:
            continue
        itype = entry["indicator_type"]
        if itype in WEAK_ALONE_TYPES and itype not in INDICATOR_CATEGORY:
            continue
        limit = PROMISCUITY_LIMIT.get(itype)
        if limit and entry["site_count"] > limit:
            skipped_noise += 1
            continue
        category = INDICATOR_CATEGORY.get(itype, "other")
        indicators.append({
            "indicator_type": itype, "value": entry["value"], "category": category,
            "shared_by_members": entry["members"],
            "strength": INDICATOR_STRENGTH.get(itype, 0.3),
            "identity_bound": itype in IDENTITY_BOUND,
        })
        categories.add(category)

    indicators.sort(key=lambda i: (-i["strength"], i["indicator_type"]))

    note = (
        f"Signature built from {len(indicators)} indicator(s) shared by at least two of "
        f"the {len(member_ids)} member site(s), spanning {len(categories)} "
        f"category/categories: {', '.join(sorted(categories)) or 'none'}."
        + (f" {skipped_noise} shared indicator(s) were left out as too common to "
           "identify anything." if skipped_noise else "")
    )
    return {"indicators": indicators, "categories": sorted(categories), "note": note,
            "member_count": len(member_ids), "evidence_class": "derived"}


def refresh_watches(min_sites: int = 2) -> dict:
    """Rebuilds a signature for every cluster worth watching."""
    built, skipped = 0, 0
    for cluster in db.list_clusters(limit=200, min_sites=min_sites):
        signature = build_signature(cluster["id"])
        if not signature["indicators"]:
            skipped += 1
            continue
        db.save_cluster_watch(cluster["id"], cluster.get("label") or f"cluster {cluster['id']}",
                              signature)
        built += 1
    return {"watches_built": built, "clusters_without_signature": skipped}


def match_site(site_id: int, watches: list = None) -> list:
    """
    Checks one site against every family signature. Returns a list of matches,
    each stating exactly which indicators matched and what else could explain
    them. A site already inside a cluster is not matched against its own family.
    """
    site = db.get_site(site_id)
    if not site:
        return []

    own_cluster = db.cluster_for_site(site_id)
    own_cluster_id = own_cluster["id"] if own_cluster else None

    site_indicators = {(r["indicator_type"], r["value"]) for r in db.indicators_for_site(site_id)}
    if not site_indicators:
        return []

    matches = []
    for watch in (watches if watches is not None else db.list_cluster_watches()):
        if watch["cluster_id"] == own_cluster_id:
            continue
        signature = watch.get("signature") or {}
        hits = [ind for ind in signature.get("indicators", [])
                if (ind["indicator_type"], ind["value"]) in site_indicators]
        if not hits:
            continue

        categories = {h["category"] for h in hits}
        identity_hits = [h for h in hits if h.get("identity_bound")]

        if identity_hits:
            basis = (f"matched {len(identity_hits)} indicator(s) that an operator supplies "
                     "rather than inherits from a host")
        elif len(categories) >= MIN_CATEGORIES_FOR_MATCH:
            basis = (f"matched {len(hits)} indicator(s) across {len(categories)} independent "
                     f"categories ({', '.join(sorted(categories))})")
        else:
            # One category, nothing identity-bound: not enough to be worth a flag.
            continue

        explanations = sorted({INNOCENT_EXPLANATION.get(c, "") for c in categories} - {""})
        strongest = max(hits, key=lambda h: h["strength"])
        explanation = (
            f"Shares {len(hits)} indicator(s) with the family {watch['cluster_label']!r}: "
            + "; ".join(f"{h['indicator_type']} {str(h['value'])[:40]}" for h in hits[:4])
            + f". This {basis}. "
            + "Other explanations that fit the same evidence: "
            + "; ".join(explanations)
            + ". Recorded as a lead to check, not as a finding about who runs the site."
        )

        matches.append({
            "cluster_id": watch["cluster_id"], "cluster_label": watch["cluster_label"],
            "site_id": site_id, "domain": site["domain"],
            "matched": hits, "categories": sorted(categories),
            "identity_bound_matches": len(identity_hits),
            "matched_indicator_type": strongest["indicator_type"],
            "matched_indicator_value": strongest["value"],
            "match_strength": round(
                min(1.0, sum(h["strength"] for h in hits) / 2.0), 3),
            "explanation": explanation,
            "evidence_class": "derived",
        })

    matches.sort(key=lambda m: m["match_strength"], reverse=True)
    return matches


def assess_newness(site_id: int, cluster_formed_at: float) -> dict:
    """
    Is this a genuinely new site, or one that has existed all along and only
    just came to our attention? (v0.5)

    v0.4 treated "added to our database after the cluster formed" as new. That
    conflates two different things and the difference matters: a domain
    registered last week that matches a known family is a family that is still
    operating, which is worth acting on. A five-year-old domain we happened to
    scan yesterday is just a gap in our own coverage being filled, which is
    worth recording and nothing more.

    So this looks for evidence of the domain's own age and says which kind of
    new it is — and, where the age is unknown, says that too instead of
    guessing.
    """
    site = db.get_site(site_id)
    if not site:
        return {"newly_appearing": False, "kind": "unknown",
                "explanation": f"No site {site_id}."}

    first_seen_by_us = site.get("added_at") or 0
    new_to_us = first_seen_by_us >= (cluster_formed_at or 0)

    profile = db.get_deep_profile(site_id)
    age_days = (profile or {}).get("domain_age_days")

    if not new_to_us:
        return {
            "newly_appearing": False, "kind": "predates_cluster",
            "domain_age_days": age_days,
            "explanation": ("This site was already on record before the family was formed, so "
                            "it is not the family expanding — it is part of what defined it. "
                            "Recorded as a match, not as a new arrival."),
        }

    if age_days is None:
        return {
            "newly_appearing": True, "kind": "new_to_us",
            "domain_age_days": None,
            "explanation": ("New to this installation since the family was formed. The "
                            "domain's own registration date is not known, so whether the "
                            "domain itself is new or simply newly noticed is undetermined — "
                            "it is not being assumed either way."),
        }

    if age_days <= NEW_DOMAIN_MAX_AGE_DAYS:
        return {
            "newly_appearing": True, "kind": "newly_registered",
            "domain_age_days": age_days,
            "explanation": (f"The domain itself is {int(age_days)} day(s) old and matches a "
                            "family already on record — a genuinely new site rather than a "
                            "gap in our coverage. This is the case worth acting on quickly."),
        }

    return {
        "newly_appearing": True, "kind": "newly_noticed",
        "domain_age_days": age_days,
        "explanation": (f"New to this installation, but the domain is {int(age_days)} day(s) "
                        "old, so it has existed for some time and has only now been scanned. "
                        "That is our coverage catching up rather than the family expanding."),
    }


def scan_for_new_family_members(since: float = None, limit: int = 500,
                                 progress_cb=None) -> dict:
    """
    The watch itself: checks recently-seen sites against every family signature
    and records the ones that match. Only sites first seen after a family was
    formed are treated as "newly appearing"; older sites are reported as
    matches but not as new arrivals, because a site that predates the cluster
    is not evidence of the family expanding.
    """
    progress = progress_cb or (lambda e, d: None)
    watches = db.list_cluster_watches()
    if not watches:
        return {"checked": 0, "matches": 0, "new_domains": 0,
                "note": "No family signatures exist yet — run correlation first."}

    cutoff = since if since is not None else 0.0
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT id, domain, added_at FROM sites WHERE COALESCE(added_at,0) >= ? "
            "ORDER BY added_at DESC LIMIT ?", (cutoff, limit)).fetchall()
        candidates = [dict(r) for r in rows]

    checked = matched = recorded = 0
    findings = []
    for row in candidates:
        checked += 1
        for match in match_site(row["id"], watches=watches):
            matched += 1
            watch = next((w for w in watches if w["cluster_id"] == match["cluster_id"]), None)
            formed_at = (watch or {}).get("created_at") or 0
            newness = assess_newness(row["id"], formed_at)
            newly_appearing = newness["newly_appearing"]
            match["newness"] = newness

            if newly_appearing and db.record_cluster_new_domain(
                    match["cluster_id"], row["id"], row["domain"],
                    match["matched_indicator_type"], match["matched_indicator_value"],
                    match["explanation"] + " " + newness["explanation"]):
                recorded += 1
                db.add_timeline_event(
                    row["id"], "cluster_match", "derived",
                    f"Matches the shape of family {match['cluster_label']!r}",
                    match["explanation"])
                progress("cluster_new_domain", {
                    "site_id": row["id"], "domain": row["domain"],
                    "cluster_id": match["cluster_id"],
                    "cluster_label": match["cluster_label"],
                    "match_strength": match["match_strength"],
                    "reason": match["explanation"]})
            match["newly_appearing"] = newly_appearing
            findings.append(match)

    by_kind = {}
    for finding in findings:
        kind = (finding.get("newness") or {}).get("kind", "unknown")
        by_kind[kind] = by_kind.get(kind, 0) + 1

    return {
        "checked": checked, "matches": matched, "new_domains": recorded,
        "by_newness": by_kind,
        "newly_registered": by_kind.get("newly_registered", 0),
        "findings": findings[:100], "checked_at": time.time(),
        "note": ("Matches list sites that share specific public indicators with a known "
                 "family. Shared indicators are a reason to look, not evidence of common "
                 "ownership or wrongdoing."),
    }


def watch_report() -> dict:
    """Everything the watch currently knows, for the UI and the platform export."""
    watches = db.list_cluster_watches()
    out = []
    for watch in watches:
        signature = watch.get("signature") or {}
        out.append({
            "cluster_id": watch["cluster_id"], "cluster_label": watch["cluster_label"],
            "categories": signature.get("categories", []),
            "indicator_count": len(signature.get("indicators", [])),
            "identity_bound_count": sum(
                1 for i in signature.get("indicators", []) if i.get("identity_bound")),
            "new_matches": watch.get("new_matches", 0),
            "note": signature.get("note", ""),
            "evidence_class": "derived",
        })
    return {"watches": out, "new_domains": db.list_cluster_new_domains(limit=100)}
