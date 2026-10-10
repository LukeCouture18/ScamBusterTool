"""
Site Finder's internal models, expressed in the platform's own record types.

This is the translation boundary. Site Finder keeps its own discovery models —
campaigns, pivot leads, convergence, path quality, technique yield — because
they are how it does its job. None of that crosses the wire in Site Finder's
shape. It crosses as v4 records.

WHERE INTERNAL DETAIL GOES
--------------------------
`baseRecord` in lib/ingestion.ts is `.passthrough()`: unknown fields are
preserved on the source observation rather than rejected. That is the
contract's own extension point, and it is the only one used here. Site Finder
adds no top-level envelope field, no event type, no endpoint and no status
value — anything that would need one goes in the gap report instead.

EXTERNAL IDS ARE STABLE AND SCOPED
----------------------------------
`source_module + record_type + external_id` identifies one source observation
(API.md). So `external_id` must be stable for the same fact and unique across
different facts. Every builder here derives it from the fact itself, never
from a timestamp or run id, which is what makes resubmission an update rather
than a duplicate.

WHAT THESE RECORDS ASSERT
-------------------------
Observations, and clearly-labelled derivations of them. A relationship is sent
with `assertion_kind: "derived"` and the evidence that supports it, never as an
observed fact, because a shared indicator is something Site Finder concluded by
comparing two observations. Nothing sent here says two sites share an operator
or reaches a conclusion about any site — and `classification` carries what was observed
about a candidate, not a verdict on it.
"""
import hashlib
import json
import time

from app import db
from app.integration.v4 import contract

MODULE = contract.MODULE_NAME


def iso(timestamp: float = None) -> str:
    """UTC ISO-8601 with an offset, which is what z.string().datetime({offset:true}) wants."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ",
                         time.gmtime(timestamp if timestamp else time.time()))


def _stable(*parts) -> str:
    material = "|".join(str(p) for p in parts)
    return hashlib.sha256(material.encode("utf-8", "ignore")).hexdigest()[:32]


def unit_confidence(value, default: float = 0.5) -> float:
    """
    The platform's schema requires confidence in [0, 1]. v0.7 triage scores are
    sums of category weights (the quality gate needs >= 6.0), and v0.7 sent them
    here unchanged, so every genuinely promoted site was rejected by the
    platform. Scores above 1 are mapped onto [0, 1] (15 points = certain).
    """
    try:
        x = float(value)
    except (TypeError, ValueError):
        return default
    if x != x or x < 0:
        return default
    return round(min(1.0, x / 15.0), 4) if x > 1.0 else round(x, 4)


def external_id(kind: str, *parts) -> str:
    """
    A stable external_id for one fact. Scoped by kind so a site and a piece of
    evidence about it can never collide, and derived only from the fact, so
    re-sending the same fact updates rather than duplicates.
    """
    return f"sf:{kind}:{_stable(*parts)}"


# ---------------------------------------------------------------------------
# Provenance — free-form in the contract (z.record), so Site Finder's own
# discovery detail is carried here without extending the envelope.
# ---------------------------------------------------------------------------

def provenance_for_site(site: dict, paths: list = None) -> dict:
    paths = paths or []
    return {
        "producer": MODULE,
        "producer_role": ("discovery, lightweight public triage and correlation only; "
                          "this module does not crawl sites or inspect pages"),
        "discovery_source": site.get("source") or "unknown",
        "discovery_reason": site.get("discovery_reason") or "",
        "discovery_confidence": site.get("discovery_confidence"),
        "discovery_category": site.get("discovery_category") or "",
        "first_seen_at": iso(site.get("added_at")) if site.get("added_at") else None,
        "discovery_paths": [
            {"path_text": p.get("path_text"), "pivot_type": p.get("pivot_type"),
             "indicator_type": p.get("indicator_type"),
             "depth": p.get("depth"), "link_strength": p.get("link_strength"),
             "origin_domain": p.get("origin_domain")}
            for p in paths[:10]
        ],
        "observation_scope": "public",
    }


# ---------------------------------------------------------------------------
# Record builders
# ---------------------------------------------------------------------------

def investigation_record(site: dict, priority: str = "normal") -> dict:
    """
    An investigation Site Finder is opening for a candidate. The platform keys
    investigations by external_id, so the same domain always joins the same
    investigation rather than opening a new one on every discovery.
    """
    domain = site["domain"]
    return {
        "external_id": external_id("investigation", domain),
        "title": f"Candidate site: {domain}",
        "status": "open",
        "priority": priority,
        "confidence": float(site.get("discovery_confidence") or 0.5),
        "observed_at": iso(site.get("added_at")),
        "provenance": provenance_for_site(site),
        # passthrough: read by the platform's profile selection when present
        "description": (site.get("discovery_reason") or
                        f"Surfaced by {MODULE} from {site.get('source') or 'discovery'}."),
    }


def site_record(site: dict, triage: dict = None, priority=None,
                categories: dict = None, paths: list = None,
                investigation_external_id: str = None) -> dict:
    """
    The candidate itself. Ingesting this is what makes the platform publish a
    routed `site.discovered` — so this record IS the handoff.

    `priority` is a contract field the ingestion adapter copies into the
    published event's payload, where `priorityValue()` reads it when queueing
    INVESTIGATE_SITE. It is how Site Finder says "this one first" without
    needing an event type of its own.
    """
    domain = site["domain"]
    record = {
        "external_id": external_id("site", domain),
        "canonical_key": contract.normalize_canonical_key("site", {"url": site["url"]}),
        "display_name": domain,
        "confidence": unit_confidence(
            (triage or {}).get("triage_score")
            if triage and (triage.get("triage_score") is not None)
            else (site.get("discovery_confidence") or 0.5)),
        "observed_at": iso(site.get("added_at")),
        "provenance": provenance_for_site(site, paths),
        # --- passthrough fields: preserved on the source observation ---
        "url": site["url"],
        "triage": {"outcome": "triaged" if triage else "observed",
                   "request_downstream": False,
                   "confidence": unit_confidence((triage or {}).get("triage_score") or 0.5),
                   "indicator_categories": sorted(categories or {}),
                   "evidence_ids": [],
                   "method": "one unauthenticated public HTTP GET" if triage else "public discovery"},
        "evidence_categories": sorted(categories) if categories else [],
        "category_count": len(categories or {}),
    }
    if investigation_external_id:
        record["investigation_id"] = investigation_external_id
    if priority is not None:
        record["priority"] = priority
    # `classification` describes what was observed, never a verdict.
    if categories:
        record["classification"] = "multi_indicator_candidate"
    return record


def wallet_record(site: dict, address: str, network: str = "",
                  source_url: str = "", also_seen: list = None,
                  investigation_external_id: str = None) -> dict:
    """
    A payment address observed on a page. Ingesting it publishes
    `wallet.observed`, which v4 routes to `wallet:log`.

    Confidence stays modest on purpose: Site Finder sees an address on a page,
    it does not validate on-chain activity. Overstating it here would trip the
    platform's own `wallet.observed -> wallet.validated` confidence threshold
    on evidence this module never gathered.
    """
    record = {
        "external_id": external_id("wallet", network or "unknown", address),
        "canonical_key": contract.normalize_canonical_key(
            "wallet", {"address": address, "network": network or "unknown"}),
        "display_name": address,
        "network": network or "unknown",
        "address": address,
        "confidence": 0.5,
        "observed_at": iso(),
        "provenance": {
            "producer": MODULE,
            "observation_scope": "public",
            "observed_on": site.get("domain"),
            "source_url": source_url,
            "method": "address extracted from public page text",
            "note": ("Observed on a public page. Reuse across sites has ordinary "
                     "explanations — a shared payment processor, an address copied from "
                     "another site — so this is an observation, not an attribution."),
        },
        "also_seen_on": [o.get("domain") for o in (also_seen or [])][:25],
    }
    if investigation_external_id:
        record["investigation_id"] = investigation_external_id
    return record


def infrastructure_record(site: dict, indicator_type: str, value: str,
                          site_count: int = None,
                          investigation_external_id: str = None) -> dict:
    """
    Where a domain is hosted or served from. This record type publishes no
    event, which is correct: hosting is context for an investigator, not
    something to route work on.
    """
    record = {
        "external_id": external_id("infra", indicator_type, value),
        "canonical_key": f"{indicator_type}:{value}".lower(),
        "display_name": f"{indicator_type} {value}",
        "indicator_type": indicator_type,
        "value": value,
        "site_count": site_count,
        "confidence": 0.5,
        "observed_at": iso(),
        "provenance": {
            "producer": MODULE, "observation_scope": "public",
            "observed_on": site.get("domain"),
            "note": ("Sites share hosting, nameservers and certificates constantly with no "
                     "connection between them. This is context, not a link."),
        },
    }
    if investigation_external_id:
        record["investigation_id"] = investigation_external_id
    return record


def evidence_record(site: dict, title: str, context_text: str,
                    evidence_type: str, entity_canonical_key: str = None,
                    entity_type: str = "site", confidence: float = 0.5,
                    evidence_class: str = "derived_observation",
                    investigation_external_id: str = None) -> dict:
    """
    A piece of supporting evidence. Schema 1.1 relationships REQUIRE
    evidence_ids, so every relationship Site Finder sends is accompanied by the
    evidence record that justifies it, in the same batch.

    `evidence_class` is the contract's enum, not Site Finder's: what this
    module produces is `observed_website` when it is a raw observation and
    `derived_observation` when it is something the correlation engine
    concluded. Nothing from this module is ever `blockchain_fact`.
    """
    if evidence_class not in contract.EVIDENCE_CLASSES:
        raise ValueError(f"evidence_class must be one of {contract.EVIDENCE_CLASSES}")
    record = {
        "external_id": external_id("evidence", evidence_type, title,
                                   entity_canonical_key or site.get("domain", "")),
        "evidence_type": evidence_type,
        "evidence_class": evidence_class,
        "observation_scope": "public",
        "title": title,
        "context_text": context_text,
        "confidence": float(confidence),
        "observed_at": iso(),
        "provenance": {"producer": MODULE, "observation_scope": "public"},
    }
    if entity_canonical_key:
        record["entity"] = {"entity_type": entity_type,
                            "canonical_key": entity_canonical_key}
    if investigation_external_id:
        record["investigation_id"] = investigation_external_id
    return record


def relationship_record(site_a: dict, site_b: dict, relationship_type: str,
                        explanation: str, strength: float,
                        evidence_ids: list,
                        investigation_external_id: str = None) -> dict:
    """
    A link between two sites, as a DERIVED assertion.

    `assertion_kind` is always "derived" for this module: Site Finder concluded
    the link by comparing two observations, which is exactly what the
    contract's "derived" means. Sending it as "observed" would claim the link
    itself was seen, which it never was. Schema 1.1 refuses a derived
    relationship with no evidence_ids, and that refusal is correct — so the
    caller must pass the evidence it is built on.
    """
    if not evidence_ids:
        raise ValueError(
            "A derived relationship requires supporting evidence_ids under schema 1.1. "
            "Build the evidence record first and send both in the same batch.")
    record = {
        "external_id": external_id("rel", site_a["domain"], site_b["domain"],
                                   relationship_type),
        "relationship_type": relationship_type,
        "from": {"entity_type": "site",
                 "canonical_key": contract.normalize_canonical_key(
                     "site", {"url": site_a["url"]})},
        "to": {"entity_type": "site",
               "canonical_key": contract.normalize_canonical_key(
                   "site", {"url": site_b["url"]})},
        "assertion_kind": "derived",
        "evidence_ids": list(evidence_ids),
        "confidence": float(max(0.0, min(1.0, strength))),
        "observed_at": iso(),
        "provenance": {
            "producer": MODULE,
            "derivation": "correlation over stored public observations",
            "explanation": explanation,
            "caveat": ("Two sites showing the same public artifact. Shared hosting, a copied "
                       "template, a recycled certificate, a resold handle and a compromised "
                       "site all produce this same observation, so it is a lead to weigh — "
                       "not a finding about who runs either site, or about whether "
                       "either is doing anything wrong."),
        },
    }
    if investigation_external_id:
        record["investigation_id"] = investigation_external_id
    return record


def discovery_path_record(site: dict, paths: list,
                          investigation_external_id: str = None) -> dict:
    """
    How Site Finder reached this candidate, as the contract's own
    `discovery_paths` record. `steps` is required and must be non-empty.
    """
    steps = []
    for path in paths[:20]:
        steps.append({
            "pivot_type": path.get("pivot_type"),
            "indicator_type": path.get("indicator_type"),
            "depth": path.get("depth"),
            "link_strength": path.get("link_strength"),
            "origin_domain": path.get("origin_domain"),
            "path_text": path.get("path_text"),
        })
    if not steps:
        steps = [{"pivot_type": "direct",
                  "path_text": f"{site.get('source') or 'discovery'} → {site['domain']}",
                  "depth": 0}]

    record = {
        "external_id": external_id("path", site["domain"]),
        "canonical_key": contract.normalize_canonical_key("site", {"url": site["url"]}),
        "display_name": f"Discovery path to {site['domain']}",
        "steps": steps,
        "confidence": float(max((p.get("link_strength") or 0) for p in paths) if paths else 0.5),
        "observed_at": iso(),
        "provenance": provenance_for_site(site, paths),
    }
    if investigation_external_id:
        record["investigation_id"] = investigation_external_id
    return record


def module_activity_record(status: str, message: str, metrics: dict,
                           activity_key: str) -> dict:
    """
    Campaign and health reporting. v4 has no `campaign.updated` event, and
    inventing one is not an option — `module_activity` is the contract's place
    for a module to report what it is doing, so campaign progress goes here.
    """
    if status not in contract.MODULE_ACTIVITY_STATUSES:
        raise ValueError(f"status must be one of {contract.MODULE_ACTIVITY_STATUSES}")
    return {
        "external_id": external_id("activity", activity_key),
        "status": status,
        "message": message[:2000],
        "metrics": metrics or {},
        "confidence": 1.0,
        "observed_at": iso(),
        "provenance": {"producer": MODULE},
    }


def finding_record(site: dict, title: str, body: str,
                   finding_type: str = "discovery_summary",
                   confidence: float = 0.5,
                   investigation_external_id: str = None) -> dict:
    """A short written summary for a human reading the investigation."""
    record = {
        "external_id": external_id("finding", finding_type, site["domain"]),
        "title": title, "body": body, "finding_type": finding_type,
        "confidence": float(confidence),
        "entity": {"entity_type": "site",
                   "canonical_key": contract.normalize_canonical_key(
                       "site", {"url": site["url"]})},
        "observed_at": iso(),
        "provenance": provenance_for_site(site),
    }
    if investigation_external_id:
        record["investigation_id"] = investigation_external_id
    return record


def empty_records() -> dict:
    """A records object with every contract key present and empty."""
    return {key: [] for key in contract.RECORD_TYPES}


def batch_id_for(kind: str, *parts) -> str:
    """
    `source_module + batch_id` makes a batch idempotent (API.md), and API.md
    says to reuse the same batch id when retrying. So the id is derived from
    the batch's CONTENT, not from the attempt — replaying returns the original
    result instead of double-ingesting.
    """
    return f"sf-{kind}-{_stable(*parts)}"


def records_size(records: dict) -> int:
    return sum(len(rows) for rows in records.values())


def validate_batch(records: dict) -> list:
    """Local checks that mirror the platform's, so a bad batch fails here."""
    problems = []
    unknown = set(records) - set(contract.RECORD_TYPES)
    if unknown:
        problems.append(f"unknown record type(s) {sorted(unknown)}; the records object "
                        "is strict in v4")
    total = records_size(records)
    if total > contract.MAX_RECORDS_PER_BATCH:
        problems.append(f"{total} records exceeds the {contract.MAX_RECORDS_PER_BATCH} "
                        "per-batch maximum")
    for row in records.get("relationships", []):
        if not row.get("evidence_ids"):
            problems.append(f"relationship {row.get('external_id')} has no evidence_ids; "
                            "schema 1.1 requires them")
    for record_type, rows in records.items():
        for row in rows:
            if not row.get("external_id"):
                problems.append(f"a {record_type} record has no external_id")
    try:
        json.dumps(records)
    except (TypeError, ValueError) as exc:
        problems.append(f"records are not JSON-serialisable: {exc}")
    return problems
