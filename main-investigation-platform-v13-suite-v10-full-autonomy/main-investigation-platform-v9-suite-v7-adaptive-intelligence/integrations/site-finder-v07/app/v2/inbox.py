"""
The local inbox: NEXT SITE -> OPEN SITE -> SKIP / USEFUL -> next.

When Site Finder is linked to the Main Platform, the platform's inbox is the
one you use and your decisions come back through platform_bridge. This local
inbox is the same flow for standalone use, the CLI and the benchmark, and it
records decisions through exactly the same path, so learning is identical
either way.
"""
from __future__ import annotations

import time

from app.v2 import selection, store

SKIP_REASONS = ("not_a_scam", "dead_or_parked", "duplicate", "not_crypto", "not_useful")


def _summary(c: dict) -> dict:
    cid = c.get("cluster_id")
    return {"id": c["domain"], "domain": c["domain"], "url": c.get("url") or f"https://{c['domain']}/",
            "headline": c.get("headline") or "", "category": c.get("category") or "",
            "p": c.get("p"), "cluster": cid, "status": c["status"],
            "why_selected": (c.get("selection") or c.get("details", {}).get("selection") or {}).get("why_selected", "")}


def _ranked_ready() -> list[dict]:
    store.ensure()
    with store.conn() as c:
        rows = c.execute("SELECT * FROM v2_candidates WHERE status IN ('ready','presented') "
                         "ORDER BY p DESC, delivered_at DESC").fetchall()
    candidates = [store.row_to_candidate(row) for row in rows]
    # next gen: a site Main or Hunter learned about after delivery no longer earns a review slot
    from app.v2 import ng
    kept = []
    for candidate in candidates:
        reason = ng.external_reason(candidate)
        if reason and candidate["status"] == "ready":
            store.update(candidate["domain"], status="suppressed", details={**candidate["details"], "suppressed": reason})
            continue
        kept.append(candidate)
    candidates = kept
    from app.v2 import intelligence
    for candidate in candidates:
        candidate["_campaign"] = intelligence.campaign_for(candidate["domain"])
    return selection.shortlist(candidates, len(candidates),
                               observations=lambda c: (store.sightings(c["domain"]), store.keys_for(c["domain"])))


def next_candidate(lease_seconds: int = 900) -> dict | None:
    """Highest-probability ready candidate; presented ones come back after the lease."""
    store.ensure()
    now = time.time()
    ranked = _ranked_ready()
    cand = next((c for c in ranked if c["status"] == "ready" or
                 (c["status"] == "presented" and (c.get("presented_at") or 0) < now - lease_seconds)), None)
    if not cand:
        return None
    store.update(cand["domain"], status="presented", presented_at=now)
    return _summary({**cand, "status": "presented"})


def top_candidates(limit: int = 5) -> list[dict]:
    """Small review queue, excluding decided or previously handed-off sites."""
    return [_summary(row) for row in _ranked_ready()[:min(max(1, limit), 5)]]


def presented(candidate_id: str) -> bool:
    """Record that a candidate was viewed without silently voting SKIP."""
    cand = store.get(candidate_id)
    if not cand or cand["status"] not in ("ready", "presented"):
        return False
    store.update(candidate_id, status="presented", presented_at=time.time())
    return True


def remaining() -> int:
    store.ensure()
    with store.conn() as c:
        return c.execute("SELECT COUNT(*) n FROM v2_candidates WHERE status IN ('ready','presented')").fetchone()["n"]


def opened(candidate_id: str):
    store.update(candidate_id, opened_at=time.time())


def decide(candidate_id: str, decision: str, reason: str | None = None, source: str = "local",
           external_id: str | None = None) -> dict:
    """Records USEFUL or SKIP and applies it to the learning ledgers immediately."""
    if decision not in ("useful", "skip", "skipped"):
        raise ValueError("decision must be 'useful' or 'skip'")
    decision = "useful" if decision == "useful" else "skip"
    cand = store.get(candidate_id)
    if not cand:
        return {"ok": False, "error": "unknown candidate"}
    store.add_decision(candidate_id, decision, reason or "", source=source, external_id=external_id)
    from app.v2.engine import apply_decisions
    apply_decisions()
    return {"ok": True, "domain": candidate_id, "decision": decision, "remaining": remaining()}


def details(candidate_id: str) -> dict | None:
    """Everything behind a candidate, for the advanced view."""
    cand = store.get(candidate_id)
    if not cand:
        return None
    from app.v2 import intelligence
    members = []
    if cand.get("cluster_id"):
        members = [{"domain": m["domain"], "status": m["status"], "p": m["p"], "headline": m.get("headline")}
                   for m in store.cluster_members(cand["cluster_id"]) if m["domain"] != candidate_id]
    return {**cand, "sightings": store.sightings(candidate_id), "cluster_members": members,
            "cluster": store.get_cluster(cand["cluster_id"]) if cand.get("cluster_id") else None,
            "campaign_id": intelligence.campaign_for(candidate_id),
            "note": ("Signals and shared infrastructure are observations that justify a look. They are not "
                     "proof that a site is fraudulent or that related sites share an owner.")}


def stats() -> dict:
    store.ensure()
    with store.conn() as c:
        row = c.execute("SELECT SUM(decision='useful') u, SUM(decision='skip') s FROM v2_candidates WHERE decision IS NOT NULL").fetchone()
    u, s = row["u"] or 0, row["s"] or 0
    return {"ready": remaining(), "useful": u, "skipped": s,
            "precision": round(u / (u + s), 3) if (u + s) else None, "counts": store.counts()}
