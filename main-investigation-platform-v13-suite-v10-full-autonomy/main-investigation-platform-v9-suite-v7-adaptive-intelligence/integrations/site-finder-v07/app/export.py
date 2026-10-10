"""
Exporters: getting intelligence out in the shapes other tools expect.

Two target formats, plus a complete evidence bundle:

  cryptowalletlogger  : wallet-centric — one row per wallet, with the sites it
                        appeared on and its validation/activity state.
  wallet_investigator : investigation-centric — one record per site, nesting
                        pages, deposit options, wallets and relationships,
                        which is how an investigator reads a case.
  evidence_bundle     : everything known about a site or cluster, including the
                        observed/derived split, for archival or handover.

A note on format fidelity: the two named formats are implemented from their
documented/typical CSV and JSON shapes. I have not been able to validate the
output against a live copy of either tool from this environment, so the column
sets are the best-supported interpretation rather than a verified match. Both
exporters keep their field mapping in one obvious dict at the top so adjusting
to the exact build you run is a one-line change, and the raw evidence bundle is
always available as a lossless fallback.
"""
import csv
import io
import json
import logging
import time

from app import db

logger = logging.getLogger("scamhunter.export")

# ---- CryptoWalletLogger column mapping (edit here if your build differs) ----
CWL_COLUMNS = [
    "wallet_address", "currency", "network", "source_url", "source_domain",
    "date_found", "amount_received", "transaction_count", "scam_type",
    "confidence", "validated", "notes",
]

# ---- Wallet Investigator field mapping ----
WI_FIELDS = [
    "target_url", "target_domain", "investigation_date", "risk_score",
    "confidence_score", "wallets", "deposit_methods", "related_domains",
    "infrastructure", "contacts", "evidence_notes",
]


def _iso(timestamp) -> str:
    if not timestamp:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(timestamp))


def _profiles_for_export(site_ids=None, min_confidence=0.0):
    if site_ids:
        return [p for p in (db.get_deep_profile(s) for s in site_ids) if p]
    return db.list_deep_profiles(min_confidence=min_confidence, limit=1000)


def export_cryptowalletlogger(site_ids=None, min_confidence: float = 0.70) -> str:
    """
    Wallet-centric CSV: one row per (wallet, site) sighting.

    A wallet found on four sites becomes four rows, because the sighting — this
    address, on this page, at this time — is the unit of evidence that matters
    for a wallet logger.
    """
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=CWL_COLUMNS, extrasaction="ignore")
    writer.writeheader()

    for profile in _profiles_for_export(site_ids, min_confidence):
        site_id = profile["site_id"]
        site = db.get_site(site_id)
        if not site:
            continue
        for wallet in db.wallets_with_validation_for_site(site_id):
            # Prefer the exact page the address was seen on over the site root.
            source_url = site["url"]
            with db.get_conn() as conn:
                row = conn.execute(
                    """SELECT p.url FROM wallet_sightings ws
                       LEFT JOIN pages p ON p.id = ws.page_id
                       WHERE ws.wallet_id=? AND ws.site_id=? AND p.url IS NOT NULL LIMIT 1""",
                    (wallet["id"], site_id),
                ).fetchone()
                if row and row["url"]:
                    source_url = row["url"]

            writer.writerow({
                "wallet_address": wallet["address"],
                "currency": wallet.get("network", ""),
                "network": wallet.get("network_confirmed") or wallet.get("network", ""),
                "source_url": source_url,
                "source_domain": site["domain"],
                "date_found": _iso(wallet.get("added_at")),
                "amount_received": wallet.get("total_received") or "",
                "transaction_count": wallet.get("tx_count") if wallet.get("tx_count") is not None else "",
                "scam_type": profile.get("discovery_category") or "crypto_investment_scam",
                "confidence": f"{profile.get('confidence_score', 0):.2f}",
                "validated": "yes" if wallet.get("format_valid") else "no",
                "notes": (wallet.get("validation_detail") or "")[:300],
            })

    return output.getvalue()


def export_wallet_investigator(site_ids=None, min_confidence: float = 0.70) -> str:
    """
    Investigation-centric JSON: one record per site with everything nested
    beneath it, mirroring how an investigator actually works through a case.
    """
    records = []

    for profile in _profiles_for_export(site_ids, min_confidence):
        site_id = profile["site_id"]
        site = db.get_site(site_id)
        if not site:
            continue

        wallets = [{
            "address": w["address"],
            "network": w.get("network_confirmed") or w.get("network", ""),
            "validated": bool(w.get("format_valid")),
            "validation_detail": w.get("validation_detail", ""),
            "transaction_count": w.get("tx_count"),
            "balance": w.get("balance"),
            "total_received": w.get("total_received"),
            "activity_source": w.get("activity_source"),
        } for w in db.wallets_with_validation_for_site(site_id)]

        deposits = [{
            "page_url": d["page_url"], "method": d["method"], "network": d["network"],
            "label": d["label"], "minimum": d["min_amount"],
            "instructions": (d["instructions"] or "")[:400],
            "still_present": bool(d["still_present"]),
        } for d in db.deposit_options_for_site(site_id)]

        related = [{
            "domain": r["other_domain"], "relation": r["relation_type"],
            "shared_indicator": f"{r.get('indicator_type')}={r.get('indicator_value')}",
            "strength": r["strength"],
            "why": r["explanation"],
            "evidence_class": r["evidence_class"],
        } for r in db.relationships_for_site(site_id)]

        indicators = db.indicators_for_site(site_id)
        infrastructure = {
            "ip": [i["value"] for i in indicators if i["indicator_type"] == "ip"],
            "nameservers": [i["value"] for i in indicators if i["indicator_type"] == "nameserver"],
            "tls_cert_sha256": [i["value"] for i in indicators if i["indicator_type"] == "cert_sha256"],
            "analytics_ids": [i["value"] for i in indicators if i["indicator_type"] == "analytics_id"],
            "template_hash": [i["value"] for i in indicators if i["indicator_type"] == "template_hash"],
        }

        cluster = db.cluster_for_site(site_id)

        records.append({
            "target_url": profile.get("full_url") or site["url"],
            "target_domain": profile.get("domain") or site["domain"],
            "investigation_date": _iso(profile.get("analyzed_at")),
            "risk_score": profile.get("risk_score"),
            "confidence_score": profile.get("confidence_score"),
            "site_title": profile.get("site_title"),
            "site_description": profile.get("site_description"),
            "wallets": wallets,
            "deposit_methods": deposits,
            "related_domains": related,
            "infrastructure": infrastructure,
            "contacts": profile.get("contact_info") or {},
            "social_links": profile.get("social_links") or [],
            "threat_intel": profile.get("threat_intel") or [],
            "cluster": ({"id": cluster["id"], "label": cluster["label"],
                          "site_count": cluster["site_count"],
                          "summary": cluster["summary"]} if cluster else None),
            "flag_reasons": profile.get("flag_reasons") or [],
            "evidence_notes": profile.get("evidence_summary", ""),
            "screenshots": [s.get("path") for s in (profile.get("screenshots") or [])],
            "domain_age_days": profile.get("domain_age_days"),
            "discovery_source": profile.get("discovery_source"),
        })

    return json.dumps({
        "format": "wallet_investigator",
        "generated_at": _iso(time.time()),
        "record_count": len(records),
        "records": records,
    }, indent=2)


def export_evidence_bundle(site_id: int) -> str:
    """
    Complete, lossless record for one site — every observation and every derived
    conclusion, explicitly separated. This is the archival/handover format, and
    the fallback if a downstream tool's schema doesn't fit the mappings above.
    """
    site = db.get_site(site_id)
    if not site:
        return json.dumps({"error": f"No site with id {site_id}"})

    profile = db.get_deep_profile(site_id) or {}
    indicators = db.indicators_for_site(site_id)

    observed = {
        "site": site,
        "pages": db.pages_for_site(site_id),
        "wallets": db.wallets_with_validation_for_site(site_id),
        "deposit_options": db.deposit_options_for_site(site_id),
        "indicators": [{
            "type": i["indicator_type"], "value": i["value"],
            "observed_at": _iso(i["first_observed"]),
            "last_seen": _iso(i["last_observed"]),
            "still_present": bool(i["still_present"]),
            "source_url": i["source_url"], "source_method": i["source_method"],
            "context": i["context_snippet"],
        } for i in indicators],
        "triage": db.get_triage(site_id),
        "history": db.history_for_site(site_id),
    }

    derived = {
        "profile": profile,
        "relationships": db.relationships_for_site(site_id),
        "cluster": db.cluster_for_site(site_id),
        "confidence_score": profile.get("confidence_score"),
        "flag_reasons": profile.get("flag_reasons", []),
    }

    return json.dumps({
        "format": "scamhunter_evidence_bundle",
        "version": 2,
        "generated_at": _iso(time.time()),
        "note": ("'observed' contains facts recorded directly from the site, DNS or TLS. "
                 "'derived' contains conclusions this software reached by comparing those "
                 "facts. They are kept apart deliberately so a reviewer can tell "
                 "measurements from inferences."),
        "observed": observed,
        "derived": derived,
        "timeline": db.timeline_for_site(site_id),
    }, indent=2, default=str)


def export_cluster(cluster_id: int) -> str:
    """The whole family in one document, with each member's evidence attached."""
    cluster = db.get_cluster(cluster_id)
    if not cluster:
        return json.dumps({"error": f"No cluster with id {cluster_id}"})

    members = []
    for member in cluster["members"]:
        site_id = member["site_id"]
        profile = db.get_deep_profile(site_id) or {}
        members.append({
            "domain": member.get("domain"),
            "url": member.get("url"),
            "join_reason": member.get("join_reason"),
            "confidence_score": profile.get("confidence_score"),
            "wallets": [{"address": w["address"], "network": w.get("network"),
                          "validated": bool(w.get("format_valid"))}
                         for w in db.wallets_with_validation_for_site(site_id)],
            "relationships": [{
                "other_domain": r["other_domain"], "relation": r["relation_type"],
                "why": r["explanation"], "evidence_class": r["evidence_class"],
            } for r in db.relationships_for_site(site_id)],
        })

    return json.dumps({
        "format": "scamhunter_cluster",
        "generated_at": _iso(time.time()),
        "cluster": {
            "id": cluster["id"], "label": cluster["label"],
            "site_count": cluster["site_count"],
            "distinct_indicator_types": cluster["distinct_indicator_types"],
            "strong_indicator_types": cluster["strong_indicator_types"],
            "priority_score": cluster["priority_score"],
            "summary": cluster["summary"],
            "evidence_class": "derived",
        },
        "members": members,
    }, indent=2, default=str)


EXPORTERS = {
    "cryptowalletlogger": ("text/csv", "csv", export_cryptowalletlogger),
    "wallet_investigator": ("application/json", "json", export_wallet_investigator),
}
