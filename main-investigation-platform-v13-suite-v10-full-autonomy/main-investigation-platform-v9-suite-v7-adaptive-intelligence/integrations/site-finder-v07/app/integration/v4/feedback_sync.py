"""
Learning what happened after the handoff, through the contract's own channel.

v4 has no "tell the discovery module how its candidate turned out" event, and
inventing one is not an option. But it does have
`GET /api/v1/investigations/{id}/context?module=site_finder`, described in
API.md as hydrating a worker with shared context, and it returns exactly what
is needed: the entities, evidence, relationships and findings that every module
has contributed to that investigation.

So Site Finder polls the context of investigations it opened and counts what
other modules added. Wallet entities that were not Site Finder's own, deposit
pages, evidence, relationships — those are the neutral outcome signals. The
contract already carries them; nothing new is required.

WHAT THIS MEASURES, AND WHAT IT DOES NOT
----------------------------------------
It measures whether a DISCOVERY was worth an investigator's time. If Site
Investigator crawled a candidate and found deposit pages and wallets, the lead
had something in it. If it found nothing, the lead was thin.

It does not measure whether a site is malicious, and nothing here writes such
a conclusion. A legitimate exchange has deposit pages and wallets too. The
outcome words are useful / thin / unreachable, deliberately about the lead.

ATTRIBUTION IS CREDITED ONCE
----------------------------
Each investigation's outcome is recorded under a deterministic feedback id, so
polling the same investigation repeatedly — which happens by design, since the
poll runs on a timer — cannot inflate the technique that produced it.
"""
import logging
import time

from app import db
from app.config import FEEDBACK_POLL_BATCH
from app.integration.v4 import contract
from app.integration.v4.client import PlatformClient, default_client

logger = logging.getLogger("scamhunter.integration.v4.feedback_sync")

# Entity types that, when contributed by another module, mean the lead
# contained something worth examining.
DOWNSTREAM_ENTITY_SIGNALS = {
    "wallet": "wallets",
    "deposit_page": "deposit_pages",
    "page": "pages_examined",
    "infrastructure_indicator": "infrastructure",
}


def _summarise_context(context: dict, our_module: str = contract.MODULE_NAME) -> dict:
    """
    Reduces an investigation context to neutral counts of what OTHER modules
    found. Site Finder's own contributions are excluded — crediting a discovery
    technique for the evidence it itself supplied would be a closed loop, and
    closed loops are exactly what downstream feedback exists to break.
    """
    counts = {"deposit_pages": 0, "wallets": 0, "infrastructure": 0,
              "relationships": 0, "pages_examined": 0}
    contributing_modules = set()
    sources_by_entity = {}
    for observation in context.get("observation_versions") or []:
        entity_id = observation.get("entity_id")
        source = observation.get("source_module")
        if entity_id and source:
            sources_by_entity.setdefault(str(entity_id), set()).add(str(source))

    for entity in context.get("entities") or []:
        entity_type = str(entity.get("entity_type") or "")
        signal = DOWNSTREAM_ENTITY_SIGNALS.get(entity_type)
        if not signal:
            continue
        downstream = sources_by_entity.get(str(entity.get("id")), set()) - {our_module}
        if not downstream:
            continue
        counts[signal] = counts.get(signal, 0) + 1
        contributing_modules.update(downstream)

    for relationship in context.get("relationships") or []:
        if relationship.get("source_module") == our_module:
            continue
        counts["relationships"] += 1
        if relationship.get("source_module"):
            contributing_modules.add(relationship["source_module"])

    for evidence in context.get("evidence") or []:
        if evidence.get("source_module") == our_module:
            continue
        contributing_modules.add(evidence.get("source_module") or "unknown")
        if str(evidence.get("evidence_type") or "").startswith("deposit"):
            counts["deposit_pages"] += 1

    jobs = context.get("jobs") or []
    investigated = [j for j in jobs
                    if j.get("job_type") == "INVESTIGATE_SITE"
                    and j.get("status") in ("completed", "failed", "needs-review")]
    reachable = None
    for job in investigated:
        if job.get("status") == "failed" and "unreachable" in str(job.get("last_error", "")).lower():
            reachable = False

    return {"counts": counts, "examined": bool(investigated),
            "reachable": reachable,
            "contributing_modules": sorted(m for m in contributing_modules if m)}


def poll_investigation(site_id: int, investigation_external_id: str,
                       client: PlatformClient = None) -> dict:
    """Fetches one investigation's context and records the outcome signals."""
    from app.discovery.feedback import record_outcome, classify_outcome

    client = client or default_client()
    context = client.investigation_context(investigation_external_id)
    if context.get("error"):
        return {"recorded": False, "reason": context["error"]}

    summary = _summarise_context(context)
    if not summary["examined"]:
        return {"recorded": False,
                "reason": ("No module has finished examining this candidate yet, so there "
                           "is nothing to learn from it.")}

    counts = summary["counts"]
    classified = classify_outcome(
        deposit_pages=counts["deposit_pages"], wallets=counts["wallets"],
        infrastructure=counts["infrastructure"], relationships=counts["relationships"],
        reachable=summary["reachable"], pages_examined=counts["pages_examined"])

    investigation = context.get("investigation") or {}
    # Deterministic: derived from the investigation and the outcome, so polling
    # again with an unchanged outcome records nothing new, while a later
    # investigation that finds more does register as a fresh signal.
    feedback_id = (f"ctx:{investigation_external_id}:"
                   f"{counts['deposit_pages']}:{counts['wallets']}:"
                   f"{counts['infrastructure']}:{counts['relationships']}")

    site = db.get_site(site_id)
    result = record_outcome(
        feedback_id, domain=(site or {}).get("domain", ""), site_id=site_id,
        investigation_id=str(investigation.get("id") or investigation_external_id),
        deposit_pages=counts["deposit_pages"], wallets=counts["wallets"],
        infrastructure=counts["infrastructure"], relationships=counts["relationships"],
        pages_examined=counts["pages_examined"], reachable=summary["reachable"],
        outcome=classified["outcome"],
        detail=(classified["detail"]
                + (f" Contributed by {', '.join(summary['contributing_modules'])}."
                   if summary["contributing_modules"] else "")))

    # The platform's own investigation UUID is worth keeping permanently, and
    # so is the job it opened — v0.6 stored neither from the v4 path, so the
    # handoff view could never show what had actually been assigned.
    if investigation.get("id"):
        db.link_platform_investigation(site_id, investigation_external_id,
                                       platform_investigation_id=str(investigation["id"]))
    investigate_jobs = [j for j in (context.get("jobs") or [])
                        if j.get("job_type") == "INVESTIGATE_SITE"]
    if investigate_jobs:
        db.set_investigator_job(site_id, str(investigate_jobs[0].get("id") or ""),
                                 state=str(investigate_jobs[0].get("status") or ""))

    return {"recorded": result.get("recorded", False),
            "outcome": classified["outcome"], "counts": counts,
            "reason": result.get("reason", ""),
            "attributed_to": result.get("attributed_to")}


def poll_outcomes(client: PlatformClient = None, limit: int = None) -> dict:
    """
    Polls the investigations Site Finder has handed over, oldest contact
    first, and folds anything new into the technique and budget ledgers.
    """
    from app.discovery.feedback import refresh_scores
    from app.integration.v4 import translator as tr

    client = client or default_client()
    limit = limit or FEEDBACK_POLL_BATCH
    if not client.configured:
        return {"polled": 0, "recorded": 0,
                "note": "No platform configured; there is nothing to poll."}

    handed_over = db.sites_sent_to_platform(limit=limit)
    polled = recorded = 0
    outcomes = []

    for row in handed_over:
        site_id = row["site_id"]
        site = db.get_site(site_id)
        if not site:
            continue
        external_id = row.get("correlation_id") or tr.external_id(
            "investigation", site["domain"])
        polled += 1
        result = poll_investigation(site_id, external_id, client=client)
        if result.get("recorded"):
            recorded += 1
            outcomes.append({"domain": site["domain"], "outcome": result["outcome"],
                             "counts": result["counts"]})

    if recorded:
        refresh_scores()

    return {
        "polled": polled, "recorded": recorded, "outcomes": outcomes,
        "checked_at": time.time(),
        "note": ("Outcome signals describe what other modules observed on a candidate. "
                 "They measure whether a discovery route produces leads worth examining — "
                 "never whether a site is malicious."),
    }
