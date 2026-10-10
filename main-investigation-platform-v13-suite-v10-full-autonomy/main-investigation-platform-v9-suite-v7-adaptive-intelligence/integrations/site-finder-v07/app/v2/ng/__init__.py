"""
Site Finder next generation: discover -> evaluate -> pivot -> investigate -> learn -> find something new.

This package sits on top of the v2 engine (which is unchanged in its gates, evidence and
budgets) and adds:

    memory        persistent discovery memory: what Main/Hunter already hold, every
                  indicator searched and what it returned, how each site was reached
    fingerprints  page-build fingerprints from HTML already fetched (build files, title,
                  text similarity), used as discovery pivots and for near-duplicates
    pagesearch    public page-scan search (urlscan.io-compatible), behind the shared
                  provider health and circuit breaker
    planner       value-of-information pivot planning with saturation, exhaustion,
                  multi-hop chains and delayed credit
    novelty       what is actually new: known-elsewhere and near-duplicate suppression,
                  reappearance and new-operation facts for the shortlist

SITE_FINDER_NG=0 turns the layer off; the engine then behaves exactly as the previous
release. The hooks below are the only places the engine calls into it.
"""
from __future__ import annotations

import logging
import os

from app.v2.ng import fingerprints, memory, novelty, pagesearch, planner  # noqa: F401

logger = logging.getLogger("scamhunter.v2.ng")
_state = {"enabled": None}


def enabled() -> bool:
    if _state["enabled"] is not None:
        return _state["enabled"]
    return os.environ.get("SITE_FINDER_NG", "1") not in ("0", "false", "no")


def configure(enabled_flag: bool | None = None, page_search_url: str | None = None):
    if enabled_flag is not None:
        _state["enabled"] = bool(enabled_flag)
    if page_search_url is not None:
        pagesearch.configure(page_search_url)


# ---------------------------------------------------------------- engine hooks (never raise)

def leads(budget, round_no: int) -> list:
    if not enabled():
        return []
    try:
        from app.v2 import store, strategies
        from app.v2 import pursuit
        if pursuit.enabled():
            # v3: persistent branching hunts replace the one-shot pivot plan
            out = []
            try:
                for d in planner.liveness(budget, round_no):
                    pursuit.went_dark(d, f"stopped resolving (round {round_no})")
                out = pursuit.leads(budget, round_no)
            except Exception as exc:                  # noqa: BLE001 - a pursuit fault never costs the gap seeds
                logger.warning("pursuit planner failed this round: %s", exc, exc_info=True)
        else:
            out = planner.execute(budget, round_no)
        for s in memory.seeds():
            if not store.exists(s["domain"]):
                # a site Main/Hunter asked about that Site Finder has never looked at: probe it first
                out.append(strategies.Lead(s["domain"], "ng_gap", f"requested by {s['source']}: {s['reason']}"[:200],
                                           0.9, "ng_gap"))
        return out
    except Exception as exc:                          # noqa: BLE001 - a planner fault never costs a round
        logger.warning("pivot planner failed this round: %s", exc, exc_info=True)
        return []


def probe_keys(html: str, text: str, title: str, url: str, domain: str, bundle: str = "") -> tuple[dict, list]:
    if not enabled():
        return {}, []
    try:
        fp = fingerprints.extract(html, text, title, url, domain)
        keys = fingerprints.keys(fp)
        from app.v2 import pursuit
        keys += [k for k in pursuit.extract(domain, html, bundle) if k not in keys]
        return fp, keys
    except Exception:                                 # noqa: BLE001
        return {}, []


def observe(domain: str, keys: list, eligible: bool, weak: bool, strategies_=None, round_no=None) -> dict:
    if not enabled():
        return {}
    from app.v2 import pursuit
    return pursuit.observe(domain, keys, eligible, weak, strategies_, round_no)


def observe_gated(domain: str, verdict: str, html: str = "", round_no=None):
    if not enabled():
        return
    from app.v2 import pursuit
    pursuit.observe_gated(domain, verdict, html, round_no)


def filter_leads(leads: list) -> tuple[list, int]:
    if not enabled():
        return leads, 0
    from app.v2 import pursuit
    return pursuit.filter_leads(leads)


def distinct_deployment(domain: str, others: list) -> bool:
    if not enabled():
        return False
    from app.v2 import pursuit
    return pursuit.distinct_deployment(domain, others)


def gate_prior(domain: str) -> tuple[float, str]:
    if not enabled():
        return 0.0, ""
    from app.v2 import pursuit
    return pursuit.gate_prior(domain)


def after_probe(domain: str, eligible: bool, strategies=None):
    if not enabled() or (strategies is not None and not set(strategies) & {"ng_pivot", "ng_gap", "pu_anchor"}):
        return                                        # only sites the planner found carry a lineage
    try:
        planner.after_probe(domain, eligible)
    except Exception:                                 # noqa: BLE001
        logger.debug("after_probe failed for %s", domain, exc_info=True)


def after_decision(candidate: dict, useful: bool, reason: str | None):
    if not enabled():
        return
    try:
        planner.after_decision(candidate["domain"], useful, reason)
        from app.v2 import pursuit
        pursuit.on_decision(candidate, useful, reason)
        if useful:
            keys = {k: v for k, v in (candidate.get("details") or {}).get("keys", [])}
            memory.watch(candidate["domain"], {"assets": [v for k, v in (candidate.get("details") or {}).get("keys", [])
                                                         if k == "asset"], "title": keys.get("title", "")},
                         "marked useful")
    except Exception:                                 # noqa: BLE001
        logger.debug("after_decision failed", exc_info=True)


def veto(candidate: dict) -> str | None:
    if not enabled():
        return None
    try:
        return novelty.veto(candidate)
    except Exception:                                 # noqa: BLE001
        return None


def external_reason(candidate: dict) -> str | None:
    if not enabled():
        return None
    try:
        ext = memory.external(candidate["domain"])
        return f"{'Operation Hunter' if ext['source'] == 'hunter' else 'Main'} already holds this site" if ext else None
    except Exception:                                 # noqa: BLE001
        return None


def dedupe_batch(eligible: list) -> tuple[list, list]:
    """Mirrors inside one delivery batch: same cluster or same build file and no wallet the others lack."""
    if not enabled():
        return eligible, []
    try:
        return novelty.dedupe_batch(eligible)
    except Exception:                                 # noqa: BLE001
        return eligible, []


def annotate(candidate: dict) -> dict:
    if not enabled():
        return {}
    try:
        out = novelty.annotate(candidate)
        from app.v2 import pursuit
        extra = pursuit.annotate(candidate)
        if extra:
            out["facts"] = (extra.get("facts") or []) + (out.get("facts") or [])
            for k in ("explain", "new_family", "returned_from", "expected_value"):
                if k in extra:
                    out[k] = extra[k]
            if extra.get("returned_from") and not out.get("reappearance_of"):
                out["reappearance_of"] = extra["returned_from"]
            out["bonus"] = round(max(-0.08, min(0.06, float(out.get("bonus") or 0) + float(extra.get("bonus") or 0))), 3)
        return out
    except Exception:                                 # noqa: BLE001
        return {}


def add_gap(seed_domains: list, operation: str | None = None, reason: str = "", source: str = "main") -> list:
    """A Main/Hunter request for more sites like these: they become high-priority pivot seeds."""
    if not enabled():
        return []
    added = []
    for d in seed_domains or []:
        got = memory.add_seed(d, source, reason or "requested by Main", operation, 1.0)
        if got:
            added.append(got)
    return added


def request(payload: dict) -> dict:
    """v3: a Main/Hunter/investigation request becomes a campaign or investigation hunt."""
    if not enabled():
        return {}
    from app.v2 import pursuit
    return pursuit.request(payload)


def status() -> dict:
    """What the planner did last round and what it would do next, for the UI's Why? panels."""
    from app.v2 import store
    memory.ensure()
    return {"enabled": enabled(), "page_search": pagesearch.endpoint() or None,
            "last_plan": store.get_state("ng_last_plan", {}),
            "routes": memory.route_stats(), "known_elsewhere": len(memory.external_map()),
            "seeds": memory.seeds()[:20]}
