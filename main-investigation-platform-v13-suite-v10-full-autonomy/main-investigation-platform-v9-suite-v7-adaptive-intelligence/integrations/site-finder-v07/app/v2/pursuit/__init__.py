"""
Site Finder v3 · discovery pursuit and campaign hunting.

Give Site Finder one clue and it hunts until it finds something genuinely new, or knows when to
stop. This package sits on the next-generation layer (app.v2.ng: discovery memory, page search,
novelty) and replaces its one-shot pivot planner with persistent, branching hunts:

    artifacts   website-family intelligence: config hosts, chat/analytics ids, messenger handles,
                linked domains, page skeleton and form structure, each with a learned tier
                (generic / family / variant / deployment / operator)
    ledger      hunts, branches, cached results, the artifact population, a decayed route ledger,
                site lifecycles and pursuit lineage (schema version 6, additive)
    planner     expected-information-gain planning across hunts with an exploration reserve,
                multi-hop growth, stop rules and delayed value
    temporal    lifecycle, changes, disappearance, reappearance and deployment waves
    explain     "Found this because ..." with the evidence path and its uncertainty

SITE_FINDER_PURSUIT=0 switches back to the 2.1 pivot planner. Hooks below never raise.
"""
from __future__ import annotations

import logging
import re
import os

logger = logging.getLogger("scamhunter.v2.pursuit")
_state = {"enabled": None}
NONSCAM_VERDICTS = {"not_crypto", "informational", "legit", "redirect_legit"}
PARKED_VERDICTS = {"parked", "for_sale", "placeholder", "coming_soon", "suspended", "thin"}


def enabled() -> bool:
    if _state["enabled"] is not None:
        return _state["enabled"]
    return os.environ.get("SITE_FINDER_PURSUIT", "1") not in ("0", "false", "no")


def configure(enabled_flag: bool | None = None):
    if enabled_flag is not None:
        _state["enabled"] = bool(enabled_flag)


def _round() -> int:
    from app.v2 import store
    return int(store.get_state("round", 0) or 0)


# ------------------------------------------------------------------ round

def leads(budget, round_no: int) -> list:
    from app.v2.pursuit import ledger, planner, temporal
    ledger.ensure()
    ledger.refresh()
    try:
        temporal.start_waves(round_no)
    except Exception:                                  # noqa: BLE001
        logger.debug("wave detection failed", exc_info=True)
    planner.wake_parked(round_no)
    return planner.execute(budget, round_no)


def filter_leads(leads: list) -> tuple[list, int]:
    """Discovery memory for every arm: leads on the name stem of a known mirror farm are held back
    (one per farm per round still gets through, so a farm that changes is noticed)."""
    if not enabled() or not leads:
        return leads, 0
    try:
        from app.v2 import store
        from app.v2.pursuit import ledger, planner
        ledger.ensure()
        farms = planner._farm_stems()
        if not farms:
            return leads, 0
        out, seen_farm, dropped = [], set(), 0
        for lead in leads:
            stem = planner._stem(lead.domain or "")
            if stem in farms and not store.exists(lead.domain):
                if stem in seen_farm:
                    dropped += 1
                    continue
                seen_farm.add(stem)
            out.append(lead)
        return out, dropped
    except Exception:                                  # noqa: BLE001
        return leads, 0


# ------------------------------------------------------------------ probes

def extract(domain: str, html: str, bundle: str = "") -> list:
    if not enabled():
        return []
    try:
        from app.v2.pursuit import artifacts
        return artifacts.extract(domain, html, bundle)
    except Exception:                                  # noqa: BLE001
        return []


def observe(domain: str, keys: list, eligible: bool, weak: bool, strategies, round_no: int | None = None):
    """A page was probed and held: record its artifacts, its lifecycle, and grow the hunt that found it."""
    if not enabled():
        return {}
    try:
        from app.v2.pursuit import ledger, planner, temporal
        ledger.ensure()
        rn = round_no if round_no is not None else _round()
        klass = "scam" if eligible else ("weak" if weak else "unknown")
        ledger.note_artifacts(domain, keys, klass, rn)
        out = temporal.observe(domain, keys, eligible, rn)
        if eligible and mirror_of(domain, MIRROR_STATUSES + ("held", "suppressed")):
            klass = "mirror"                              # a copy: counts against the branch, grows nothing
            eligible = weak = False
            ledger.set_class(domain, "mirror")
        planner.after_probe(domain, eligible, keys, klass, rn, weak=weak)
        planner.seed_probed(domain, keys, rn)
        return out
    except Exception:                                  # noqa: BLE001
        logger.debug("pursuit observe failed for %s", domain, exc_info=True)
        return {}


def observe_gated(domain: str, verdict: str, html: str = "", round_no: int | None = None):
    """A page was gated. Non-scam pages still teach which artifacts are generic web technology."""
    if not enabled():
        return
    try:
        from app.v2.pursuit import ledger, planner, temporal
        ledger.ensure()
        rn = round_no if round_no is not None else _round()
        klass = "nonscam" if verdict in NONSCAM_VERDICTS else ("parked" if verdict in PARKED_VERDICTS else "dead")
        if html and klass in ("nonscam", "parked"):
            from app.v2.pursuit import artifacts
            ledger.note_artifacts(domain, artifacts.extract(domain, html), "nonscam", rn)
        if verdict == "dead":
            life = ledger.life(domain)
            if life and life["state"] != "gone":
                temporal.mark_gone(domain, rn, f"stopped resolving (round {rn})")
        planner.after_probe(domain, False, [], klass if klass == "nonscam" else "gated", rn)
    except Exception:                                  # noqa: BLE001
        logger.debug("pursuit observe_gated failed for %s", domain, exc_info=True)


def went_dark(domain: str, why: str):
    if not enabled():
        return
    try:
        from app.v2.pursuit import ledger, temporal
        ledger.ensure()
        if not ledger.life(domain):
            ledger.upsert_life(domain, _round(), "")
        temporal.mark_gone(domain, _round(), why)
    except Exception:                                  # noqa: BLE001
        logger.debug("went_dark failed for %s", domain, exc_info=True)


MIRROR_STATUSES = ("useful", "skipped", "ready", "presented", "delivered")


def mirror_of(domain: str, statuses=MIRROR_STATUSES) -> str | None:
    """A site already put in front of you (or held) that this one copies: the same build, page
    skeleton and operator identifiers (at least three shared), and no wallet that site lacked.
    Mirror farms defeat popularity caps; this does not depend on how many copies exist."""
    if not enabled():
        return None
    try:
        from app.v2 import store
        from app.v2.pursuit import artifacts, ledger
        mine = ledger.artifacts_of([domain]).get(domain, []) + store.keys_for(domain)
        sig = set(artifacts.mirror_signature(mine))
        if len(sig) < 3:
            return None
        wallets = {v for k, v in mine if k == "wallet"}
        cand = {}
        with store.conn() as conn:
            for k, v in list(sig)[:12]:
                for r in conn.execute("SELECT a.domain FROM pu_artifacts a JOIN v2_candidates c ON c.domain=a.domain "
                                      f"WHERE a.kind=? AND a.value=? AND a.domain!=? AND c.status IN ({','.join('?' * len(statuses))}) LIMIT 50",
                                      (k, v, domain, *statuses)):
                    cand[r[0]] = cand.get(r[0], 0) + 1
        gone = {r["domain"] for r in ledger.lives(("gone",))}
        for other, shared in sorted(cand.items(), key=lambda x: -x[1]):
            if shared < 3:
                break
            if other in gone:
                continue                                 # a copy of a site that went dark is a possible return, not a mirror
            theirs = {v for k, v in store.keys_for(other) if k == "wallet"}
            if wallets <= theirs:
                return other
        return None
    except Exception:                                  # noqa: BLE001
        return None


OPERATOR_IDS = ("service", "apihost", "analytics", "contact")


def distinct_deployment(domain: str, others: list) -> bool:
    """True when `domain` carries its own operator identifiers (chat, API host, analytics, contact)
    and shares none of them with any of `others` that has some: the same kit run by someone else,
    or a new deployment, is not a mirror even when the page text and layout are identical."""
    if not enabled() or not others:
        return False
    try:
        from app.v2 import store
        from app.v2.pursuit import ledger
        arts = ledger.artifacts_of([domain] + list(others))
        # A changed public build and materially changed page are a new template
        # variant even when a wallet/contact is reused. This is a discovery lead,
        # not a new operator claim; generic libraries and unchanged mirrors do not qualify.
        own_keys = store.keys_for(domain)
        build = {(k,v) for k,v in own_keys if k == 'asset' and re.match(r'^(?:app|main|index|bundle)[.-][a-f0-9]{6,}.*\.js$',v)}
        old_build = {(k,v) for o in others for k,v in store.keys_for(o) if k == 'asset'}
        own_hash = next((v for k,v in own_keys if k == 'simhash'),None)
        old_hashes = [v for o in others for k,v in store.keys_for(o) if k == 'simhash']
        if build - old_build and own_hash and old_hashes:
            from app.v2.ng.fingerprints import distance
            if all(distance(own_hash,h) > 8 for h in old_hashes):
                return True
        def ids(d):
            return {(k, v) for k, v in arts.get(d, []) + store.keys_for(d) if k in OPERATOR_IDS}
        mine = ids(domain)
        if not mine:
            return False
        theirs = [ids(o) for o in others]
        theirs = [t for t in theirs if t]
        return bool(theirs) and all(not (mine & t) for t in theirs)
    except Exception:                                  # noqa: BLE001
        return False


def gate_prior(domain: str) -> tuple[float, str]:
    """Bounded evidence from the pursuit path: reached from a confirmed site through an artifact of
    the operator or of a specific build. Raises the chance the page is a scam; says nothing about who runs it."""
    if not enabled():
        return 0.0, ""
    try:
        from app.v2 import store
        from app.v2.ng import memory
        from app.v2.pursuit import ledger
        if domain not in ledger.lead_domains():
            return 0.0, ""
        n = ledger.node(domain)
        if not n or not n.get("parent"):
            return 0.0, ""
        with store.conn() as conn:
            br = conn.execute("SELECT tier FROM pu_branches WHERE id=?", (n["branch_id"],)).fetchone()
        tier = (br["tier"] if br else "") or "deployment"
        if n["route"] == "name_pattern":
            tier = "name"
        z = {"operator": 0.45, "variant": 0.3, "deployment": 0.2, "family": 0.1, "name": 0.1}.get(tier, 0.0)
        parent = store.get(n["parent"]) or {}
        if parent.get("status") == "useful" or memory.external(n["parent"]):
            f, whose = 1.0, "a confirmed site"
        elif parent.get("status") in ("ready", "presented", "held") and (parent.get("details") or {}).get("score", {}).get("core"):
            f, whose = 0.6, "an eligible site"
        else:
            f, whose = 0.3, "a site under review"
        z = round(z * f, 3)
        return z, (f"reached from {whose} ({n['parent']}) through a shared {tier}-level artifact" if z else "")
    except Exception:                                  # noqa: BLE001
        return 0.0, ""


# ------------------------------------------------------------------ feedback

def on_decision(candidate: dict, useful: bool, reason: str | None):
    if not enabled():
        return
    try:
        from app.v2.pursuit import ledger, planner
        ledger.ensure()
        planner.after_decision(candidate["domain"], useful, reason, _round())
    except Exception:                                  # noqa: BLE001
        logger.debug("pursuit on_decision failed", exc_info=True)


def on_outcome(domain: str, outcome: str):
    if not enabled():
        return
    try:
        from app.v2.pursuit import ledger, planner
        ledger.ensure()
        planner.after_outcome(domain, outcome, _round())
    except Exception:                                  # noqa: BLE001
        logger.debug("pursuit on_outcome failed", exc_info=True)


def request(payload: dict) -> dict:
    """A request from Main: Operation Hunter's evidence gap, Main's own request, or artifacts a site
    investigation extracted. Becomes a campaign or investigation hunt. Duplicate requests land in the
    same hunt and the same branches, so repeating a request never repeats work."""
    if not enabled():
        return {}
    try:
        from app.v2 import domains as dm
        from app.v2.pursuit import ledger, planner
        ledger.ensure()
        rn = _round()
        source = str(payload.get("source") or "main")
        seed = dm.registrable(str(payload.get("domain") or payload.get("canonical_key") or payload.get("seed_domain") or ""))
        seeds = [s for s in dict.fromkeys([seed] + [dm.registrable(str(x)) for x in (payload.get("seeds") or [])][:20]) if s]
        arts = []
        for a in (payload.get("artifacts") or [])[:60]:
            if isinstance(a, dict) and a.get("kind") and a.get("value"):
                arts.append({"kind": str(a["kind"])[:30], "value": str(a["value"])[:300], "seed": seed or (seeds[0] if seeds else "")})
        operation = str(payload.get("operation_id") or payload.get("campaign_id") or "") or None
        if source == "investigation":
            # depth carries over: artifacts of a site found by a hunt continue that hunt's chain,
            # so an investigation -> discovery -> investigation loop cannot recurse without bound
            n = ledger.node(seed) if seed else None
            if n and int(n["depth"]) >= planner.MAX_DEPTH:
                return {"hunt": None, "reason": "depth limit reached"}
            h = planner.start_hunt("investigation", seed or "a site", rn, origin={"source": source, "reason": payload.get("reason")},
                                   operation=operation, seeds=[s for s in seeds if s != seed], artifacts_=arts,
                                   hunt_id=f"investigation:{seed}")
        else:
            subject = operation or seed or "a request"
            name = str(payload.get("operation_name") or "").strip()
            label = f"Operation {name or operation}" if operation else (seed or "a request")
            h = planner.start_hunt("campaign", label, rn, origin={"source": source, "reason": payload.get("reason"), "seeds": seeds},
                                   operation=operation, seeds=seeds, artifacts_=arts, hunt_id=f"campaign:{subject}")
        return {"hunt": h["id"], "title": h["title"]}
    except Exception:                                  # noqa: BLE001
        logger.warning("pursuit request failed", exc_info=True)
        return {}


# ------------------------------------------------------------------ explanation and value

def annotate(candidate: dict) -> dict:
    """Pursuit facts for the shortlist: the discovery path, family novelty, returns, expected value."""
    if not enabled():
        return {}
    try:
        from app.v2.pursuit import explain, ledger
        from app.v2.pursuit.planner import _known_families
        domain = candidate["domain"]
        out = {"facts": [], "bonus": 0.0}
        why = explain.explain(domain)
        if why:
            out["explain"] = why
            if why["hops"] >= 2:
                out["bonus"] += 0.02
        fams = {v for k, v in ledger.artifacts_of([domain]).get(domain, []) if k in ("dom", "flow")}
        if fams and not (fams & _known_families()):
            out["new_family"] = True
            out["facts"].append("Its page structure matches no site family you have reviewed: possibly a new kind of scam site.")
            out["bonus"] += 0.03
        life = ledger.life(domain) or {}
        if life.get("returned_from"):
            out["returned_from"] = life["returned_from"]
            out["facts"].append(f"Shares a distinctive artifact with {life['returned_from']}, which has gone dark: "
                                "possibly the same deployment back on a new name. A similarity, not proof of the same operator.")
            out["bonus"] += 0.03
        p = float(candidate.get("p") or 0)
        value = 1.0 + (0.5 if out.get("new_family") else 0) + (0.3 if out.get("returned_from") else 0) + \
            (0.2 if why and why.get("hops", 0) >= 2 else 0)
        out["expected_value"] = round(p * value, 3)
        out["bonus"] = round(min(0.05, out["bonus"]), 3)
        return out
    except Exception:                                  # noqa: BLE001
        logger.debug("pursuit annotate failed", exc_info=True)
        return {}


def hunts_view(limit: int = 30) -> list:
    """Hunts in plain words for Main's Hunts view."""
    if not enabled():
        return []
    try:
        from app.v2.pursuit import ledger
        ledger.ensure()
        rows = ledger.hunts(("active", "parked", "exhausted"), limit=400)
        counts = ledger.branch_counts([h["id"] for h in rows])
        out = []
        for h in rows:
            c = counts.get(h["id"], {})
            out.append({"id": h["id"], "kind": h["kind"], "title": h["title"], "state": h["state"],
                        "operation": h.get("operation"), "found": int(h["eligible"]), "useful": int(h["useful"]),
                        "leads": int(h["leads"]), "searches": int(h["actions"]), "open_pivots": c.get("open", 0) + c.get("cooling", 0),
                        "followed_pivots": sum(v for k, v in c.items() if k not in ("open", "cooling")),
                        "stop_reason": h.get("stop_reason") or "", "since_round": h["created_round"],
                        "last_progress_round": h["last_progress_round"], "value": round(float(h["value"]), 2)})
        order = {"active": 0, "parked": 1, "exhausted": 2}
        out.sort(key=lambda x: (order.get(x["state"], 3), -x["found"], -x["last_progress_round"]))
        return out[:limit]
    except Exception:                                  # noqa: BLE001
        logger.debug("hunts_view failed", exc_info=True)
        return []


def status() -> dict:
    from app.v2 import store
    from app.v2.pursuit import ledger
    ledger.ensure()
    return {"enabled": enabled(), "last_plan": store.get_state("pu_last_plan", {}), "hunts": hunts_view(50),
            "routes": [{"route": k[0], "tier": k[1], **{x: round(float(v[x]), 2) for x in ("attempts", "productive", "useful", "junk", "value")}}
                       for k, v in ledger.route_ledger().items()]}
