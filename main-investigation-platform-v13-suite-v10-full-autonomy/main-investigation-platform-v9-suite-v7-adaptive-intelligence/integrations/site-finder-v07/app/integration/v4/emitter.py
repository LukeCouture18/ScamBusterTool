"""Durable schema 3.0 observation and promotion batches for Site Finder.

Discovery queues a passive site record before triage. A promoted record carries
first-class triage and references the public evidence in the same batch. The
Main Platform resolves that evidence before routing the site investigation.
Legacy v4 module paths remain for supported upgrades.
"""
import logging

from app import db
from app.config import (
    SEND_MIN_TRIAGE_SCORE, SEND_MIN_EVIDENCE_CATEGORIES, SEND_MIN_PRIORITY,
    SEND_HIGH_PRIORITY_THRESHOLD, SEND_UNTRIAGED_DISCOVERIES,
    SEND_RELATIONSHIPS_MIN_STRENGTH, SEND_WALLET_OBSERVATIONS,
    SEND_INFRASTRUCTURE_OBSERVATIONS, SEND_INFRASTRUCTURE_MAX_SITE_COUNT,
)
from app.integration.v4 import contract, translator as tr

logger = logging.getLogger("scamhunter.integration.v4.emitter")

# Which indicator types count as which independent evidence category. Site
# Finder's own model — it never crosses the wire in this shape, only as the
# resulting confidence and the passthrough detail on the site record.
EVIDENCE_CATEGORY = {
    "wallet": "payment",
    "telegram": "contact", "whatsapp": "contact", "email": "contact",
    "phone": "contact", "social": "contact",
    "template_hash": "template", "favicon_hash": "template", "page_title": "template",
    "cert_sha256": "certificate", "cert_issuer": "certificate",
    "ip": "infrastructure", "asn": "infrastructure",
    "nameserver": "infrastructure", "registrar": "infrastructure",
    "analytics_id": "analytics", "adsense_id": "analytics", "gtag_id": "analytics",
    "brand": "content", "distinctive_text": "content",
}

INFRASTRUCTURE_TYPES = {"ip", "asn", "nameserver", "registrar",
                        "cert_sha256", "cert_issuer"}


def evidence_categories(site_id: int) -> dict:
    """Which independent categories have actually fired, and what backs each."""
    categories = {}
    for row in db.indicators_for_site(site_id, only_current=True):
        category = EVIDENCE_CATEGORY.get(row["indicator_type"])
        if not category:
            continue
        categories.setdefault(category, []).append({
            "indicator_type": row["indicator_type"], "value": row["value"],
            "source_url": row.get("source_url"), "site_count": row.get("site_count"),
        })
    deposits = db.deposit_options_for_site(site_id, only_current=True)
    if deposits:
        categories["deposit"] = [
            {"method": d.get("method"), "network": d.get("network"),
             "page_url": d.get("page_url")} for d in deposits]
    return categories


def should_send_site(site_id: int) -> dict:
    """
    The gate, with both its yes and its no explained. Unchanged in substance
    from v0.5 — this is Site Finder's judgement, not the contract's.
    """
    from app.discovery import candidate_priority as cp

    site = db.get_site(site_id)
    if not site:
        return {"send": False, "high_priority": False, "reasons": [],
                "blocked_by": [f"No site {site_id}."]}

    reasons, blocked = [], []
    triage = db.get_triage(site_id)

    if not triage:
        if not SEND_UNTRIAGED_DISCOVERIES:
            blocked.append("Has not been triaged yet, and untriaged discoveries are not "
                           "sent (SEND_UNTRIAGED_DISCOVERIES is off).")
        else:
            reasons.append("Untriaged discoveries are being sent by configuration.")
    elif not triage["passed"]:
        blocked.append(f"Did not clear triage: "
                       f"{triage.get('reject_reason') or 'no reason recorded'}.")
    elif (triage.get("triage_score") or 0) < SEND_MIN_TRIAGE_SCORE:
        blocked.append(f"Triage score {triage['triage_score']:.2f} is below the send "
                       f"threshold {SEND_MIN_TRIAGE_SCORE:.2f}.")
    else:
        reasons.append(f"Cleared triage at {triage['triage_score']:.2f}.")

    categories = evidence_categories(site_id)
    if len(categories) < SEND_MIN_EVIDENCE_CATEGORIES:
        blocked.append(
            f"Only {len(categories)} independent evidence category/categories "
            f"({', '.join(sorted(categories)) or 'none'}); at least "
            f"{SEND_MIN_EVIDENCE_CATEGORIES} are required. Indicators from one category "
            "are one piece of evidence however many of them there are.")
    else:
        reasons.append(f"{len(categories)} independent evidence categories fired: "
                       f"{', '.join(sorted(categories))}.")

    priority = cp.score_candidate(site_id)
    if priority["priority"] < SEND_MIN_PRIORITY:
        blocked.append(f"Priority {priority['priority']:.2f} is below the send threshold "
                       f"{SEND_MIN_PRIORITY:.2f}.")
    else:
        reasons.append(f"Priority {priority['priority']:.2f}.")

    send = not blocked
    high_priority = send and priority["priority"] >= SEND_HIGH_PRIORITY_THRESHOLD
    if high_priority:
        reasons.append(f"At or above {SEND_HIGH_PRIORITY_THRESHOLD:.2f}, so the site record "
                       "carries high priority and the platform queues INVESTIGATE_SITE "
                       "ahead of lower-priority work.")

    return {"send": send, "high_priority": high_priority, "reasons": reasons,
            "blocked_by": blocked, "priority": priority, "categories": categories,
            "category_count": len(categories), "triage": triage}


def _platform_priority(high_priority: bool, priority_score: float) -> str:
    """
    Maps Site Finder's 0..1 priority onto the platform's own vocabulary.
    lib/events.ts priorityValue() understands critical/high/low and numbers;
    anything else is 50. Site Finder uses the words, not a raw number, so the
    platform's profile selection ("low priority selects Quick Triage, high
    priority selects Deep Investigation") behaves predictably.
    """
    if high_priority:
        return "high"
    if priority_score >= 0.45:
        return "normal"
    return "low"


def build_candidate_batch(site_id: int, include_relationships: bool = True) -> dict:
    """
    Everything the platform should know about one candidate, as one canonical
    v4 batch. Returns {"records": {...}, "batch_id": str, "decision": {...}}.

    Building is pure: nothing is sent and nothing is queued here.
    """
    decision = should_send_site(site_id)
    site = db.get_site(site_id)
    if not site or not decision["send"]:
        return {"records": None, "batch_id": None, "decision": decision}

    paths = db.paths_for_site(site_id)
    records = tr.empty_records()

    investigation = tr.investigation_record(
        site, priority=_platform_priority(decision["high_priority"],
                                          decision["priority"]["priority"]))
    inv_external_id = investigation["external_id"]
    records["investigations"].append(investigation)

    records["sites"].append(tr.site_record(
        site, triage=decision["triage"],
        priority=_platform_priority(decision["high_priority"],
                                    decision["priority"]["priority"]),
        categories=decision["categories"], paths=paths,
        investigation_external_id=inv_external_id))

    # v6 promotes only a checked triage accompanied by a stored evidence item.
    # This is a public check summary, not a verdict about the site.
    if decision["triage"] and decision["triage"].get("passed"):
        triage_evidence = tr.evidence_record(
            site, title=f"Public triage observation for {site['domain']}",
            context_text=(f"Public URL: {site['url']}. HTTP status: "
                          f"{decision['triage'].get('http_status')}. "
                          f"Observed indicator categories: "
                          f"{', '.join(sorted(decision['categories']))}. "
                          f"Triage reason: {decision['triage'].get('reject_reason') or 'passed'}. "
                          "This supports further investigation, not a maliciousness conclusion."),
            evidence_type="public_triage", evidence_class="derived_observation",
            entity_canonical_key=records["sites"][0]["canonical_key"],
            confidence=tr.unit_confidence(decision["triage"].get("triage_score") or 0.5),
            investigation_external_id=inv_external_id)
        triage_evidence["source_url"] = site["url"]
        triage_evidence["provenance"].update(tr.provenance_for_site(site, paths))
        records["evidence"].append(triage_evidence)
        records["sites"][0]["triage"] = {
            "outcome": "promoted", "request_downstream": True,
            "confidence": tr.unit_confidence(decision["triage"].get("triage_score") or 0.5),
            "indicator_categories": sorted(decision["categories"]),
            "evidence_ids": [triage_evidence["external_id"]],
            "method": "one unauthenticated public HTTP GET",
        }

    if paths:
        records["discovery_paths"].append(tr.discovery_path_record(
            site, paths, investigation_external_id=inv_external_id))

    # --- why this candidate was prioritised, as a finding a human can read ---
    records["findings"].append(tr.finding_record(
        site,
        title=f"Discovery summary for {site['domain']}",
        body=(decision["priority"]["explanation"] + " "
              + " ".join(decision["reasons"])
              + " Site Finder performed discovery and one unauthenticated triage fetch "
                "only; it has not crawled this site or accessed anything requiring "
                "credentials. Everything above is a reason to look, not a conclusion about "
                "the site or about anyone connected with it."),
        confidence=float(decision["priority"]["priority"]),
        investigation_external_id=inv_external_id))

    # --- observations ---
    for row in db.indicators_for_site(site_id, only_current=True):
        itype, value = row["indicator_type"], row["value"]
        if itype == "wallet" and SEND_WALLET_OBSERVATIONS:
            others = db.wallet_seen_elsewhere(value, "", exclude_site_id=site_id) or []
            records["wallets"].append(tr.wallet_record(
                site, value, network="", source_url=row.get("source_url") or "",
                also_seen=others, investigation_external_id=inv_external_id))
        elif itype in INFRASTRUCTURE_TYPES and SEND_INFRASTRUCTURE_OBSERVATIONS:
            site_count = row.get("site_count") or 0
            if site_count > SEND_INFRASTRUCTURE_MAX_SITE_COUNT:
                continue      # a hosting fact, not a discovery
            records["infrastructure_indicators"].append(tr.infrastructure_record(
                site, itype, value, site_count=site_count,
                investigation_external_id=inv_external_id))

    if include_relationships:
        _add_relationships(records, site, site_id, inv_external_id)

    batch_id = tr.batch_id_for("candidate", site["domain"],
                               decision["priority"]["priority"],
                               (decision["triage"] or {}).get("triage_score"),
                               len(records["wallets"]),
                               len(records["infrastructure_indicators"]),
                               len(records["relationships"]))

    return {"records": records, "batch_id": batch_id, "decision": decision,
            "investigation_external_id": inv_external_id}


def _add_relationships(records: dict, site: dict, site_id: int, inv_external_id: str):
    """
    Adds derived relationships and the evidence schema 1.1 requires for them.

    Each relationship gets its own evidence record naming the exact shared
    indicator, so the assertion is checkable rather than asserted. A
    relationship without evidence is not sent at all — the contract would
    reject it, and it would deserve to.
    """
    for rel in db.relationships_for_site(site_id):
        strength = rel.get("strength") or 0
        if strength < SEND_RELATIONSHIPS_MIN_STRENGTH:
            continue
        other_id = rel.get("other_site_id")
        other = db.get_site(other_id) if other_id else None
        if not other:
            continue

        indicator_type = rel.get("indicator_type") or "indicator"
        indicator_value = rel.get("indicator_value") or ""
        explanation = rel.get("explanation") or ""

        evidence = tr.evidence_record(
            site,
            title=(f"Shared {indicator_type} between {site['domain']} and "
                   f"{other['domain']}"),
            context_text=(
                f"Both sites were observed carrying {indicator_type} "
                f"{str(indicator_value)[:80]}. {explanation} "
                "Shared hosting, a bought or copied template, a recycled certificate, a "
                "resold contact handle and a compromised site all produce this same "
                "observation."),
            evidence_type=f"shared_{indicator_type}",
            evidence_class="derived_observation",
            entity_canonical_key=contract.normalize_canonical_key(
                "site", {"url": site["url"]}),
            confidence=float(strength),
            investigation_external_id=inv_external_id)
        records["evidence"].append(evidence)

        records["relationships"].append(tr.relationship_record(
            site, other,
            relationship_type=rel.get("relation_type") or "shares_indicator",
            explanation=explanation, strength=strength,
            evidence_ids=[evidence["external_id"]],
            investigation_external_id=inv_external_id))


def build_campaign_activity(campaign_id: int) -> dict:
    """
    Campaign progress as a `module_activity` record — the contract's place for
    a module to report what it is doing. v4 has no campaign event type, and
    inventing one is not on the table.
    """
    campaign = db.get_campaign(campaign_id)
    if not campaign:
        return {"records": None, "batch_id": None}

    stats = {k: v for k, v in (campaign.get("stats") or {}).items() if k != "wave_seeds"}
    status_map = {"running": "running", "completed": "success", "stopped": "warning",
                  "paused": "idle", "pending": "idle", "error": "error"}
    records = tr.empty_records()
    records["module_activity"].append(tr.module_activity_record(
        status=status_map.get(campaign.get("status"), "idle"),
        message=(f"Campaign {campaign.get('name')} ({campaign['seed_kind']}:"
                 f"{str(campaign['seed_value'])[:40]}) is {campaign.get('status')} at wave "
                 f"{campaign.get('current_wave')}, stage {campaign.get('current_stage')}."
                 + (f" Stopped: {campaign.get('stopped_reason')}."
                    if campaign.get("stopped_reason") else "")
                 + " Counts describe work done, not conclusions reached."),
        metrics=stats,
        activity_key=f"campaign:{campaign['campaign_key']}:{campaign.get('current_wave')}:"
                     f"{campaign.get('status')}"))

    return {"records": records,
            "batch_id": tr.batch_id_for("campaign", campaign["campaign_key"],
                                        campaign.get("status"),
                                        campaign.get("current_wave"))}


def build_health_activity() -> dict:
    """Discovery-funnel health as module_activity, for the platform dashboard."""
    from app.discovery.discovery_stats import overview
    stats = overview()
    records = tr.empty_records()
    funnel = stats["funnel"]
    records["module_activity"].append(tr.module_activity_record(
        status="idle",
        message=(f"{funnel['discovered']} candidate(s) discovered, {funnel['passed_triage']} "
                 f"cleared triage, {funnel['sent_to_platform']} sent to the platform, "
                 f"{funnel['queued_for_platform']} queued."),
        metrics={**funnel, **stats["conversion"]},
        activity_key=f"health:{funnel['discovered']}:{funnel['sent_to_platform']}"))
    return {"records": records,
            "batch_id": tr.batch_id_for("health", funnel["discovered"],
                                        funnel["passed_triage"],
                                        funnel["sent_to_platform"])}


def queue_candidate(site_id: int) -> dict:
    """
    Applies the gate and, if it passes, writes the batch to the outbox.
    Nothing here touches the network — that is what keeps discovery working
    when the platform is not.
    """
    built = build_candidate_batch(site_id)
    decision = built["decision"]

    if not built["records"]:
        site = db.get_site(site_id)
        if site:
            # Schema 3.0 permits a discovery to be observed without opening an
            # investigation. Queue it durably even when the promotion gate
            # declines the candidate; later triage can promote the same entity.
            observation = tr.empty_records()
            observation["sites"].append(tr.site_record(
                site, triage=decision.get("triage"),
                categories=decision.get("categories"),
                paths=db.paths_for_site(site_id)))
            observation_id = tr.batch_id_for(
                "observation", site["domain"],
                (decision.get("triage") or {}).get("triage_score"),
                (decision.get("triage") or {}).get("passed"),
                sorted(decision.get("categories") or {}))
            db.queue_batch(observation_id, observation, site_id=site_id,
                           kind="observation")
        return {"site_id": site_id, "sent": False,
                "blocked_by": decision["blocked_by"],
                "summary": "Kept local: " + " ".join(decision["blocked_by"])}

    site = db.get_site(site_id)
    queued = db.queue_batch(built["batch_id"], built["records"], site_id=site_id,
                            kind="candidate")

    if queued["queued"]:
        db.record_source_yield((site or {}).get("source") or "unknown", sent=1)
        db.add_timeline_event(
            site_id, "queued_for_platform", "derived",
            "Queued for the Main Investigation Platform",
            (f"Batch {built['batch_id']} holds "
             f"{tr.records_size(built['records'])} v4 record(s). "
             + " ".join(decision["reasons"])))

    return {
        "site_id": site_id, "sent": True, "queued": queued["queued"],
        "reason": queued["reason"], "batch_id": built["batch_id"],
        "high_priority": decision["high_priority"],
        "record_counts": {k: len(v) for k, v in built["records"].items() if v},
        "reasons": decision["reasons"],
        "summary": (f"Queued v4 batch {built['batch_id']} with "
                    f"{tr.records_size(built['records'])} record(s)"
                    + (" at high priority, which queues INVESTIGATE_SITE ahead of "
                       "lower-priority work" if decision["high_priority"] else "")
                    + ". " + " ".join(decision["reasons"])),
    }


def queue_campaign_update(campaign_id: int) -> dict:
    built = build_campaign_activity(campaign_id)
    if not built["records"]:
        return {"queued": False, "reason": f"No campaign {campaign_id}."}
    return db.queue_batch(built["batch_id"], built["records"], kind="campaign")


def queue_health_update() -> dict:
    built = build_health_activity()
    return db.queue_batch(built["batch_id"], built["records"], kind="health")
