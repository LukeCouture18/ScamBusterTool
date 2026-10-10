"""
Site Finder v2 <-> Main Platform v2.

OUTBOUND   Each delivered candidate becomes one schema 3.0 ingest batch in the
           existing durable outbox (the same SyncWorker delivers it, with the
           same retry, idempotency and dead-letter rules as v1):

             investigations[1]  the candidate's investigation
             sites[1]           triage outcome "promoted" with a confidence in
                                [0,1] (v1 sent its raw 6-20 point triage score here,
                                which the platform's schema rejects), plus an
                                `inbox` passthrough block the platform's inbox reads
             evidence[1]        the public_triage evidence the promotion cites
             wallets[n]         checksum-valid deposit addresses seen on the page
             discovery_paths[1] how the candidate was reached
             findings[1]        a short plain-language summary

           `request_downstream` is false by default: the platform queues site
           investigation when you mark the candidate USEFUL, not before, so no
           background budget is spent on candidates you skip. Set
           V2_AUTO_INVESTIGATE=1 to restore v1's investigate-on-promotion.

INBOUND    Your USEFUL/SKIP decisions are pulled from
           GET /api/v1/inbox/decisions and applied exactly like local ones.
           DISCOVER_SITES jobs (queued by the platform when the inbox runs low)
           run a v2 round; FIND_RELATED_SITES runs a round seeded with the site
           you marked USEFUL.
"""
from __future__ import annotations

import logging
import os
import time

from app import db
from app.v2 import store

logger = logging.getLogger("scamhunter.v2.platform")

AUTO_INVESTIGATE = os.environ.get("V2_AUTO_INVESTIGATE", "0") == "1"
METHOD = ("Site Finder v2 passive probe: DNS, one unauthenticated GET of the public page "
          "(plus its public script bundle and favicon when needed), Certificate Transparency and RDAP")


def _site_dict(cand: dict) -> dict:
    site = db.get_site(cand["site_id"]) if cand.get("site_id") else None
    if site:
        return dict(site)
    return {"domain": cand["domain"], "url": cand.get("url") or f"https://{cand['domain']}/",
            "added_at": cand.get("first_seen") or time.time(),
            "source": f"v2:{(cand.get('strategies') or ['v2'])[0]}",
            "discovery_reason": cand.get("headline") or "", "discovery_confidence": cand.get("p"),
            "discovery_category": cand.get("category") or ""}


def inbox_block(cand: dict) -> dict:
    """The compact passthrough the platform's inbox shows (and the advanced view expands)."""
    from app.v2 import intelligence
    details = cand.get("details") or {}
    related = []
    if cand.get("cluster_id"):
        related = [m["domain"] for m in store.cluster_members(cand["cluster_id"]) if m["domain"] != cand["domain"]][:20]
    signals = cand.get("signals") or []
    return {
        "version": "2",
        "candidate_id": cand["domain"],
        "worth_checking": round(float(cand.get("p") or 0), 4),
        "discovery_quality": (cand.get("selection") or {}).get("discovery_quality"),
        "headline": (cand.get("headline") or "")[:300],
        "category": cand.get("category") or "",
        "cluster_key": cand.get("cluster_id") or f"c:{cand['domain']}",
        "campaign_id": intelligence.campaign_for(cand["domain"]),
        "related_domains": related,
        "wallets": [s.get("detail") for s in signals if s.get("name") == "deposit_address" and s.get("detail")][:20],
        "strategies": cand.get("strategies") or [],
        "signals": [{"name": s.get("name"), "group": s.get("group"), "strength": s.get("strength"),
                     "phrase": s.get("phrase"),
                     "origin_url": s.get("origin_url") or ("https://" + cand["domain"] + "/"),
                     **({"upstream_id": s["upstream_id"]} if s.get("upstream_id") else {})} for s in signals][:30],
        "score": details.get("score", {}),
        "fetch": details.get("fetch", {}),
        "registered_days": details.get("registered_days"),
        "cost": details.get("cost", {}),
        # v4: observable indicators (IP, nameservers, cert SAN groups, favicon, chat
        # service, wallet) so the platform can associate campaigns and plan pivots.
        "keys": [list(k) for k in (details.get("keys") or [])][:20],
        "context": details.get("context") or "",
        # v5: what the continuous watch last observed (hosting, name servers, live/dead).
        **({"site_status": details["site_status"]} if details.get("site_status") else {}),
        **({"nameservers": list(details.get("ns") or [])[:8]} if details.get("watch_rev") else {}),
        "note": ("Observed public facts and software-derived scores. They justify a manual look; they do not "
                 "establish that the site is fraudulent or that related sites share an owner."),
        # next gen: how Site Finder reached it and why it is new (plain English; similarity, never identity)
        **({"novelty": {k: v for k, v in (details.get("ng") or {}).items()
                        if k in ("facts", "route", "depth", "parent", "reappearance_of", "same_build_as",
                                 "explain", "new_family", "returned_from", "expected_value")}}
           if details.get("ng") else {}),
    }


def build_inbox_batch(cand: dict) -> dict:
    from app.integration.v4 import contract, translator as tr
    site = _site_dict(cand)
    p = max(0.0, min(1.0, float(cand.get("p") or 0)))
    priority = "high" if p >= 0.9 else "normal"
    records = tr.empty_records()
    investigation = tr.investigation_record({**site, "discovery_confidence": p}, priority=priority)
    inv_id = investigation["external_id"]
    records["investigations"].append(investigation)

    canonical = contract.normalize_canonical_key("site", {"url": site["url"]})
    signals = cand.get("signals") or []
    phrases = [s.get("phrase") for s in signals if s.get("phrase")]
    evidence = tr.evidence_record(
        site, title=f"Public probe of {cand['domain']}",
        context_text=(f"Public URL: {site['url']}. HTTP status: {(cand.get('details') or {}).get('fetch', {}).get('status')}. "
                      f"Observed: {'; '.join(phrases[:12])}. These observations support a manual look, "
                      "not a conclusion about the site."),
        evidence_type="public_triage", evidence_class="derived_observation",
        entity_canonical_key=canonical, confidence=p, investigation_external_id=inv_id)
    evidence["source_url"] = site["url"]
    records["evidence"].append(evidence)

    record = tr.site_record(site, investigation_external_id=inv_id, priority=priority)
    groups = sorted({s.get("group") for s in signals if s.get("group") and (s.get("strength") or 0) >= 0.3})
    record["confidence"] = p
    record["classification"] = "v2_inbox_candidate"
    record["triage"] = {"outcome": "promoted", "request_downstream": AUTO_INVESTIGATE, "confidence": p,
                        "indicator_categories": groups if len(groups) >= 2 else groups + ["v2_probe"],
                        "evidence_ids": [evidence["external_id"]], "method": METHOD[:240]}
    record["evidence_categories"] = groups
    record["category_count"] = len(groups)
    record["inbox"] = inbox_block(cand)
    records["sites"].append(record)

    for s in signals:
        if s.get("name") == "deposit_address" and s.get("detail"):
            net = s.get("phrase", "").split("(")[-1].rstrip(")") if "(" in s.get("phrase", "") else ""
            records["wallets"].append(tr.wallet_record(site, s["detail"], network=net, source_url=site["url"],
                                                       investigation_external_id=inv_id))
    steps = [{"pivot_type": x["strategy"], "path_text": f"{x['strategy']}: {x.get('detail') or ''}"[:300],
              "depth": 0, "origin_domain": x.get("host")} for x in store.sightings(cand["domain"])[:12]]
    if steps:
        path = tr.discovery_path_record(site, [], investigation_external_id=inv_id)
        path["steps"] = steps
        records["discovery_paths"].append(path)
    records["findings"].append(tr.finding_record(
        site, title=f"Why {cand['domain']} is in the inbox", body=(cand.get("headline") or "")[:1000] +
        ". Site Finder observed this from public pages only; it is a reason to look, not a conclusion.",
        confidence=p, investigation_external_id=inv_id))
    # A watch revision (v5 change detection) is new content, so it gets a new idempotent batch id.
    rev = (cand.get("details") or {}).get("watch_rev")
    batch_id = tr.batch_id_for("v2inbox", cand["domain"], round(p, 3), len(signals), *( [f"watch{rev}"] if rev else []))
    return {"records": records, "batch_id": batch_id}


def queue_deliveries(delivered: list) -> int:
    queued = 0
    for cand in delivered:
        try:
            cand = store.get(cand["domain"]) or cand
            built = build_inbox_batch(cand)
            result = db.queue_batch(built["batch_id"], built["records"], site_id=cand.get("site_id"), kind="v2_inbox")
            if result.get("queued"):
                queued += 1
                store.update(cand["domain"], platform_state="queued")
        except Exception as exc:                      # noqa: BLE001
            logger.warning("could not build platform batch for %s: %s", cand.get("domain"), exc)
    return queued


# ------------------------------------------------------------------- inbound

def pull_decisions(client=None, limit: int = 100) -> dict:
    """Pulls USEFUL/SKIP decisions made in the platform inbox and applies them."""
    from app.integration.v4.client import default_client
    from app.v2 import inbox
    client = client or default_client()
    if not client.configured:
        return {"pulled": 0, "note": "No platform configured."}
    cursor = store.get_state("platform_decision_cursor", "")
    try:
        body = client.sdk.inbox_decisions(after=cursor, limit=limit) or {}
    except Exception as exc:                          # noqa: BLE001
        return {"pulled": 0, "error": str(exc)}
    applied = 0
    for d in body.get("decisions") or []:
        domain = d.get("candidate_id") or d.get("domain")
        if not domain:
            continue
        if not store.get(domain):
            store.insert_new(domain, f"https://{domain}/", "platform", 0.0)
        result = inbox.decide(domain, "useful" if d.get("decision") == "useful" else "skip",
                              reason=d.get("reason"), source="platform", external_id=str(d.get("id")))
        applied += 1 if result.get("ok") else 0
    if body.get("next_cursor"):
        store.set_state("platform_decision_cursor", body["next_cursor"])
    return {"pulled": applied, "cursor": body.get("next_cursor") or cursor}


def pull_context(client=None, limit: int = 1000) -> dict:
    """Next gen: the sites Main and Operation Hunter already hold become discovery memory.

    They are used as pivot seeds and never take one of your review slots again. Only site
    identities travel; no evidence or conclusions. Incremental by Main's `next_since` cursor.
    """
    from app.integration.v4.client import default_client
    from app.v2 import ng
    client = client or default_client()
    if not getattr(client, "configured", False):
        return {"pulled": 0, "note": "No platform configured."}
    since = store.get_state("platform_context_since", "")
    try:
        body = client.sdk.finder_context(since=since, limit=limit) or {}
    except Exception as exc:                          # noqa: BLE001 - an older Main has no context feed
        return {"pulled": 0, "error": str(exc)}
    known = [k for k in body.get("known") or [] if k.get("domain")]
    written = ng.memory.note_external(known) if known else 0
    if body.get("next_since"):
        store.set_state("platform_context_since", body["next_since"])
    return {"pulled": written, "since": body.get("next_since") or since}


def push_hunts(client=None) -> dict:
    """v3: report Site Finder's hunts to Main (plain titles, state, what they found, why they stopped).
    Sent only when something changed since the last report."""
    import hashlib
    import json
    from app.integration.v4.client import default_client
    from app.v2 import pursuit
    client = client or default_client()
    if not getattr(client, "configured", False):
        return {"pushed": 0, "note": "No platform configured."}
    hunts = pursuit.hunts_view(limit=120)
    digest = hashlib.sha1(json.dumps(hunts, sort_keys=True, default=str).encode()).hexdigest()
    if not hunts or digest == store.get_state("platform_hunts_digest", ""):
        return {"pushed": 0, "unchanged": True}
    try:
        client.sdk.finder_hunts(hunts)
    except Exception as exc:                          # noqa: BLE001 - an older Main has no hunts route
        return {"pushed": 0, "error": str(exc)}
    store.set_state("platform_hunts_digest", digest)
    return {"pushed": len(hunts)}


def run_discover_job(job: dict) -> dict:
    """DISCOVER_SITES: the platform asked for more candidates."""
    from app.v2.engine import run_round
    payload = job.get("payload") or {}
    if isinstance(payload, str):
        import json
        payload = json.loads(payload or "{}")
    budget = payload.get("budget") or {}
    if payload.get("mode") == "continuous":
        # v5 operations: a continuous-discovery cycle (rotation, novelty, ecosystem saturation, change watch).
        from app.v2 import continuous
        return continuous.run_cycle(requested=int(payload.get("requested") or 10), http=int(budget.get("http") or 120),
                                    sources=payload.get("sources") or None, reason=str(payload.get("reason") or "platform"), request_limits=budget or None)
    summary = run_round(fetch_budget=int(budget.get("http") or 200), requested=int(payload.get("requested") or 10), request_limits=budget or None)
    return {"round": summary["round"], "delivered": len(summary["delivered"]), "probed": summary["probed"],
            "gated": summary["gated"], "budget": summary["budget"]}


def run_related_job(job: dict) -> dict:
    """FIND_RELATED_SITES in v2 mode: a round seeded with the confirmed site."""
    from app.v2.engine import run_round
    payload = job.get("payload") or {}
    if isinstance(payload, str):
        import json
        payload = json.loads(payload or "{}")
    if payload.get("pivot"):
        # v4 campaign pivot: bounded, contextual, saturation-aware (app.v2.context).
        from app.v2 import context
        return context.run_pivot(payload)
    seed = payload.get("canonical_key") or payload.get("domain") or payload.get("seed_domain") or ""
    # next gen: the request's sites become pivot seeds for this and later rounds (gap-driven discovery)
    from app.v2 import ng
    extra_seeds = [str(x) for x in (payload.get("seeds") or []) if x][:20]
    ng.add_gap(([seed] if seed else []) + extra_seeds, operation=payload.get("operation_id") or payload.get("campaign_id"),
               reason=str(payload.get("reason") or "requested by Main"), source=str(payload.get("source") or "main"))
    hunt = ng.request(payload)                         # v3: a campaign or investigation hunt (deduplicated)
    summary = run_round(seed_domains=[seed] if seed else [], requested=int(payload.get("requested") or 10), request_limits=payload.get("budget") or None)
    return {"seed": seed, "round": summary["round"], "delivered": len(summary["delivered"]),
            # the related-site "campaign" in v2 is one seeded round
            "campaign_key": f"v2:round:{summary['round']}:{seed or 'recent'}",
            "new_candidates": [d["domain"] for d in summary["delivered"]], "hunt": (hunt or {}).get("hunt"),
            # v7 actual-cost ledger: the round meter's own counts (requests charged to this round's allowance).
            "meter": summary.get("budget")}
