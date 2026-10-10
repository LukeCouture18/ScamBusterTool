"""
Is this candidate actually new to the investigation — and if so, why does it matter?

    known elsewhere   Main or Operation Hunter already holds the site. It is used as a
                      pivot seed but does not take one of your review slots.
    near-duplicate    the visible text is (almost) the same as a site already put in front
                      of you, and it shows no wallet that site did not show: a mirror.
    reappearance      it loads the same build file or carries the same distinctive title as
                      a site you marked useful; if that site has gone dark this is a likely
                      reappearance of the same kit. Stated as a similarity, not an identity.
    new operation     nothing already reviewed shares its build file or cluster.

`veto()` is applied at delivery; `annotate()` adds a small, bounded selection bonus and a
plain-English reason. Neither creates graph relationships.
"""
from __future__ import annotations

from app.v2 import store
from app.v2.ng import fingerprints, memory

NEAR_DUP_BITS = 4
REVIEWED = ("ready", "presented", "useful", "skipped", "delivered")


def _wallets(domain: str) -> set:
    return {v for k, v in store.keys_for(domain) if k == "wallet"}


def _key(domain: str, kind: str) -> list:
    return [v for k, v in store.keys_for(domain) if k == kind]


def veto(cand: dict) -> str | None:
    domain = cand["domain"]
    ext = memory.external(domain)
    if ext:
        return f"{'Operation Hunter' if ext['source'] == 'hunter' else 'Main'} already holds this site"
    from app.v2 import pursuit
    copied = pursuit.mirror_of(domain)
    if copied and not pursuit.distinct_deployment(domain, [copied]):
        return f"mirror of {copied} (same build, page and operator identifiers, no new wallet)"
    mine = _key(domain, "simhash")
    if mine:
        own_wallets = _wallets(domain)
        with store.conn() as conn:
            rows = conn.execute("SELECT k.domain,k.key_value FROM v2_keys k JOIN v2_candidates c ON c.domain=k.domain "
                                "WHERE k.key_type='simhash' AND k.domain!=? AND c.status IN (%s) LIMIT 400"
                                % ",".join("?" * len(REVIEWED)), (domain, *REVIEWED)).fetchall()
        for r in rows:
            if fingerprints.distance(mine[0], r["key_value"]) <= NEAR_DUP_BITS and own_wallets <= _wallets(r["domain"]) \
                    and not pursuit.distinct_deployment(domain, [r["domain"]]):
                return f"near-duplicate of {r['domain']} (same page text, no new wallet)"
    return None


def annotate(cand: dict) -> dict:
    """Plain-English novelty facts plus a bounded bonus (<= 0.05) for shortlist ordering."""
    domain = cand["domain"]
    out = {"bonus": 0.0, "facts": []}
    own = store.keys_for(domain)
    apps = [v for k, v in own if k == "asset" and v.startswith(("app.", "main.", "index.", "bundle."))]
    titles = [v for k, v in own if k == "title"]
    members = store.cluster_members(cand["cluster_id"]) if cand.get("cluster_id") else []
    related_reviewed = set()
    for kind, values in (("asset", apps), ("title", titles)):
        for v in values:
            for other in store.domains_with_key(kind, v):
                if other != domain and (store.get(other) or {}).get("status") in ("useful",):
                    related_reviewed.add((other, kind, v))
    if related_reviewed:
        other, kind, v = sorted(related_reviewed)[0]
        prev = store.get(other) or {}
        gone = prev.get("status") == "gated" or (prev.get("details") or {}).get("site_status") in ("dead", "gone") \
            or other in memory.dark_watches()
        what = f"the same build file {v}" if kind == "asset" else f"the same page title “{v[:60]}”"
        if gone:
            out["facts"].append(f"Loads {what} as {other}, a site you marked useful that has since gone dark: "
                                f"possibly the same kit back on a new name. This is a similarity, not proof of the same operator.")
            out["reappearance_of"] = other
            out["bonus"] += 0.03
        else:
            out["facts"].append(f"Loads {what} as {other}, which you marked useful. Similar build, not proof of the same operator.")
            out["same_build_as"] = other
    elif cand.get("cluster_id") and not any(m["status"] in ("useful", "ready", "presented") for m in
                                            members if m["domain"] != domain):
        out["facts"].append("Nothing you have reviewed shares its wallets, certificate or build, so it may belong to an operation you have not seen yet.")
        out["bonus"] += 0.02
    # An operation you already have in hand is worth less than a new one: a small penalty unless
    # this site shows wallets its reviewed siblings did not.
    reviewed_siblings = []
    if cand.get("cluster_id") and not str(cand["cluster_id"]).startswith("c:" + domain):
        reviewed_siblings = [m["domain"] for m in members
                             if m["domain"] != domain and m["status"] in ("useful", "ready", "presented")]
    if out.get("same_build_as") or out.get("reappearance_of"):
        reviewed_siblings.append(out.get("same_build_as") or out.get("reappearance_of"))
    seen = set()
    for m in members:
        if m["domain"] != domain and m["status"] in REVIEWED:
            seen |= _wallets(m["domain"])
    for s in reviewed_siblings:
        seen |= _wallets(s)
    new_wallets = {v for k, v in own if k == "wallet"} - seen
    if new_wallets and seen:
        out["facts"].append(f"Shows {len(new_wallets)} wallet{'s' if len(new_wallets) > 1 else ''} not seen on its related sites.")
        out["bonus"] -= 0.04                           # new evidence for an operation you already have: after new operations
    elif reviewed_siblings and not out.get("reappearance_of"):
        out["bonus"] -= 0.07
        out["covered_by"] = sorted(set(reviewed_siblings))[:3]
    chain = memory.chain(domain) if set(cand.get("strategies") or []) & {"ng_pivot", "ng_gap"} else []
    if chain:
        first = chain[0]
        out["depth"] = first["depth"]
        out["route"] = first["route"]
        out["parent"] = first["parent"]
        out["chain"] = chain
        if first["depth"] >= 2:
            out["facts"].append(f"Found {first['depth']} steps away from {chain[-1]['parent']}, through sites Site Finder checked on the way.")
    out["bonus"] = round(max(-0.08, min(0.05, out["bonus"])), 3)
    return out


def _group(cand: dict, own: list) -> str | None:
    apps = sorted(v for k, v in own if k == "asset" and v.startswith(("app.", "main.", "index.", "bundle.")))
    if cand.get("cluster_id") or apps:
        return cand.get("cluster_id") or f"asset:{apps[0]}"
    from app.v2.pursuit import artifacts, ledger
    sig = artifacts.mirror_signature(own + ledger.artifacts_of([cand["domain"]]).get(cand["domain"], []))
    return f"sig:{hash(sig)}" if len(sig) >= 3 else None


def dedupe_batch(eligible: list) -> tuple[list, list]:
    """Keeps the strongest of each (cluster/build, wallets) group; the rest are mirrors of it.

    A candidate that shows a wallet its group-mates do not show is kept: that is new evidence.
    Returns (kept, [(candidate, reason)]).
    """
    kept, dropped, reps = [], [], {}
    for cand in sorted(eligible, key=lambda c: -float(c.get("p") or 0)):
        own = store.keys_for(cand["domain"])
        group = _group(cand, own)
        if not group:
            kept.append(cand)
            continue
        wallets = frozenset(v for k, v in own if k == "wallet")
        prior = reps.get(group)
        from app.v2 import pursuit
        if prior and wallets <= prior[1] and not pursuit.distinct_deployment(cand["domain"], [prior[0]]):
            dropped.append((cand, f"mirror of {prior[0]} (same build or cluster, no new wallet)"))
            continue
        reps[group] = (prior[0] if prior else cand["domain"], (prior[1] if prior else frozenset()) | wallets)
        kept.append(cand)
    return kept, dropped
