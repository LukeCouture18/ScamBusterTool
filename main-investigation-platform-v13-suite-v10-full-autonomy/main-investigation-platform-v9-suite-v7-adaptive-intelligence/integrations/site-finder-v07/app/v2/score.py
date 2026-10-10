"""
One calibrated number: the probability this candidate is worth your time.

    z = bias
      + sum over evidence groups of weight × (strongest signal + 25% of the rest)
      + learned signal adjustments   (from your USEFUL/SKIP decisions)
      + strategy prior               (how often this discovery route pays off)
      + cluster prior                (what you decided about its siblings)
    p = sigmoid(z)

Groups rather than signals so that ten phrasings of one fact count once.
Priors are bounded, and asymmetrically: learning may push a candidate down a
long way but up only a little, so a page's own evidence has to carry it over
the bar. Delivery still requires a core signal, and a gate still wins over
any score.
"""
from __future__ import annotations

import math

from app.v2.signals import GROUPS, core_groups

BIAS = -3.1
DELIVER_THRESHOLD = 0.62
LEARNED_UP, LEARNED_DOWN = 0.4, 1.0     # asymmetric on purpose: learning demotes freely, promotes little
STRATEGY_UP, STRATEGY_DOWN = 0.3, 0.7
CLUSTER_GATE_UP = 0.6

CATEGORY_LABELS = [
    ("seed_phrase", "Wallet phishing"),
    ("impersonation", "Brand impersonation"),
    ("recovery", "Fund-recovery scam"),
    ("app_kit", "Trading-app scam"),
    ("withdrawal_trap", "Fake exchange / withdrawal trap"),
    ("promise", "Investment scheme"),
    ("wallet", "Crypto deposit site"),
]


def sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))


def group_contributions(signals: list) -> dict:
    by_group: dict[str, list] = {}
    for s in signals:
        by_group.setdefault(s.group, []).append(s.strength)
    out = {}
    for group, strengths in by_group.items():
        weight = GROUPS.get(group, (0.5, False))[0]
        strengths.sort(reverse=True)
        value = strengths[0] + 0.25 * sum(strengths[1:3])
        out[group] = round(weight * min(1.25, value), 3)
    return out


def score(signals: list, learned: dict | None = None, strategy_prior: float = 0.0,
          cluster_prior: float = 0.0) -> dict:
    learned = learned or {}
    contributions = group_contributions(signals)
    learned_adj = 0.0
    for s in signals:
        learned_adj += learned.get(s.name, 0.0) * min(1.0, s.strength + 0.2)
    learned_adj = max(-LEARNED_DOWN, min(LEARNED_UP, learned_adj))
    strategy_prior = max(-STRATEGY_DOWN, min(STRATEGY_UP, strategy_prior))
    evidence = BIAS + sum(contributions.values())
    z = evidence + learned_adj + strategy_prior + cluster_prior
    p = sigmoid(z)
    # The delivery decision uses the page's own evidence plus any demotion.
    # Upward learning only re-orders what already qualifies — except a strong
    # link to a kit you confirmed, which is itself evidence (bounded).
    z_gate = evidence + min(0.0, learned_adj) + min(0.0, strategy_prior) + min(CLUSTER_GATE_UP, cluster_prior)
    cores = core_groups(signals)
    return {"p": round(p, 4), "p_gate": round(sigmoid(z_gate), 4), "z": round(z, 3), "core": sorted(cores),
            "contributions": contributions, "learned": round(learned_adj, 3),
            "strategy_prior": round(strategy_prior, 3), "cluster_prior": round(cluster_prior, 3)}


def category(signals: list) -> str:
    groups = {s.group for s in signals if s.strength >= 0.5}
    for group, label in CATEGORY_LABELS:
        if group in groups:
            return label
    return "Suspicious crypto site"


def headline(signals: list, extras: list | None = None, max_reasons: int = 2) -> str:
    """'Investment scheme · promises 3.5% daily · deposit address shown (TRON)'."""
    ranked = sorted((s for s in signals if GROUPS.get(s.group, (0,))[0] > 0),
                    key=lambda s: -(GROUPS.get(s.group, (0,))[0] * s.strength))
    phrases, seen_groups = [], set()
    for s in ranked:
        if s.group in seen_groups:
            continue
        seen_groups.add(s.group)
        phrases.append(s.phrase)
        if len(phrases) >= max_reasons:
            break
    parts = [category(signals)] + phrases + list(extras or [])
    return " · ".join(parts)
