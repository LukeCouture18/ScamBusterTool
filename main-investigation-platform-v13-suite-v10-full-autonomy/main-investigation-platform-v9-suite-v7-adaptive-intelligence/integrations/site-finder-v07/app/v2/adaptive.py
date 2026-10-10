"""
Learning from your decisions.

Every USEFUL or SKIP you give a candidate is credited to:

  * the discovery strategies (and CT search terms) that found it,
  * the evidence signals it carried,
  * its operator cluster.

and those ledgers steer the next round:

  STRATEGY BUDGET   Each strategy's value per probe is estimated as
                    P(delivered | probed) × P(useful | delivered), both as Beta
                    posteriors with honest starting beliefs, and Thompson-sampled
                    so a strategy with little data still gets tried. A floor keeps
                    every strategy alive; a noisy one shrinks toward it instead of
                    disappearing, so it can recover if it starts paying off.

  SIGNAL WEIGHTS    A signal that keeps appearing on sites you skip loses weight;
                    one that keeps appearing on sites you keep gains it. Shrunk
                    toward zero until there are enough decisions, and capped, so a
                    handful of clicks can't rewrite the model.

  CLUSTER PRIORS    A sibling of something you marked USEFUL starts higher; a
                    sibling of something you skipped is suppressed.

This is the same idea v0.6/v0.7 had for technique learning, now fed by the
person's own verdicts instead of only by what downstream modules found.
"""
from __future__ import annotations

import math
import random

from app.v2 import store

# Starting beliefs (pseudo-counts) per strategy: (delivered_rate a, b), (useful_rate a, b).
PRIORS = {
    "ct_terms":         ((1, 12), (2, 3)),
    "ct_learned":       ((2, 6), (3, 2)),
    "ct_frontier":      ((1, 9), (2, 3)),
    "cert_siblings":    ((2, 5), (3, 2)),
    "pattern_siblings": ((2, 5), (3, 2)),
    "brand_typos":      ((1, 10), (2, 3)),
    "feeds":            ((1, 6), (2, 2)),
    "mentions":         ((1, 5), (2, 2)),
    "recheck":          ((1, 10), (2, 2)),
    # pivots from sites already judged worth a look: more often eligible, and their
    # leads are more often new operations (next gen); earlier pivot routes had no prior
    # at all and were floored to 5% of the probe budget
    "ng_pivot":         ((3, 5), (3, 2)),
    "pu_anchor":        ((1, 6), (1, 4)),
    "ng_gap":           ((3, 3), (2, 2)),
    "investigation_pivot": ((2, 6), (3, 2)),
}
FLOOR = 0.05
# Bounded experimentation, so learning never collapses onto one strategy:
#   * EXPLORE of the budget is always spread evenly across every eligible
#     strategy, so a strategy that stopped paying off keeps getting retried and
#     can recover if the world changes.
#   * no strategy may take more than CEIL of the budget, so a run of luck can't
#     starve the others.
EXPLORE = 0.15
CEIL = 0.60
# Precision first: what you taught it may demote a candidate a lot, but may only
# nudge one upward. A page's own evidence has to carry it over the bar.
STRATEGY_UP, STRATEGY_DOWN = 0.3, 0.7
SIGNAL_MIN_N = 4
SIGNAL_ALPHA = 0.05
SIGNAL_CAP = 0.8


def _beta_sample(rng, a, b):
    return rng.betavariate(max(a, 0.01), max(b, 0.01))


def strategy_values(rng: random.Random | None = None, sample: bool = True) -> dict:
    """Value per probe for each strategy (sampled unless sample=False)."""
    rng = rng or random.Random()
    stats = store.strategy_stats()
    values = {}
    for name, ((da, db), (ua, ub)) in PRIORS.items():
        s = stats.get(name, {})
        probed, delivered = s.get("probed", 0), s.get("delivered", 0)
        useful, skipped = s.get("useful", 0.0), s.get("skipped", 0.0)
        a1, b1 = da + delivered, db + max(0, probed - delivered)
        a2, b2 = ua + useful, ub + skipped
        if sample:
            values[name] = _beta_sample(rng, a1, b1) * _beta_sample(rng, a2, b2)
        else:
            values[name] = (a1 / (a1 + b1)) * (a2 / (a2 + b2))
    return values


def allocation(available: list, rng: random.Random | None = None) -> dict:
    """Shares of the probe budget for the strategies that produced leads this round."""
    if not available:
        return {}
    values = strategy_values(rng)
    raw = {k: values.get(k, 0.05) for k in available}
    total = sum(raw.values()) or 1.0
    n = len(raw)
    base = max(FLOOR, EXPLORE / n)            # per-strategy exploration floor
    if n * base >= 1:
        return {k: round(1 / n, 4) for k in raw}
    # Each strategy keeps `base`; the rest is shared by value, then no strategy
    # is allowed above CEIL (excess is redistributed evenly). Flooring-then-
    # renormalising is avoided because it pushed a floored strategy back under.
    spare = 1 - n * base
    shares = {k: base + spare * v / total for k, v in raw.items()}
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


def arm_weights(prefix: str, arms: list, rng: random.Random | None = None, last_used: dict | None = None,
                round_no: int = 0) -> dict:
    """
    Thompson-sampled weights for sub-arms such as CT search terms, discounted
    for staleness: a term queried in the last round or two mostly returns
    domains already seen, so its fresh value is lower than its history says.
    """
    rng = rng or random.Random()
    stats = store.strategy_stats()
    last_used = last_used or {}
    out = {}
    for arm in arms:
        s = stats.get(f"{prefix}:{arm}", {})
        a = 1 + s.get("useful", 0) + 0.3 * s.get("delivered", 0)
        b = 2 + s.get("skipped", 0) + 0.02 * s.get("probed", 0)
        gap = round_no - last_used.get(arm, -99)
        freshness = min(1.0, max(0.15, gap / 3.0))
        out[arm] = _beta_sample(rng, a, b) * freshness
    return out


QUERY_PRIOR = {"ct_terms": (3.0, 4.0), "ct_learned": (1.0, 3.0), "cert_siblings": (1.0, 3.0)}


def query_allocation(total: int, eligible: dict, rng: random.Random | None = None) -> dict:
    """
    Splits the round's crt.sh queries between CT strategies by sampled useful
    candidates per query (Gamma posterior on a Poisson rate). `eligible` maps a
    strategy to the most queries it can use this round (seed-driven strategies
    are limited by how many new seeds exist). Each eligible strategy keeps at
    least one query so a quiet one is still tried.
    """
    rng = rng or random.Random()
    stats = store.strategy_stats()
    alloc = {k: 0 for k in eligible}
    live = {k: cap for k, cap in eligible.items() if cap > 0}
    if not live or total <= 0:
        return alloc
    rates = {}
    for k in live:
        a, b = QUERY_PRIOR.get(k, (1.0, 3.0))
        s = stats.get(k, {})
        rates[k] = rng.gammavariate(a + s.get("useful", 0.0), 1.0 / (b + s.get("cost", 0)))
    for k in live:                                   # exploration floor
        if total > 0:
            alloc[k] += 1
            total -= 1
    while total > 0:
        open_ = [k for k in live if alloc[k] < live[k]]
        if not open_:
            break
        k = max(open_, key=lambda x: rates[x] / (alloc[x] + 1))
        alloc[k] += 1
        total -= 1
    return alloc


def strategy_prior(strategies: list) -> float:
    """
    A bounded log-odds nudge: how much better or worse the finding strategies
    have done *than discovery overall*. Relative to the overall rate, so being
    found by the route that finds most things is not itself a bonus.
    """
    if not strategies:
        return 0.0
    stats = store.strategy_stats()
    from app.v2 import intelligence
    for name, campaign_votes in intelligence.campaign_feedback().items():
        merged = {**stats.get(name, {})}
        for key in ("useful", "skipped"):
            merged[key] = merged.get(key, 0) + campaign_votes[key]
        stats[name] = merged
    total_u = sum(v.get("useful", 0.0) for k, v in stats.items() if ":" not in k)
    total_k = sum(v.get("skipped", 0.0) for k, v in stats.items() if ":" not in k)
    if total_u + total_k < 5:
        return 0.0
    p0 = min(0.98, max(0.02, (total_u + 1) / (total_u + total_k + 2)))
    best = None
    for name in strategies:
        s = stats.get(name) or stats.get(name.split(":")[0]) or {}
        u, k = s.get("useful", 0.0), s.get("skipped", 0.0)
        n = u + k
        if n < 3:
            continue
        ps = min(0.995, max(0.005, (u + 6 * p0) / (n + 6)))
        delta = math.log(ps / (1 - ps)) - math.log(p0 / (1 - p0))
        best = delta if best is None else max(best, delta)
    if best is None:
        return 0.0
    return max(-STRATEGY_DOWN, min(STRATEGY_UP, 0.5 * best))


def _binom_tail_ge(k: int, n: int, q: float) -> float:
    """P(X >= k) for X ~ Binomial(n, q)."""
    if k <= 0:
        return 1.0
    return sum(math.comb(n, i) * (q ** i) * ((1 - q) ** (n - i)) for i in range(k, n + 1))


def _binom_tail_le(k: int, n: int, q: float) -> float:
    return sum(math.comb(n, i) * (q ** i) * ((1 - q) ** (n - i)) for i in range(0, k + 1))


def learned_signal_weights() -> dict:
    """
    Per-signal log-odds adjustment from your decisions — but only when the
    difference is statistically clear. A signal whose candidates you skip (as
    "not a scam") significantly more often than candidates overall loses weight;
    one skipped significantly less often gains a little. One stray click, or a
    handful of decisions, changes nothing: a person's occasional mistake must
    not demote a whole class of real scams.
    """
    stats = store.signal_stats()
    total_u = sum(s["useful"] for s in stats.values())
    total_k = sum(s["skipped"] for s in stats.values())
    if total_u + total_k < 1:
        return {}
    q0 = min(0.98, max(0.02, (total_k + 1) / (total_u + total_k + 2)))       # overall skip rate
    out = {}
    for name, s in stats.items():
        n = int(round(s["useful"] + s["skipped"]))
        k = int(round(s["skipped"]))
        if n < SIGNAL_MIN_N:
            continue
        rate = (k + 0.5) / (n + 1)
        if k >= 2 and _binom_tail_ge(k, n, q0) < SIGNAL_ALPHA:
            out[name] = round(-min(SIGNAL_CAP, 0.6 * math.log(rate / q0)), 3)
        elif n >= 10 and _binom_tail_le(k, n, q0) < SIGNAL_ALPHA:
            out[name] = round(min(0.4, 0.3 * math.log(q0 / rate)), 3)
    return out


def cluster_prior(cluster_id: str | None) -> tuple:
    """(log-odds adjustment, verdict) from what you decided about this cluster."""
    if not cluster_id:
        return 0.0, ""
    c = store.get_cluster(cluster_id)
    if not c:
        return 0.0, ""
    if c["skipped"] and not c["useful"]:
        return -3.0, "skipped_cluster"
    if c["useful"]:
        return 1.2, "useful_cluster"
    return 0.0, ""


# What a SKIP means for each ledger, by the reason you gave. A duplicate is a
# real scam found twice: it costs you time (the strategy pays a little) but it is
# not evidence against the signals or the kit. "Dead or parked" means the site
# changed or a gate missed, not that the evidence was wrong. Only "not a scam"
# and "not crypto" count fully against signals and suppress the rest of a kit.
SKIP_WEIGHTS = {            # (strategy, signals, cluster)
    "not_a_scam": (1.0, 1.0, 1.0),
    "not_crypto": (1.0, 1.0, 1.0),
    "not_useful": (1.0, 0.5, 0.0),
    "dead_or_parked": (0.5, 0.0, 0.0),
    "duplicate": (0.25, 0.0, 0.0),
    "": (1.0, 0.5, 0.0),
}


def skip_weights(reason: str | None) -> tuple:
    return SKIP_WEIGHTS.get((reason or "").strip(), SKIP_WEIGHTS[""])


def credit(candidate: dict, useful: bool, reason: str | None = None):
    """Applies one decision to every ledger."""
    strategies = candidate.get("strategies") or []
    arms = set(candidate.get("details", {}).get("arms", []))
    w_strategy, w_signals, w_cluster = (1.0, 1.0, 1.0) if useful else skip_weights(reason)
    share = 1.0 / max(1, len(strategies))
    for s in strategies:
        store.bump_strategy(s, **({"useful": share} if useful else {"skipped": share * w_strategy}))
    for a in arms:
        store.bump_strategy(a, **({"useful": 1.0} if useful else {"skipped": w_strategy}))
    if w_signals:
        for sig in candidate.get("signals") or []:
            name = sig.get("name") if isinstance(sig, dict) else sig
            if name:
                store.bump_signal(name, useful, weight=w_signals)
    if useful or w_cluster:
        store.bump_cluster_outcome(candidate.get("cluster_id"), useful)
