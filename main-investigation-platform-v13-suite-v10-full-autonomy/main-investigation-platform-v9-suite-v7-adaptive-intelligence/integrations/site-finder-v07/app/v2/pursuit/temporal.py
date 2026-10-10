"""
Infrastructure over time: new deployment -> active -> changed -> gone -> reused -> possible return.

    lifecycle     every probed scam page gets a lifecycle row with a fingerprint of its deployment
                  (build files, title, page skeleton). A later probe with a different fingerprint is
                  a change; a site that stops resolving (or is gated dead after being a scam page)
                  is gone.
    reappearance  an eligible site that shares an operator- or build-level artifact with a site
                  that is gone is flagged as a possible return (a similarity, never an identity),
                  and a watch hunt keeps looking for the gone site's artifacts for a while.
    waves         three or more new scam pages sharing one artifact within two rounds are a
                  deployment wave; a wave hunt follows it while it is fresh.
"""
from __future__ import annotations

import hashlib

from app.v2 import store
from app.v2.pursuit import ledger

RETURN_KINDS = ("asset", "title", "favicon", "apihost", "service", "analytics", "contact", "linked", "dom", "wallet")
WAVE_KINDS = ("asset", "apihost", "service", "title", "favicon", "linked", "analytics")
WAVE_SIZE = 3


def fingerprint(keys: list) -> str:
    parts = sorted(f"{k}={v}" for k, v in keys if k in ("asset", "title", "dom", "flow", "apihost", "service"))
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16] if parts else ""


def observe(domain: str, keys: list, scam: bool, round_no: int) -> dict:
    """Records one probe of a scam page; returns {"changed": bool, "returned_from": str|None}."""
    if not scam:
        return {}
    res = ledger.upsert_life(domain, round_no, fingerprint(keys))
    out = {"changed": bool(res.get("changed"))}
    if res.get("new"):
        back = returned_from(domain, keys)
        if back:
            ledger.upsert_life(domain, round_no, None, None, back)
            out["returned_from"] = back
    return out


def mark_gone(domain: str, round_no: int, why: str) -> bool:
    """A scam page stopped answering. Starts a reappearance watch for it. Returns True if newly gone."""
    cur = ledger.life(domain)
    if not cur or cur["state"] == "gone":
        return False
    ledger.upsert_life(domain, round_no, None, "gone")
    from app.v2.pursuit import planner
    keys = [(k, v) for k, v in ledger.artifacts_of([domain]).get(domain, []) if k in RETURN_KINDS]
    arts = [{"kind": k, "value": v, "seed": domain} for k, v in keys if k not in ("dom", "wallet")]
    arts.append({"kind": "domain", "value": domain, "seed": domain})
    n = store.get(domain) or {}
    planner.start_hunt("reappearance", domain, round_no, origin={"site": domain, "why": why},
                       artifacts_=arts, hunt_id=f"return:{domain}", operation=n.get("cluster_id"))
    return True


def returned_from(domain: str, keys: list) -> str | None:
    """A gone scam site this one shares a distinctive artifact with, if any."""
    wanted = [(k, v) for k, v in keys if k in RETURN_KINDS and v]
    if not wanted:
        return None
    gone = {r["domain"] for r in ledger.lives(("gone",))}
    if not gone:
        return None
    stats = ledger.tier_stats(wanted)
    from app.v2.pursuit import artifacts
    best = None
    for kv in wanted:
        t = artifacts.tier(kv[0], stats.get(kv, {}))
        if t in ("generic", "family"):
            continue
        for other in ledger.artifact_domains(kv[0], kv[1]):
            if other != domain and other in gone:
                rank = 0 if t == "operator" else 1
                if best is None or rank < best[0]:
                    best = (rank, other)
    return best[1] if best else None


def waves(round_no: int) -> list:
    """(kind, value, n_new_sites) for artifacts behind a burst of new scam pages in the last two rounds."""
    with store.conn() as conn:
        rows = conn.execute(
            f"SELECT kind,value,COUNT(DISTINCT domain) n FROM pu_artifacts WHERE class='scam' AND round>=? AND kind IN "
            f"({','.join('?' * len(WAVE_KINDS))}) GROUP BY kind,value HAVING n>=? ORDER BY n DESC LIMIT 5",
            (round_no - 2, *WAVE_KINDS, WAVE_SIZE)).fetchall()
    return [(r["kind"], r["value"], r["n"]) for r in rows]


def start_waves(round_no: int) -> int:
    from app.v2.pursuit import artifacts, planner
    made = 0
    found = waves(round_no)
    stats = ledger.tier_stats([(k, v) for k, v, _ in found])
    for kind, value, n in found:
        if artifacts.tier(kind, stats.get((kind, value), {})) == "generic":
            continue
        hid = f"wave:{kind}:{value}"[:160]
        if ledger.hunt(hid):
            continue
        seed = ledger.artifact_domains(kind, value, limit=1)
        planner.start_hunt("wave", f"{n} new sites sharing {_label(kind)} {value[:40]}", round_no,
                           origin={"artifact": [kind, value], "sites": n}, hunt_id=hid,
                           artifacts_=[{"kind": kind, "value": value, "seed": seed[0] if seed else value}])
        made += 1
    return made


def _label(kind: str) -> str:
    return {"asset": "the build file", "apihost": "the API host", "service": "the support chat", "title": "the title",
            "favicon": "the icon", "linked": "the linked domain", "analytics": "the analytics id"}.get(kind, kind)
