"""
Site Finder v4: contextual discovery-strategy intelligence.

v3 learned which discovery strategies work *globally*. v4 learns which pivot
arms work *in a context* — the kind of indicator being pivoted on, whether the
campaign is "hot" (converging relationships or recurring wallets), whether the
pattern is large — and, within that, for a specific campaign.

    pivot request  {kind: ip|ns|san|favicon|favtmpl|service|wallet|kit, value, context, campaign_id}
      -> arms      known_keys (no network), hosting_neighbors (passive DNS, optional),
                   cert_siblings (CT), pattern_siblings (DNS), ct_learned (CT)
      -> shares    contextual posterior per arm, shrunk campaign -> context -> global
      -> effort    reduced automatically when the path is saturated
      -> result    new unique candidates, which of them share the indicator

Design rules
  * Reward is useful unique candidates per unit of effort, not raw volume:
      value(arm) = Beta(1 + useful + 0.25*new_unique, 2 + skipped + 0.05*cost)
    so an arm that returns many candidates nobody finds useful loses budget.
  * Hierarchical shrinkage (K pseudo-observations at each level) keeps a new
    context from trusting a handful of results; it inherits the arm's global value.
  * Bounded but active exploration: every available arm keeps at least
    max(FLOOR, EXPLORE/n) of the budget and none exceeds CEIL; Thompson sampling
    adds diversity from round to round.
  * Diminishing returns: a pivot path (campaign + indicator) and a pivot type in
    a campaign each track a zero-yield streak. Every unproductive attempt halves
    the path's effort (probe budget and delivery cap); after SATURATE_AFTER
    unproductive attempts the path is saturated and a further request returns
    immediately without touching the network. A productive attempt restores it.
  * Only observed (Finder's own delivery counts) and human/observed downstream
    outcomes are credited. Nothing the platform's AI concludes is a label.
"""
from __future__ import annotations

import logging
import random
import time

from app.v2 import adaptive, netio, store
from app.v2 import strategies as st

logger = logging.getLogger("scamhunter.v4.context")

ARMS = ["known_keys", "hosting_neighbors", "cert_siblings", "pattern_siblings", "ct_learned"]
GENERIC_NEIGHBORS = 40          # more co-hosted names than this = shared/CDN hosting, not a relationship
PIVOT_KINDS = {"ip", "ns", "san", "favicon", "favtmpl", "service", "wallet", "kit"}
K_SHRINK = 4.0
SATURATE_AFTER = 3
MIN_EFFORT = 0.125
BASE_FETCH = 60
FLOOR, EXPLORE, CEIL = adaptive.FLOOR, adaptive.EXPLORE, adaptive.CEIL
# Weak structural priors (pseudo-counts), not rules: a certificate-name pivot is
# a natural fit for CT siblings, a template/kit pivot for naming patterns, and a
# hosting/wallet pivot for sites Finder has already seen with that key.
KIND_PRIOR = {
    "san": {"cert_siblings": 1.0}, "kit": {"pattern_siblings": 1.0}, "favtmpl": {"pattern_siblings": 0.5, "known_keys": 0.5},
    "favicon": {"known_keys": 0.5}, "ip": {"known_keys": 0.5, "hosting_neighbors": 1.0}, "ns": {"known_keys": 0.5, "hosting_neighbors": 1.0},
    "wallet": {"known_keys": 1.0},
    "service": {"known_keys": 0.5},
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS v4_context_stats (
    level TEXT NOT NULL, context TEXT NOT NULL, arm TEXT NOT NULL,
    attempts REAL DEFAULT 0, new_unique REAL DEFAULT 0, useful REAL DEFAULT 0, skipped REAL DEFAULT 0, cost REAL DEFAULT 0,
    updated_at REAL, PRIMARY KEY(level, context, arm)
);
CREATE TABLE IF NOT EXISTS v4_paths (
    path TEXT PRIMARY KEY, attempts INTEGER DEFAULT 0, zero_streak INTEGER DEFAULT 0, total_new INTEGER DEFAULT 0,
    effort REAL DEFAULT 1.0, updated_at REAL
);
CREATE TABLE IF NOT EXISTS v4_pivot_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, campaign TEXT, context TEXT, kind TEXT, value TEXT,
    shares TEXT, effort REAL, new_unique INTEGER, shared INTEGER, saturated INTEGER, skipped INTEGER
);
"""
_ready: set = set()


def ensure():
    store.ensure()
    key = str(store.db.DB_PATH)
    if key in _ready:
        return
    with store.conn() as c:
        c.executescript(SCHEMA)
    _ready.add(key)


def context_key(kind: str, raw: str | None) -> str:
    """Normalised context: the platform's context string, always carrying the pivot type."""
    parts = dict(p.split("=", 1) for p in (raw or "").split("|") if "=" in p)
    parts["type"] = kind
    return "|".join(f"{k}={parts[k]}" for k in sorted(parts))[:200]


def _levels(context: str, campaign: str | None):
    yield "global", "*"
    yield "context", context
    if campaign:
        yield "campaign", f"{campaign}|{context}"


def _stats(level: str, context: str) -> dict:
    ensure()
    with store.conn() as c:
        rows = c.execute("SELECT * FROM v4_context_stats WHERE level=? AND context=?", (level, context)).fetchall()
    return {r["arm"]: dict(r) for r in rows}


def _bump(level: str, context: str, arm: str, **d):
    ensure()
    with store.conn() as c:
        c.execute("INSERT OR IGNORE INTO v4_context_stats(level,context,arm,updated_at) VALUES(?,?,?,?)", (level, context, arm, time.time()))
        sets = ", ".join(f"{k}={k}+?" for k in d)
        c.execute(f"UPDATE v4_context_stats SET {sets}, updated_at=? WHERE level=? AND context=? AND arm=?",
                  (*d.values(), time.time(), level, context, arm))


def credit(context: str, campaign: str | None, arm: str, **d):
    for level, key in _levels(context, campaign):
        _bump(level, key, arm, **d)


def _ab(s: dict) -> tuple:
    return (s.get("useful", 0) + 0.25 * s.get("new_unique", 0), s.get("skipped", 0) + 0.05 * s.get("cost", 0))


def arm_values(context: str, campaign: str | None, arms: list, rng: random.Random | None = None, sample: bool = True) -> dict:
    """Posterior value per arm with campaign -> context -> global shrinkage."""
    rng = rng or random.Random()
    kind = dict(p.split("=", 1) for p in context.split("|") if "=" in p).get("type", "")
    g, cx = _stats("global", "*"), _stats("context", context)
    cp = _stats("campaign", f"{campaign}|{context}") if campaign else {}
    out = {}
    for arm in arms:
        # global posterior mean (with the structural prior as pseudo-successes)
        ga, gb = _ab(g.get(arm, {}))
        prior = KIND_PRIOR.get(kind, {}).get(arm, 0.0)
        m_global = (1 + prior + ga) / (3 + prior + ga + gb)
        a, b = _ab(cx.get(arm, {}))
        m_ctx = (a + K_SHRINK * m_global) / (a + b + K_SHRINK)
        a2, b2 = _ab(cp.get(arm, {}))
        m = (a2 + K_SHRINK * m_ctx) / (a2 + b2 + K_SHRINK)
        n = a + b + a2 + b2 + K_SHRINK
        out[arm] = rng.betavariate(max(1e-3, m * n), max(1e-3, (1 - m) * n)) if sample else m
    return out


def shape(values: dict) -> dict:
    """Floor / ceiling shaping identical in spirit to adaptive.allocation."""
    if not values:
        return {}
    n = len(values)
    base = max(FLOOR, EXPLORE / n)
    if n * base >= 1:
        return {k: round(1 / n, 4) for k in values}
    total = sum(values.values()) or 1.0
    spare = 1 - n * base
    shares = {k: base + spare * v / total for k, v in values.items()}
    for _ in range(n):
        over = {k: v for k, v in shares.items() if v > CEIL}
        if not over:
            break
        excess = sum(v - CEIL for v in over.values())
        for k in over:
            shares[k] = CEIL
        receivers = [k for k in shares if k not in over]
        if not receivers:
            break
        for k in receivers:
            shares[k] += excess / len(receivers)
    return {k: round(v, 4) for k, v in shares.items()}


def allocate(context: str, campaign: str | None, arms: list, rng: random.Random | None = None) -> dict:
    return shape(arm_values(context, campaign, arms, rng))


# ------------------------------------------------------------ saturation

def path_state(path: str) -> dict:
    ensure()
    with store.conn() as c:
        row = c.execute("SELECT * FROM v4_paths WHERE path=?", (path,)).fetchone()
    return dict(row) if row else {"path": path, "attempts": 0, "zero_streak": 0, "total_new": 0, "effort": 1.0}


def note_path(path: str, productive: int) -> dict:
    s = path_state(path)
    zero = 0 if productive else s["zero_streak"] + 1
    effort = 1.0 if productive else max(MIN_EFFORT, float(s["effort"]) / 2)
    with store.conn() as c:
        c.execute("INSERT INTO v4_paths(path,attempts,zero_streak,total_new,effort,updated_at) VALUES(?,?,?,?,?,?) "
                  "ON CONFLICT(path) DO UPDATE SET attempts=excluded.attempts, zero_streak=excluded.zero_streak, "
                  "total_new=excluded.total_new, effort=excluded.effort, updated_at=excluded.updated_at",
                  (path, s["attempts"] + 1, zero, s["total_new"] + productive, effort, time.time()))
    return {"effort": effort, "zero_streak": zero, "saturated": zero >= SATURATE_AFTER}


def saturated(path: str) -> bool:
    return path_state(path)["zero_streak"] >= SATURATE_AFTER


# ------------------------------------------------------------------ pivot

def _related(kind: str, value: str) -> list:
    if kind == "kit":
        return [m["domain"] for m in store.cluster_members(value)]
    return store.domains_with_key(kind, value)


def _shares_indicator(domain: str, kind: str, value: str) -> bool:
    if kind == "kit":
        cand = store.get(domain) or {}
        return cand.get("cluster_id") == value
    return (kind, value) in set(store.keys_for(domain))


def run_pivot(payload: dict, rng: random.Random | None = None) -> dict:
    """Runs one bounded, contextual pivot round for a FIND_RELATED_SITES job carrying `pivot`."""
    from app.v2.engine import run_round
    ensure()
    pivot = payload.get("pivot") or {}
    kind, value = str(pivot.get("kind") or ""), str(pivot.get("value") or "")
    if kind not in PIVOT_KINDS or not value:
        return {"error": "unsupported pivot", "new_candidates": [], "shared": [], "saturated": False}
    campaign = str(payload.get("campaign_id") or "") or None
    context = context_key(kind, payload.get("context"))
    path = f"{campaign or '-'}|{kind}:{value}"
    type_path = f"{campaign or '-'}|type:{kind}"
    rng = rng or random.Random(f"{path}:{path_state(path)['attempts']}")
    log = {"campaign": campaign, "context": context, "kind": kind, "value": value[:200]}
    if saturated(path):
        _log(**log, shares={}, effort=path_state(path)["effort"], new_unique=0, shared=0, saturated=1, skipped=1)
        return {"pivot": {"kind": kind, "value": value}, "context": context, "new_candidates": [], "shared": [],
                "saturated": True, "skipped": True, "effort": path_state(path)["effort"],
                "reason": f"path saturated after {SATURATE_AFTER} unproductive attempts"}
    effort = min(float(path_state(path)["effort"]), float(path_state(type_path)["effort"]) * 2, 1.0)

    related = _related(kind, value)
    exclude = set(str(d).lower() for d in (payload.get("exclude") or []))
    # Arm availability: known_keys needs local matches not yet delivered; the seeded arms need seeds.
    local = [d for d in related if d not in exclude and (store.get(d) or {}).get("status") in ("new", "held", "gated")]
    pdns_ok = kind in ("ip", "ns") and bool(netio.PASSIVE_DNS_URL)
    arms = [a for a in ARMS if (a != "known_keys" or local) and (a != "hosting_neighbors" or pdns_ok)]
    if not related:
        arms = [a for a in arms if a in ("known_keys", "hosting_neighbors")]
    shares = allocate(context, campaign, arms, rng) if arms else {}
    extra = [st.Lead(d, "known_keys", f"shares {kind} {value[:40]}", 0.5, "known_keys") for d in local] if "known_keys" in shares else []
    generic = False
    if "hosting_neighbors" in shares:
        names = netio.passive_dns(kind, value) or []
        regs = sorted({st.dm.registrable(n) for n in names if st.dm.registrable(n)} - exclude - set(related))
        if len(regs) > GENERIC_NEIGHBORS:
            generic = True                           # shared hosting: co-location says nothing
        else:
            cap = max(1, round(len(regs) * shares["hosting_neighbors"] * 2 * effort)) if regs else 0
            extra += [st.Lead(r, "hosting_neighbors", f"passive DNS: also on {kind} {value[:40]}", 0.45, "hosting_neighbors") for r in regs[:cap]]
    requested = max(1, round(int(payload.get("requested") or 10) * effort))
    summary = run_round(fetch_budget=max(5, round(BASE_FETCH * effort)), requested=requested,
                        seed_domains=related[:20], only_strategies=set(shares), shares_override=shares,
                        extra_leads=extra, seeds_only=True,
                        deliver_context={"context": context, "pivot": f"{kind}:{value[:120]}", "campaign_id": campaign},
                        request_limits=payload.get("budget") or None)
    delivered = [d["domain"] for d in summary["delivered"] if d["domain"] not in exclude]
    shared = [d for d in delivered if _shares_indicator(d, kind, value)]

    # Credit the arms that produced deliveries (observed), and the cost each spent.
    per = summary.get("strategies") or {}
    for arm in shares:
        cost = float((per.get(arm) or {}).get("probed", 0))
        credit(context, campaign, arm, attempts=1, cost=cost)
    for d in delivered:
        cand = store.get(d) or {}
        used = [s for s in (cand.get("strategies") or []) if s in shares]
        for arm in used:                              # deliveries no arm produced are not credited
            credit(context, campaign, arm, new_unique=1.0 / len(used))
    state = note_path(path, len(shared))
    type_state = note_path(type_path, len(shared))
    _log(**log, shares=shares, effort=effort, new_unique=len(delivered), shared=len(shared),
         saturated=int(state["saturated"]), skipped=0)
    return {"pivot": {"kind": kind, "value": value}, "context": context, "arms": shares, "effort": round(effort, 3),
            "round": summary["round"], "probed": summary["probed"], "new_candidates": delivered, "shared": shared,
            "saturated": state["saturated"], "type_effort": type_state["effort"], "next_effort": state["effort"],
            "generic_hosting": generic}


def _log(**row):
    import json
    ensure()
    with store.conn() as c:
        c.execute("INSERT INTO v4_pivot_log(at,campaign,context,kind,value,shares,effort,new_unique,shared,saturated,skipped) "
                  "VALUES(?,?,?,?,?,?,?,?,?,?,?)", (time.time(), row["campaign"], row["context"], row["kind"], row["value"],
                                                    json.dumps(row["shares"]), row["effort"], row["new_unique"], row["shared"],
                                                    row["saturated"], row["skipped"]))


# ------------------------------------------------------ downstream credit

def credit_candidate(candidate: dict, useful_weight: float):
    """
    Downstream outcome for a candidate that a contextual pivot delivered: a
    person's Useful/Skip or an observed module result. Positive weight credits
    `useful`, negative credits `skipped`, to the arm(s) and context that found it.
    """
    details = (candidate or {}).get("details") or {}
    context = details.get("context")
    if not context or not useful_weight:
        return False
    campaign = details.get("campaign_id") or None
    arms = [s for s in (candidate.get("strategies") or []) if s in ARMS] or ["known_keys"]
    share = 1.0 / len(arms)
    for arm in arms:
        if useful_weight > 0:
            credit(context, campaign, arm, useful=share * useful_weight)
        else:
            credit(context, campaign, arm, skipped=share * -useful_weight)
    return True


def report() -> dict:
    ensure()
    with store.conn() as c:
        ctx = [dict(r) for r in c.execute("SELECT * FROM v4_context_stats ORDER BY level, context, arm").fetchall()]
        paths = [dict(r) for r in c.execute("SELECT * FROM v4_paths ORDER BY updated_at DESC LIMIT 50").fetchall()]
        log = [dict(r) for r in c.execute("SELECT * FROM v4_pivot_log ORDER BY id DESC LIMIT 50").fetchall()]
    return {"context_stats": ctx, "paths": paths, "pivots": log}
